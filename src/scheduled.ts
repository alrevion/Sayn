// Cron (*/5 * * * *): auto-archive stale Done tasks, then escalate overdue ones.
import type { Env, Task } from './types';
import { logEvent, nowIso } from './db';
import { deleteMessage, sendMessage } from './telegram';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
// Skip a task escalated < ~4 min ago so a Cron double-fire can't send a duplicate
// before the previous message is deleted. send-new/delete-old is not self-idempotent.
const ESCALATION_GUARD_MS = 4 * 60 * 1000;

export async function scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
  await autoArchive(env);
  await escalateOverdue(env);
}

// (a) status='done' + done_at older than 7 days -> archived (system-generated event).
async function autoArchive(env: Env): Promise<void> {
  const { results } = await env.DB.prepare("SELECT id, done_at FROM tasks WHERE status = 'done' AND done_at IS NOT NULL").all<{
    id: string;
    done_at: string;
  }>();
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  for (const t of results) {
    if (Date.parse(t.done_at) > cutoff) continue;
    await env.DB.prepare("UPDATE tasks SET status = 'archived', updated_at = ? WHERE id = ?").bind(nowIso(), t.id).run();
    await logEvent(env.DB, { actorId: null, targetType: 'task', targetId: t.id, action: 'archived' });
  }
}

// (b) in_progress + passed deadline + project NOT soft-deleted -> send-new / delete-old.
async function escalateOverdue(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT t.*, u.name AS responsible_name, p.telegram_chat_id AS project_chat_id FROM tasks t
     JOIN users u ON u.id = t.responsible_user_id
     JOIN projects p ON p.id = t.project_id
     WHERE t.status = 'in_progress' AND t.deadline IS NOT NULL AND p.archived_at IS NULL`,
  ).all<Task & { responsible_name: string; project_chat_id: string }>();

  const now = Date.now();
  for (const t of results) {
    const deadlineMs = Date.parse(t.deadline as string);
    if (!(deadlineMs < now)) continue; // not overdue yet
    if (t.last_escalated_at && now - Date.parse(t.last_escalated_at) < ESCALATION_GUARD_MS) continue;

    const text = `⚠️ ВЫ ПРОСРОЧИЛИ ДЕДЛАЙН\n${t.responsible_name}, задача "${t.title}" просрочена на ${formatOverdue(now - deadlineMs)}.`;
    const newId = await sendMessage(env, t.project_chat_id, text);
    if (!newId) continue; // send failed: keep old message + guard, retry next tick

    // Order matters: new message already sent; now drop the previous one, then store the new id.
    if (t.telegram_message_id) await deleteMessage(env, t.project_chat_id, t.telegram_message_id);
    await env.DB.prepare('UPDATE tasks SET telegram_message_id = ?, last_escalated_at = ? WHERE id = ?')
      .bind(newId, nowIso(), t.id)
      .run();
  }
}

function formatOverdue(ms: number): string {
  const mins = Math.floor(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h >= 24) return `${Math.floor(h / 24)}д ${h % 24}ч`;
  if (h > 0) return `${h}ч ${m}м`;
  return `${m}м`;
}
