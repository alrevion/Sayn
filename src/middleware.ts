// The ONLY place access-control logic lives. Every project-scoped or
// role-gated route goes through these three middlewares.
import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Env, Role, Task } from './types';
import { SESSION_COOKIE, verifySession } from './auth';

export type AppEnv = {
  Bindings: Env;
  Variables: { userId: string; role: Role; task?: Task };
};

// Verifies the session cookie; attaches { userId, role }. 401 if missing/invalid/expired.
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const payload = await verifySession(c.env.SESSION_SECRET, getCookie(c, SESSION_COOKIE));
  if (!payload) return c.json({ error: 'unauthorized' }, 401);
  c.set('userId', payload.sub);
  c.set('role', payload.role);
  await next();
};

// Gates role-elevated actions. Re-fetches the DB user (existence + current role)
// so a de-provisioned / downgraded account can't ride a still-valid token.
export const requireRole = (...roles: Role[]): MiddlewareHandler<AppEnv> => async (c, next) => {
  const payload = await verifySession(c.env.SESSION_SECRET, getCookie(c, SESSION_COOKIE), { db: c.env.DB, allowed: roles });
  if (!payload) return c.json({ error: 'forbidden' }, 403);
  c.set('role', payload.role); // refreshed from DB
  await next();
};

// super_admin/creator always pass. admin passes only with a project_memberships row.
// Returns the SAME 403 whether the project/task is missing or the user isn't a member
// (no existence leak). For 'task' routes it also stashes the loaded task in context.
export const requireProjectAccess =
  (source: 'project' | 'task' = 'project'): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    let projectId: string | null | undefined;

    if (source === 'task') {
      const taskId = c.req.param('id') ?? c.req.param('taskId');
      const task = taskId ? await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first<Task>() : null;
      if (!task) return c.json({ error: 'forbidden' }, 403);
      c.set('task', task);
      projectId = task.project_id;
    } else {
      projectId = c.req.param('projectId');
    }

    const role = c.get('role');
    if (role === 'super_admin' || role === 'creator') return next();

    const member = await c.env.DB.prepare('SELECT 1 FROM project_memberships WHERE project_id = ? AND user_id = ?')
      .bind(projectId, c.get('userId'))
      .first();
    if (!member) return c.json({ error: 'forbidden' }, 403);
    return next();
  };
