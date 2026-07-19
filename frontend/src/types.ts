// Mirrors the backend's shared types (repo root src/types.ts). Duplicated here
// rather than imported across the Vite/Worker build boundary.

export type Role = 'creator' | 'super_admin' | 'admin';
export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'archived';

export interface User {
  id: string;
  phone: string;
  name: string;
  role: Role;
  created_at: string;
}

export interface Project {
  id: string;
  name: string;
  created_by: string;
  created_at: string;
  archived_at: string | null;
  telegram_chat_id: string;
}

export interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string;
  content_blocks: string | null;
  responsible_user_id: string;
  status: TaskStatus;
  deadline: string | null;
  done_at: string | null;
  confirmed_at: string | null;
  telegram_message_id: string | null;
  last_escalated_at: string | null;
  created_at: string;
  updated_at: string;
}

// The task canvas: an ordered sequence of text and inline-photo blocks --
// nothing else (no headings/lists/tables). Persisted as task.content_blocks (JSON).
export type ContentBlock = { type: 'text'; text: string } | { type: 'image'; attachment_id: string };

// content_blocks is NULL for tasks saved before this existed -- fall back to
// wrapping the plain-text description as a single block.
export function parseContentBlocks(task: Pick<Task, 'content_blocks' | 'description'>): ContentBlock[] {
  if (task.content_blocks) {
    try {
      const parsed = JSON.parse(task.content_blocks);
      if (Array.isArray(parsed)) return parsed as ContentBlock[];
    } catch {
      // malformed -- fall through to the description fallback
    }
  }
  return task.description ? [{ type: 'text', text: task.description }] : [];
}

export interface TaskEvent {
  id: string;
  actor_id: string | null;
  target_type: 'task' | 'project' | 'membership' | 'user';
  target_id: string;
  action: string;
  comment: string | null;
  overdue_by: number | null;
  created_at: string;
}

// Frontend-only shape for the archive views: a task plus the trail of events
// recorded against it (create/archive/restore/confirm/reject), each annotated
// with the acting user's display name (null actor = system/auto-archive).
export interface ArchivedTaskEntry {
  task: Task;
  events: Array<TaskEvent & { actor_name: string | null }>;
}
