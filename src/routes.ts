// All /api routes. Access control is delegated to middleware.ts; handlers only
// hold business rules. Every mutating action writes an events row (system of record).
import { type Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Role, TaskStatus } from './types';
import { logEvent, nowIso, uuid } from './db';
import { mintSession, precheckPhone, sendOtp, SESSION_COOKIE, verifyOtp, verifySession } from './auth';
import { type AppEnv, requireAuth, requireProjectAccess, requireRole } from './middleware';
import { deleteMessage, getFileUrl, resolveChatId, sendDocument, sendMessage } from './telegram';

// Telegram's Bot API can only download files up to 20MB back out (uploads may be
// larger, but would then be permanently unretrievable). Enforce the download cap
// at upload time so users get a clear error instead of losing an unfetchable file.
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export const apiRoutes = new Hono<AppEnv>();

async function projectChatId(db: D1Database, projectId: string): Promise<string> {
  const row = await db.prepare('SELECT telegram_chat_id FROM projects WHERE id = ?').bind(projectId).first<{ telegram_chat_id: string }>();
  return row?.telegram_chat_id ?? '';
}

// Shared by both archive views: attach each task's event trail with actor
// names resolved (null actor = system, e.g. auto-archive). N+1 is fine here --
// an internal tool's archive is never more than a handful of tasks at a time.
async function withEventTrail(db: D1Database, tasks: Record<string, unknown>[]) {
  const out = [];
  for (const task of tasks) {
    const { results: events } = await db
      .prepare(
        `SELECT e.*, u.name AS actor_name FROM events e
         LEFT JOIN users u ON u.id = e.actor_id
         WHERE e.target_type = 'task' AND e.target_id = ?
         ORDER BY e.created_at ASC`,
      )
      .bind(task.id)
      .all();
    out.push({ task, events });
  }
  return out;
}

// ---------------------------------------------------------------- auth (public)

apiRoutes.post('/auth/login', async (c) => {
  const { phone } = await c.req.json<{ phone?: string }>().catch(() => ({ phone: undefined }));
  if (!phone) return c.json({ error: 'phone required' }, 400);
  // Pre-check FIRST: unregistered phone is rejected without ever calling auth-api.
  const user = await precheckPhone(c.env.DB, phone);
  if (!user) return c.json({ error: 'phone not registered', code: 'PHONE_NOT_REGISTERED' }, 404);
  if (!(await sendOtp(c.env, phone))) return c.json({ error: 'otp send failed' }, 502);
  return c.json({ success: true });
});

apiRoutes.post('/auth/verify', async (c) => {
  const { phone, code } = await c.req.json<{ phone?: string; code?: string }>().catch(() => ({ phone: undefined, code: undefined }));
  if (!phone || !code) return c.json({ error: 'phone and code required' }, 400);
  const user = await precheckPhone(c.env.DB, phone);
  if (!user) return c.json({ error: 'phone not registered', code: 'PHONE_NOT_REGISTERED' }, 404);
  if (!(await verifyOtp(c.env, phone, code))) return c.json({ error: 'invalid code' }, 401);

  const token = await mintSession(c.env.SESSION_SECRET, { sub: user.id, role: user.role });
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'Strict', path: '/', maxAge: 30 * 60 });
  return c.json({ user: { id: user.id, name: user.name, role: user.role } });
});

apiRoutes.post('/auth/logout', (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ success: true });
});

// ------------------------------------------------------ everything below: authed

apiRoutes.use('*', requireAuth);

apiRoutes.get('/me', async (c) => {
  const u = await c.env.DB.prepare('SELECT id, name, role, phone FROM users WHERE id = ?').bind(c.get('userId')).first();
  return u ? c.json({ user: u }) : c.json({ error: 'not found' }, 404);
});

// ------------------------------------------------------------------------- users

// creator creates super_admin; super_admin creates admin. Coarse gate in middleware;
// the "only creator makes super_admin" sub-rule is the one domain check below.
apiRoutes.post('/users', requireRole('super_admin', 'creator'), async (c) => {
  const { phone, name, role } = await c.req.json<{ phone?: string; name?: string; role?: Role }>().catch(() => ({}) as Record<string, undefined>);
  if (!phone || !name || !role) return c.json({ error: 'phone, name, role required' }, 400);
  if (role === 'creator') return c.json({ error: 'cannot create creator via API' }, 400);
  if (role === 'super_admin' && c.get('role') !== 'creator') return c.json({ error: 'only creator can create super_admin' }, 403);

  const id = uuid();
  try {
    await c.env.DB.prepare('INSERT INTO users (id, phone, name, role) VALUES (?, ?, ?, ?)').bind(id, phone.trim(), name, role).run();
  } catch {
    return c.json({ error: 'phone already exists' }, 409);
  }
  await logEvent(c.env.DB, { actorId: c.get('userId'), targetType: 'user', targetId: id, action: 'created' });
  return c.json({ id, phone, name, role }, 201);
});

// Assignment dropdowns: id/name/role only (no phone exposure).
apiRoutes.get('/users', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, name, role FROM users ORDER BY name').all();
  return c.json(results);
});

// ---------------------------------------------------------------------- projects

apiRoutes.get('/projects', async (c) => {
  const role = c.get('role');
  if (role === 'super_admin' || role === 'creator') {
    const { results } = await c.env.DB.prepare('SELECT * FROM projects WHERE archived_at IS NULL ORDER BY created_at DESC').all();
    return c.json(results);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT p.* FROM projects p JOIN project_memberships m ON m.project_id = p.id
     WHERE m.user_id = ? AND p.archived_at IS NULL ORDER BY p.created_at DESC`,
  )
    .bind(c.get('userId'))
    .all();
  return c.json(results);
});

// telegram_group_id is the raw group id (digits only, as copied from an id bot) --
// different projects post to different Telegram groups, so this is required per project.
apiRoutes.post('/projects', requireRole('super_admin', 'creator'), async (c) => {
  const { name, telegram_group_id } = await c.req.json<{ name?: string; telegram_group_id?: string }>().catch(() => ({}) as Record<string, undefined>);
  if (!name) return c.json({ error: 'name required' }, 400);
  if (!telegram_group_id || !telegram_group_id.replace(/\D/g, '')) return c.json({ error: 'telegram_group_id required' }, 400);
  // Validated against Telegram itself (tries both the supergroup -100 and plain
  // group - prefix) so a wrong/not-yet-added-bot group fails loudly here, not
  // silently on every notification afterward.
  const chatId = await resolveChatId(c.env, telegram_group_id);
  if (!chatId) return c.json({ error: 'Telegram group not found -- make sure the bot has been added to it' }, 400);
  const id = uuid();
  await c.env.DB.prepare('INSERT INTO projects (id, name, created_by, telegram_chat_id) VALUES (?, ?, ?, ?)')
    .bind(id, name, c.get('userId'), chatId)
    .run();
  await logEvent(c.env.DB, { actorId: c.get('userId'), targetType: 'project', targetId: id, action: 'created' });
  return c.json({ id, name, telegram_chat_id: chatId }, 201);
});

// Soft-delete: sets archived_at. Tasks stay visible via the Archive tab; the
// escalation sweep already excludes tasks whose project is archived.
apiRoutes.delete('/projects/:projectId', requireRole('super_admin', 'creator'), async (c) => {
  const id = c.req.param('projectId');
  const res = await c.env.DB.prepare('UPDATE projects SET archived_at = ? WHERE id = ? AND archived_at IS NULL').bind(nowIso(), id).run();
  if (!res.meta.changes) return c.json({ error: 'not found' }, 404);
  await logEvent(c.env.DB, { actorId: c.get('userId'), targetType: 'project', targetId: id, action: 'deleted' });
  return c.json({ success: true });
});

// Per-project Archive tab: archived tasks in this project, each with its full
// attributable event trail (who created/edited/deleted/restored/confirmed it),
// PLUS the project-level audit trail (project created/deleted, members added/
// removed) -- these are logged (see /projects and /projects/:id/members above)
// but otherwise have no UI, which is a real gap against "all destructive/admin
// actions ... visible to creator". Scoped to status='archived' for tasks since
// the UI offers a Restore action per entry, and only archived tasks are restorable.
apiRoutes.get('/projects/:projectId/archive', requireRole('super_admin', 'creator'), async (c) => {
  const projectId = c.req.param('projectId');
  const { results: tasks } = await c.env.DB.prepare(
    "SELECT * FROM tasks WHERE project_id = ? AND status = 'archived' ORDER BY updated_at DESC",
  )
    .bind(projectId)
    .all();
  const { results: projectEvents } = await c.env.DB.prepare(
    `SELECT e.*, u.name AS actor_name FROM events e
     LEFT JOIN users u ON u.id = e.actor_id
     WHERE (e.target_type = 'project' OR e.target_type = 'membership') AND e.target_id = ?
     ORDER BY e.created_at DESC`,
  )
    .bind(projectId)
    .all();
  return c.json({ archivedTasks: await withEventTrail(c.env.DB, tasks), projectEvents });
});

// Personal archive: read-only accountability view for the signed-in user --
// tasks they were responsible for that are done or archived. No restore here
// (restoring is a project-archive action gated to super_admin/creator).
apiRoutes.get('/archive/mine', async (c) => {
  const { results: tasks } = await c.env.DB.prepare(
    "SELECT * FROM tasks WHERE responsible_user_id = ? AND status IN ('done', 'archived') ORDER BY updated_at DESC",
  )
    .bind(c.get('userId'))
    .all();
  return c.json(await withEventTrail(c.env.DB, tasks));
});

// List members: powers the responsible-person picker (any project-scoped role)
// and the membership-management screen (super_admin/creator only sees the manage UI,
// but reading the list itself just needs project access, not the elevated role).
// Includes super_admin/creator globally, not just explicit project_memberships rows --
// they already have access to every project without being formally "added", so
// excluding them here would make it impossible to assign a task to yourself.
apiRoutes.get('/projects/:projectId/members', requireProjectAccess('project'), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, role FROM users
     WHERE role IN ('super_admin', 'creator')
        OR id IN (SELECT user_id FROM project_memberships WHERE project_id = ?)
     ORDER BY name`,
  )
    .bind(c.req.param('projectId'))
    .all();
  return c.json(results);
});

apiRoutes.post('/projects/:projectId/members', requireRole('super_admin', 'creator'), async (c) => {
  const projectId = c.req.param('projectId');
  const { user_id } = await c.req.json<{ user_id?: string }>().catch(() => ({ user_id: undefined }));
  if (!user_id) return c.json({ error: 'user_id required' }, 400);
  const id = uuid();
  try {
    await c.env.DB.prepare('INSERT INTO project_memberships (id, project_id, user_id) VALUES (?, ?, ?)').bind(id, projectId, user_id).run();
  } catch {
    return c.json({ error: 'already a member or invalid' }, 409);
  }
  // target_id is the project (not the membership row) so both membership events
  // are queryable by project id alongside 'project' events for the audit view.
  await logEvent(c.env.DB, { actorId: c.get('userId'), targetType: 'membership', targetId: projectId, action: 'membership_added', comment: user_id });
  return c.json({ id }, 201);
});

apiRoutes.delete('/projects/:projectId/members/:userId', requireRole('super_admin', 'creator'), async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.req.param('userId');
  const res = await c.env.DB.prepare('DELETE FROM project_memberships WHERE project_id = ? AND user_id = ?').bind(projectId, userId).run();
  if (!res.meta.changes) return c.json({ error: 'not found' }, 404);
  await logEvent(c.env.DB, { actorId: c.get('userId'), targetType: 'membership', targetId: projectId, action: 'membership_removed', comment: userId });
  return c.json({ success: true });
});

// Board data (polled ~5s by the frontend).
apiRoutes.get('/projects/:projectId/tasks', requireProjectAccess('project'), async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM tasks WHERE project_id = ? AND status IN ('todo','in_progress','done') ORDER BY created_at",
  )
    .bind(c.req.param('projectId'))
    .all();
  return c.json(results);
});

// ------------------------------------------------------------------------- tasks

apiRoutes.post('/projects/:projectId/tasks', requireProjectAccess('project'), async (c) => {
  const projectId = c.req.param('projectId');
  const b = await c.req.json<{ title?: string; description?: string; responsible_user_id?: string; deadline?: string; content_blocks?: string }>().catch(() => ({}) as Record<string, undefined>);
  if (!b.title || !b.responsible_user_id) return c.json({ error: 'title and responsible_user_id required' }, 400);
  const id = uuid();
  await c.env.DB.prepare(
    `INSERT INTO tasks (id, project_id, title, description, responsible_user_id, status, deadline, content_blocks)
     VALUES (?, ?, ?, ?, ?, 'todo', ?, ?)`,
  )
    .bind(id, projectId, b.title, b.description ?? '', b.responsible_user_id, b.deadline ?? null, b.content_blocks ?? null)
    .run();
  await logEvent(c.env.DB, { actorId: c.get('userId'), targetType: 'task', targetId: id, action: 'created' });
  return c.json({ id }, 201);
});

// Edit-lock: a card is editable only while in Todo.
apiRoutes.patch('/tasks/:id', requireProjectAccess('task'), async (c) => {
  const task = c.get('task')!;
  const role = c.get('role');
  // super_admin/creator may also reach in and fix an in-progress task -- doing so
  // reopens it to todo (whoever "took" it must pick it back up deliberately).
  const reopening = task.status === 'in_progress';
  if (reopening && role !== 'super_admin' && role !== 'creator') {
    return c.json({ error: 'only super_admin/creator can edit a task that is in progress' }, 403);
  }
  if (task.status !== 'todo' && !reopening) return c.json({ error: 'task is locked (editable only in todo)' }, 409);
  const b = await c.req
    .json<{ title?: string; description?: string; responsible_user_id?: string; deadline?: string | null; content_blocks?: string }>()
    .catch(() => ({}) as Record<string, undefined>);
  if (reopening && task.telegram_message_id) {
    await deleteMessage(c.env, await projectChatId(c.env.DB, task.project_id), task.telegram_message_id);
  }
  await c.env.DB.prepare(
    `UPDATE tasks SET title = COALESCE(?, title), description = COALESCE(?, description),
       responsible_user_id = COALESCE(?, responsible_user_id), deadline = ?, status = ?, telegram_message_id = ?,
       content_blocks = COALESCE(?, content_blocks), updated_at = ? WHERE id = ?`,
  )
    .bind(
      b.title ?? null,
      b.description ?? null,
      b.responsible_user_id ?? null,
      b.deadline === undefined ? task.deadline : b.deadline,
      reopening ? 'todo' : task.status,
      reopening ? null : task.telegram_message_id,
      b.content_blocks ?? null,
      nowIso(),
      task.id,
    )
    .run();
  await logEvent(c.env.DB, { actorId: c.get('userId'), targetType: 'task', targetId: task.id, action: reopening ? 'edited_reopened' : 'edited' });
  return c.json({ success: true });
});

// Valid transitions only: todo->in_progress, in_progress->done. Everything else 409
// (incl. done->in_progress, which is the confirm/reject flow's job, not a move).
const TRANSITIONS: Record<string, TaskStatus[]> = { todo: ['in_progress'], in_progress: ['done'] };

apiRoutes.post('/tasks/:id/move', requireProjectAccess('task'), async (c) => {
  const task = c.get('task')!;
  const { to } = await c.req.json<{ to?: TaskStatus }>().catch(() => ({ to: undefined }));
  if (!to) return c.json({ error: 'to required' }, 400);
  if (!(TRANSITIONS[task.status] ?? []).includes(to)) return c.json({ error: `invalid transition ${task.status} -> ${to}` }, 409);

  const chatId = await projectChatId(c.env.DB, task.project_id);

  if (to === 'in_progress') {
    // Seed message the escalation cycle later replaces.
    const resp = await c.env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(task.responsible_user_id).first<{ name: string }>();
    const text = `🚀 В работе: "${task.title}"\nОтветственный: ${resp?.name ?? '—'}${task.deadline ? `\nДедлайн: ${task.deadline}` : ''}`;
    const msgId = await sendMessage(c.env, chatId, text);
    await c.env.DB.prepare('UPDATE tasks SET status = ?, telegram_message_id = ?, updated_at = ? WHERE id = ?').bind('in_progress', msgId, nowIso(), task.id).run();
  } else {
    // Reached done: clear the live escalation/seed message.
    if (task.telegram_message_id) await deleteMessage(c.env, chatId, task.telegram_message_id);
    await c.env.DB.prepare('UPDATE tasks SET status = ?, done_at = ?, telegram_message_id = NULL, updated_at = ? WHERE id = ?').bind('done', nowIso(), nowIso(), task.id).run();
  }
  await logEvent(c.env.DB, { actorId: c.get('userId'), targetType: 'task', targetId: task.id, action: `moved_${to}` });
  return c.json({ success: true });
});

// Delete = archive (never hard delete). super_admin/creator only.
apiRoutes.delete('/tasks/:id', requireProjectAccess('task'), requireRole('super_admin', 'creator'), async (c) => {
  const task = c.get('task')!;
  if (task.telegram_message_id) await deleteMessage(c.env, await projectChatId(c.env.DB, task.project_id), task.telegram_message_id);
  await c.env.DB.prepare("UPDATE tasks SET status = 'archived', telegram_message_id = NULL, updated_at = ? WHERE id = ?").bind(nowIso(), task.id).run();
  await logEvent(c.env.DB, { actorId: c.get('userId'), targetType: 'task', targetId: task.id, action: 'deleted' });
  return c.json({ success: true });
});

// Restore requires a comment; un-deletes back to editable todo.
apiRoutes.post('/tasks/:id/restore', requireProjectAccess('task'), requireRole('super_admin', 'creator'), async (c) => {
  const task = c.get('task')!;
  const { comment } = await c.req.json<{ comment?: string }>().catch(() => ({ comment: undefined }));
  if (!comment || !comment.trim()) return c.json({ error: 'comment required' }, 400);
  if (task.status !== 'archived') return c.json({ error: 'only archived tasks can be restored' }, 409);
  await c.env.DB.prepare("UPDATE tasks SET status = 'todo', done_at = NULL, updated_at = ? WHERE id = ?").bind(nowIso(), task.id).run();
  await logEvent(c.env.DB, { actorId: c.get('userId'), targetType: 'task', targetId: task.id, action: 'restored', comment });
  return c.json({ success: true });
});

// Confirm completion. Computes overdue_by vs deadline (0 if on time, null if no deadline).
// confirmed_at guards against re-confirming and lets the board hide Confirm/Reject
// once done (a Done card otherwise looks identical whether confirmed or not).
apiRoutes.post('/tasks/:id/confirm', requireProjectAccess('task'), requireRole('super_admin', 'creator'), async (c) => {
  const task = c.get('task')!;
  if (task.status !== 'done') return c.json({ error: 'task is not in done' }, 409);
  if (task.confirmed_at) return c.json({ error: 'task already confirmed' }, 409);
  let overdueBy: number | null = null;
  if (task.deadline && task.done_at) {
    const late = Math.floor((Date.parse(task.done_at) - Date.parse(task.deadline)) / 1000);
    overdueBy = late > 0 ? late : 0;
  }
  await c.env.DB.prepare('UPDATE tasks SET confirmed_at = ?, updated_at = ? WHERE id = ?').bind(nowIso(), nowIso(), task.id).run();
  await logEvent(c.env.DB, { actorId: c.get('userId'), targetType: 'task', targetId: task.id, action: 'confirmed', overdueBy });
  return c.json({ success: true, overdue_by: overdueBy });
});

// Reject: back to in_progress. Deadline + last_escalated_at untouched (timer continues).
apiRoutes.post('/tasks/:id/reject', requireProjectAccess('task'), requireRole('super_admin', 'creator'), async (c) => {
  const task = c.get('task')!;
  if (task.status !== 'done') return c.json({ error: 'task is not in done' }, 409);
  await c.env.DB.prepare("UPDATE tasks SET status = 'in_progress', done_at = NULL, confirmed_at = NULL, updated_at = ? WHERE id = ?").bind(nowIso(), task.id).run();
  await logEvent(c.env.DB, { actorId: c.get('userId'), targetType: 'task', targetId: task.id, action: 'rejected' });
  return c.json({ success: true });
});

// ------------------------------------------------------------------- attachments

type AttachmentRow = {
  id: string;
  task_id: string;
  telegram_file_id: string;
  telegram_message_id: string;
  filename: string;
  mime_type: string;
  uploaded_by: string;
  project_id: string; // joined from tasks
};

// /attachments/:id/* routes key on the attachment id, so requireProjectAccess('task')
// (which keys on a task id param) can't be used directly -- mirror it here. Loads
// the attachment joined to its owning task and returns it only if the caller may
// access that project. Same opaque null (caller returns 403, no existence leak).
async function attachmentForAccess(c: Context<AppEnv>, attachmentId: string): Promise<AttachmentRow | null> {
  const row = await c.env.DB.prepare(
    `SELECT a.*, t.project_id AS project_id FROM attachments a
     JOIN tasks t ON t.id = a.task_id WHERE a.id = ?`,
  )
    .bind(attachmentId)
    .first<AttachmentRow>();
  if (!row) return null;
  const role = c.get('role');
  if (role === 'super_admin' || role === 'creator') return row;
  const member = await c.env.DB.prepare('SELECT 1 FROM project_memberships WHERE project_id = ? AND user_id = ?')
    .bind(row.project_id, c.get('userId'))
    .first();
  return member ? row : null;
}

// Upload: multipart file -> Telegram storage chat -> attachments row. No status
// restriction (supporting reference material, not a scope-changing edit). Size is
// checked BEFORE any Telegram call so an oversize file never leaves our Worker.
apiRoutes.post('/tasks/:id/attachments', requireProjectAccess('task'), async (c) => {
  const task = c.get('task')!;
  // Cheap pre-filter on the client-supplied Content-Length so an obviously oversize
  // upload is rejected before we buffer the multipart body into isolate memory.
  // Client-supplied, so not authoritative -- the file.size check below is the real guard.
  const declaredLen = Number(c.req.header('content-length') ?? 0);
  if (declaredLen > MAX_ATTACHMENT_BYTES + 4096) return c.json({ error: 'file exceeds the 20MB limit' }, 413);
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) return c.json({ error: 'file required' }, 400);
  if (file.size > MAX_ATTACHMENT_BYTES) return c.json({ error: 'file exceeds the 20MB limit' }, 413);

  const mime = file.type || 'application/octet-stream';
  // The canvas editor only ever inserts photos -- reject anything else here rather
  // than accept a file type the UI has nowhere to render.
  if (!mime.startsWith('image/')) return c.json({ error: 'only image files are supported' }, 415);
  const { fileId, messageId } = await sendDocument(c.env, c.env.TELEGRAM_STORAGE_CHAT_ID, file, file.name);
  const id = uuid();
  await c.env.DB.prepare(
    `INSERT INTO attachments (id, task_id, telegram_file_id, telegram_message_id, filename, mime_type, size_bytes, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, task.id, fileId, messageId, file.name, mime, file.size, c.get('userId'))
    .run();
  await logEvent(c.env.DB, { actorId: c.get('userId'), targetType: 'task', targetId: task.id, action: 'attachment_added', comment: file.name });
  return c.json({ id, filename: file.name, mime_type: mime, size_bytes: file.size }, 201);
});

// List attachments for a task (uploader resolved to a display name).
apiRoutes.get('/tasks/:id/attachments', requireProjectAccess('task'), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT a.id, a.filename, a.mime_type, a.size_bytes, a.uploaded_by, u.name AS uploaded_by_name, a.created_at
     FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
     WHERE a.task_id = ? ORDER BY a.created_at`,
  )
    .bind(c.get('task')!.id)
    .all();
  return c.json(results);
});

// Download: real proxy (never a redirect) so the browser never sees a Telegram
// URL. Fetch the file server-side and stream the bytes back under our own headers.
apiRoutes.get('/attachments/:id/download', async (c) => {
  const att = await attachmentForAccess(c, c.req.param('id'));
  if (!att) return c.json({ error: 'forbidden' }, 403);
  const url = await getFileUrl(c.env, att.telegram_file_id);
  const upstream = await fetch(url);
  if (!upstream.ok || !upstream.body) return c.json({ error: 'file unavailable' }, 502);
  // Strip chars that could break/inject the Content-Disposition header.
  const safeName = att.filename.replace(/[\r\n"\\]/g, '');
  return new Response(upstream.body, {
    headers: {
      'Content-Type': att.mime_type,
      'Content-Disposition': `attachment; filename="${safeName}"`,
      // Belt-and-suspenders: Content-Disposition:attachment already blocks inline
      // rendering of attacker-influenced bytes/mime-type, this just closes the gap fully.
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

// Delete: uploader OR super_admin/creator. Also deletes the underlying Telegram
// message (best-effort, reusing deleteMessage) so the storage chat stays bounded.
apiRoutes.delete('/attachments/:id', async (c) => {
  const att = await attachmentForAccess(c, c.req.param('id'));
  if (!att) return c.json({ error: 'forbidden' }, 403);
  // Fresh DB read for the elevated bypass (not the token's role) -- same
  // de-provisioning/downgrade guard requireRole() applies everywhere else.
  const fresh = await verifySession(c.env.SESSION_SECRET, getCookie(c, SESSION_COOKIE), { db: c.env.DB, allowed: ['super_admin', 'creator'] });
  if (!fresh && att.uploaded_by !== c.get('userId')) return c.json({ error: 'forbidden' }, 403);

  await deleteMessage(c.env, c.env.TELEGRAM_STORAGE_CHAT_ID, att.telegram_message_id);
  await c.env.DB.prepare('DELETE FROM attachments WHERE id = ?').bind(att.id).run();
  await logEvent(c.env.DB, { actorId: c.get('userId'), targetType: 'task', targetId: att.task_id, action: 'attachment_deleted', comment: att.filename });
  return c.json({ success: true });
});
