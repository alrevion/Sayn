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
  // Full chat_id (-100... prefix already applied), one Telegram group per project.
  telegram_chat_id: string;
}

export interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string;
  // JSON array of {type:'text',text} / {type:'image',attachment_id} blocks --
  // the canvas editor's content. NULL for tasks created before this existed.
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

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  AUTH_API_URL: string;
  AUTH_API_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  // Single dedicated bot-only group used across ALL projects purely as a blob
  // store for task attachments -- never a project's human-visible chat.
  TELEGRAM_STORAGE_CHAT_ID: string;
  SESSION_SECRET: string;
  // Remote MCP server (src/mcp.ts): bearer token gating /mcp, and the Sayn user
  // id every MCP-originated action is attributed to.
  MCP_API_TOKEN: string;
  MCP_USER_ID: string;
}

export interface SessionPayload {
  sub: string; // user id
  role: Role;
  exp: number;
}
