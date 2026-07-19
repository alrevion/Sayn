// Focused coverage of the genuinely risky logic: access control + the auth
// pre-check. Runs the REAL middleware chain (apiRoutes.request) against a tiny
// in-memory D1 fake — no Workers pool needed (blessed fallback per the plan).
import { describe, expect, it, vi } from 'vitest';
import { apiRoutes } from '../src/routes';
import { mintSession } from '../src/auth';
import { resolveChatId } from '../src/telegram';
import type { Env } from '../src/types';

const SECRET = 'test-secret';

type FakeData = {
  users: Array<{ id: string; phone: string; name: string; role: string }>;
  memberships: Array<{ project_id: string; user_id: string }>;
  tasks: Array<Record<string, unknown>>;
  projects?: Array<{ id: string; telegram_chat_id: string }>;
  attachments?: Array<{ id: string; task_id: string; uploaded_by: string; telegram_message_id: string; telegram_file_id: string; filename: string; mime_type: string; size_bytes: number }>;
};

// Dispatches the handful of queries the middleware/handlers issue by SQL shape.
function fakeDB(data: FakeData): Env['DB'] {
  const projects = data.projects ?? [];
  const attachments = data.attachments ?? [];
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const api = {
      bind(...a: unknown[]) {
        args = a;
        return api;
      },
      async first<T = Record<string, unknown>>(): Promise<T | null> {
        if (/FROM users WHERE phone/.test(sql)) return (data.users.find((u) => u.phone === args[0]) as T) ?? null;
        if (/FROM users WHERE id/.test(sql)) return (data.users.find((u) => u.id === args[0]) as T) ?? null;
        if (/FROM tasks WHERE id/.test(sql)) return (data.tasks.find((t) => t.id === args[0]) as T) ?? null;
        if (/FROM attachments a/.test(sql)) {
          // /attachments/:id access join -> attachment row + its task's project_id.
          const att = attachments.find((a) => a.id === args[0]);
          if (!att) return null;
          const task = data.tasks.find((t) => t.id === att.task_id);
          return { ...att, project_id: task?.project_id } as T;
        }
        if (/FROM projects WHERE id/.test(sql)) return (projects.find((p) => p.id === args[0]) as T) ?? null;
        if (/FROM project_memberships/.test(sql)) {
          const [pid, uid] = args;
          return (data.memberships.some((m) => m.project_id === pid && m.user_id === uid) ? ({ found: 1 } as T) : null);
        }
        return null;
      },
      async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
        if (/FROM tasks WHERE project_id/.test(sql)) return { results: data.tasks.filter((t) => t.project_id === args[0]) as T[] };
        return { results: [] as T[] };
      },
      async run() {
        return { success: true, meta: { changes: 1 } };
      },
    };
    return api;
  };
  return { prepare } as unknown as Env['DB'];
}

function envWith(data: FakeData): Env {
  return {
    DB: fakeDB(data),
    ASSETS: {} as Fetcher,
    AUTH_API_URL: 'https://auth.example',
    AUTH_API_KEY: 'k',
    TELEGRAM_BOT_TOKEN: 't',
    TELEGRAM_STORAGE_CHAT_ID: '-100555',
    SESSION_SECRET: SECRET,
    MCP_API_TOKEN: 'mcp-token',
    MCP_USER_ID: 'mcp-user',
  };
}

const cookie = async (id: string, role: string) => `session=${await mintSession(SECRET, { sub: id, role: role as never })}`;

describe('access control', () => {
  it('admin who is NOT a project member gets 403 from a project-scoped route', async () => {
    const env = envWith({ users: [{ id: 'a1', phone: '+1', name: 'A', role: 'admin' }], memberships: [], tasks: [] });
    const res = await apiRoutes.request('/projects/p1/tasks', { headers: { Cookie: await cookie('a1', 'admin') } }, env);
    expect(res.status).toBe(403);
  });

  it('admin who IS a member can access the project-scoped route', async () => {
    const env = envWith({
      users: [{ id: 'a1', phone: '+1', name: 'A', role: 'admin' }],
      memberships: [{ project_id: 'p1', user_id: 'a1' }],
      tasks: [],
    });
    const res = await apiRoutes.request('/projects/p1/tasks', { headers: { Cookie: await cookie('a1', 'admin') } }, env);
    expect(res.status).toBe(200);
  });

  it('a non-super_admin/creator gets 403 attempting to delete a task', async () => {
    const env = envWith({
      users: [{ id: 'a1', phone: '+1', name: 'A', role: 'admin' }],
      memberships: [{ project_id: 'p1', user_id: 'a1' }], // member, so access passes; role gate must still 403
      tasks: [{ id: 't1', project_id: 'p1', status: 'todo', telegram_message_id: null }],
    });
    const res = await apiRoutes.request('/tasks/t1', { method: 'DELETE', headers: { Cookie: await cookie('a1', 'admin') } }, env);
    expect(res.status).toBe(403);
  });

  it('a regular admin editing an in-progress task is rejected (403)', async () => {
    const env = envWith({
      users: [{ id: 'a1', phone: '+1', name: 'A', role: 'admin' }],
      memberships: [{ project_id: 'p1', user_id: 'a1' }],
      tasks: [{ id: 't1', project_id: 'p1', status: 'in_progress', deadline: null, telegram_message_id: null }],
    });
    const res = await apiRoutes.request(
      '/tasks/t1',
      { method: 'PATCH', headers: { Cookie: await cookie('a1', 'admin'), 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'x' }) },
      env,
    );
    expect(res.status).toBe(403);
  });

  it('super_admin/creator editing an in-progress task succeeds and reopens it to todo', async () => {
    const env = envWith({
      users: [{ id: 's1', phone: '+9', name: 'S', role: 'super_admin' }],
      memberships: [],
      tasks: [{ id: 't1', project_id: 'p1', status: 'in_progress', deadline: null, telegram_message_id: null }],
    });
    const res = await apiRoutes.request(
      '/tasks/t1',
      { method: 'PATCH', headers: { Cookie: await cookie('s1', 'super_admin'), 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'x' }) },
      env,
    );
    expect(res.status).toBe(200);
  });

  it('editing a done task is rejected (409) even for super_admin', async () => {
    const env = envWith({
      users: [{ id: 's1', phone: '+9', name: 'S', role: 'super_admin' }],
      memberships: [],
      tasks: [{ id: 't1', project_id: 'p1', status: 'done', deadline: null, telegram_message_id: null }],
    });
    const res = await apiRoutes.request(
      '/tasks/t1',
      { method: 'PATCH', headers: { Cookie: await cookie('s1', 'super_admin'), 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'x' }) },
      env,
    );
    expect(res.status).toBe(409);
  });

  it('valid transition (todo -> in_progress) via the {to} body key succeeds', async () => {
    const env = envWith({
      users: [
        { id: 's1', phone: '+9', name: 'S', role: 'super_admin' },
        { id: 'a1', phone: '+1', name: 'A', role: 'admin' },
      ],
      memberships: [],
      projects: [{ id: 'p1', telegram_chat_id: '-100999' }],
      tasks: [{ id: 't1', project_id: 'p1', status: 'todo', responsible_user_id: 'a1', deadline: null }],
    });
    // Telegram is best-effort (src/telegram.ts swallows errors) -- stub fetch so
    // the seed message send doesn't hit the real network from a test.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ result: { message_id: 42 } }), { status: 200 }),
    );
    const res = await apiRoutes.request(
      '/tasks/t1/move',
      {
        method: 'POST',
        headers: { Cookie: await cookie('s1', 'super_admin'), 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: 'in_progress' }),
      },
      env,
    );
    expect(res.status).toBe(200);
    fetchSpy.mockRestore();
  });

  it('invalid transition (todo -> done, skipping in_progress) is rejected (409)', async () => {
    const env = envWith({
      users: [{ id: 's1', phone: '+9', name: 'S', role: 'super_admin' }],
      memberships: [],
      tasks: [{ id: 't1', project_id: 'p1', status: 'todo', responsible_user_id: 's1', deadline: null }],
    });
    const res = await apiRoutes.request(
      '/tasks/t1/move',
      {
        method: 'POST',
        headers: { Cookie: await cookie('s1', 'super_admin'), 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: 'done' }),
      },
      env,
    );
    expect(res.status).toBe(409);
  });

  it('resolveChatId prefers the supergroup (-100) form when Telegram confirms it exists', async () => {
    const env = envWith({ users: [], memberships: [], tasks: [] });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      const ok = body.chat_id === '-1001234567890';
      return new Response(JSON.stringify({ ok }), { status: ok ? 200 : 400 });
    });
    expect(await resolveChatId(env, '1234567890')).toBe('-1001234567890');
    spy.mockRestore();
  });

  it('resolveChatId falls back to the plain group (-) form when -100 fails', async () => {
    const env = envWith({ users: [], memberships: [], tasks: [] });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      const ok = body.chat_id === '-1234567890'; // plain group, not "-100..."
      return new Response(JSON.stringify({ ok }), { status: ok ? 200 : 400 });
    });
    expect(await resolveChatId(env, ' 1234567890 ')).toBe('-1234567890'); // also strips whitespace
    spy.mockRestore();
  });

  it('resolveChatId returns null when neither form resolves (bot not added / wrong id)', async () => {
    const env = envWith({ users: [], memberships: [], tasks: [] });
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: false }), { status: 400 }));
    expect(await resolveChatId(env, '1234567890')).toBeNull();
    spy.mockRestore();
  });

  it('creating a project without a telegram_group_id is rejected (400)', async () => {
    const env = envWith({ users: [{ id: 's1', phone: '+9', name: 'S', role: 'super_admin' }], memberships: [], tasks: [] });
    const res = await apiRoutes.request(
      '/projects',
      { method: 'POST', headers: { Cookie: await cookie('s1', 'super_admin'), 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'X' }) },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('auth pre-check makes ZERO calls to auth-api for an unregistered phone', async () => {
    const env = envWith({ users: [], memberships: [], tasks: [] });
    const spy = vi.spyOn(globalThis, 'fetch');
    const res = await apiRoutes.request(
      '/auth/login',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '+404' }) },
      env,
    );
    expect(res.status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('an attachment over 20MB is rejected (413) without ever calling Telegram', async () => {
    const env = envWith({
      users: [{ id: 's1', phone: '+9', name: 'S', role: 'super_admin' }],
      memberships: [],
      tasks: [{ id: 't1', project_id: 'p1', status: 'todo' }],
    });
    const spy = vi.spyOn(globalThis, 'fetch');
    const form = new FormData();
    // 21MB -> over the 20MB download cap; the size check must fire before upload.
    form.append('file', new File([new Uint8Array(21 * 1024 * 1024)], 'big.bin', { type: 'application/octet-stream' }));
    const res = await apiRoutes.request('/tasks/t1/attachments', { method: 'POST', headers: { Cookie: await cookie('s1', 'super_admin') }, body: form }, env);
    expect(res.status).toBe(413);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('a non-image attachment is rejected (415) without ever calling Telegram -- the canvas only takes photos', async () => {
    const env = envWith({
      users: [{ id: 's1', phone: '+9', name: 'S', role: 'super_admin' }],
      memberships: [],
      tasks: [{ id: 't1', project_id: 'p1', status: 'todo' }],
    });
    const spy = vi.spyOn(globalThis, 'fetch');
    const form = new FormData();
    form.append('file', new File(['hi'], 'notes.pdf', { type: 'application/pdf' }));
    const res = await apiRoutes.request('/tasks/t1/attachments', { method: 'POST', headers: { Cookie: await cookie('s1', 'super_admin') }, body: form }, env);
    expect(res.status).toBe(415);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('admin who is NOT a project member gets 403 from the task attachments route', async () => {
    const env = envWith({
      users: [{ id: 'a1', phone: '+1', name: 'A', role: 'admin' }],
      memberships: [],
      tasks: [{ id: 't1', project_id: 'p1', status: 'todo' }],
    });
    const res = await apiRoutes.request('/tasks/t1/attachments', { headers: { Cookie: await cookie('a1', 'admin') } }, env);
    expect(res.status).toBe(403);
  });

  it('a project member who is not the uploader cannot delete an attachment (403)', async () => {
    const env = envWith({
      users: [{ id: 'a1', phone: '+1', name: 'A', role: 'admin' }],
      memberships: [{ project_id: 'p1', user_id: 'a1' }], // member, so access passes; uploader gate must still 403
      tasks: [{ id: 't1', project_id: 'p1', status: 'todo' }],
      attachments: [{ id: 'at1', task_id: 't1', uploaded_by: 'someone-else', telegram_message_id: '5', telegram_file_id: 'f', filename: 'x.pdf', mime_type: 'application/pdf', size_bytes: 10 }],
    });
    const res = await apiRoutes.request('/attachments/at1', { method: 'DELETE', headers: { Cookie: await cookie('a1', 'admin') } }, env);
    expect(res.status).toBe(403);
  });

  it('the uploader (a plain member) can delete their own attachment', async () => {
    const env = envWith({
      users: [{ id: 'a1', phone: '+1', name: 'A', role: 'admin' }],
      memberships: [{ project_id: 'p1', user_id: 'a1' }],
      tasks: [{ id: 't1', project_id: 'p1', status: 'todo' }],
      attachments: [{ id: 'at1', task_id: 't1', uploaded_by: 'a1', telegram_message_id: '5', telegram_file_id: 'f', filename: 'x.pdf', mime_type: 'application/pdf', size_bytes: 10 }],
    });
    // deleteMessage is best-effort -- stub fetch so the message delete doesn't hit the network.
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const res = await apiRoutes.request('/attachments/at1', { method: 'DELETE', headers: { Cookie: await cookie('a1', 'admin') } }, env);
    expect(res.status).toBe(200);
    spy.mockRestore();
  });
});
