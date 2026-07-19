import { useCallback, useEffect, useState } from 'react';
import type { ContentBlock, Project, Task, TaskStatus, User } from '../types';
import { parseContentBlocks } from '../types';
import {
  ApiError,
  confirmTask,
  createTask,
  deleteAttachment,
  deleteTask,
  getProjectMembers,
  getTasks,
  moveTask,
  rejectTask,
  updateTask,
  uploadAttachment,
  type TaskInput,
} from '../lib/api';
import { usePolling } from '../hooks/usePolling';
import type { ComposeBlock } from './ContentEditor';
import { TaskCard } from './TaskCard';
import { TaskDetailModal } from './TaskDetailModal';
import { TaskFormModal } from './TaskFormModal';

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'todo', label: 'Todo' },
  { status: 'in_progress', label: 'In Progress' },
  { status: 'done', label: 'Done' },
];

const NEXT_STATUS: Partial<Record<TaskStatus, TaskStatus>> = {
  todo: 'in_progress',
  in_progress: 'done',
};

interface BoardViewProps {
  project: Project;
  user: User;
}

export function BoardView({ project, user }: BoardViewProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [members, setMembers] = useState<User[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionInfo, setActionInfo] = useState<string | null>(null);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [viewingTask, setViewingTask] = useState<Task | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const canManage = user.role === 'creator' || user.role === 'super_admin';

  const fetchTasks = useCallback(() => {
    getTasks(project.id)
      .then((data) => {
        setTasks(data.filter((t) => t.status !== 'archived'));
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Could not load tasks.'));
  }, [project.id]);

  usePolling(fetchTasks, 5000);

  useEffect(() => {
    getProjectMembers(project.id)
      .then(setMembers)
      .catch(() => setMembers([]));
  }, [project.id]);

  async function runAction(taskId: string, action: () => Promise<unknown>) {
    setActionError(null);
    setActionInfo(null);
    setBusyId(taskId);
    try {
      await action();
      fetchTasks();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'The action could not be completed.');
    } finally {
      setBusyId(null);
    }
  }

  function handleAdvance(task: Task) {
    const next = NEXT_STATUS[task.status];
    if (!next) return;
    runAction(task.id, () => moveTask(task.id, next));
  }

  function describeOverdue(seconds: number) {
    if (seconds <= 0) return 'on time.';
    const hours = Math.floor(seconds / 3600);
    if (hours < 1) return 'less than an hour late.';
    if (hours < 24) return `${hours}h late.`;
    return `${Math.floor(hours / 24)}d late.`;
  }

  async function handleConfirm(task: Task) {
    setActionError(null);
    setActionInfo(null);
    setBusyId(task.id);
    try {
      const { overdue_by } = await confirmTask(task.id);
      setActionInfo(`Confirmed "${task.title}" -- ${overdue_by == null ? 'no deadline was set.' : describeOverdue(overdue_by)}`);
      fetchTasks();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'The action could not be completed.');
    } finally {
      setBusyId(null);
    }
  }

  function handleReject(task: Task) {
    runAction(task.id, () => rejectTask(task.id));
  }

  function handleDelete(task: Task) {
    runAction(task.id, () => deleteTask(task.id).then(() => task));
  }

  // Uploads run after the task itself is saved -- a failed photo must not look
  // like the task wasn't created/saved (it was), so report it separately.
  // Sequential (not Promise.all) so the resolved order matches the canvas order.
  async function resolveBlocks(taskId: string, blocks: ComposeBlock[]): Promise<{ persisted: ContentBlock[]; failed: number }> {
    const persisted: ContentBlock[] = [];
    let failed = 0;
    for (const block of blocks) {
      if (block.kind === 'text') {
        if (block.text.trim()) persisted.push({ type: 'text', text: block.text });
        continue;
      }
      if (block.attachmentId) {
        persisted.push({ type: 'image', attachment_id: block.attachmentId });
        continue;
      }
      if (!block.file) continue;
      try {
        const uploaded = await uploadAttachment(taskId, block.file);
        persisted.push({ type: 'image', attachment_id: uploaded.id });
        URL.revokeObjectURL(block.previewUrl);
      } catch {
        failed += 1;
      }
    }
    return { persisted, failed };
  }

  async function handleCreateSubmit(input: TaskInput, blocks: ComposeBlock[]) {
    const { id } = await createTask(project.id, input);
    setCreating(false);
    fetchTasks();
    const { persisted, failed } = await resolveBlocks(id, blocks);
    await updateTask(id, { content_blocks: JSON.stringify(persisted) });
    fetchTasks();
    if (failed) setActionError(`Task saved, but ${failed} photo(s) failed to upload.`);
  }

  async function handleEditSubmit(input: TaskInput, blocks: ComposeBlock[]) {
    if (!editingTask) return;
    const before = parseContentBlocks(editingTask)
      .filter((b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image')
      .map((b) => b.attachment_id);
    const { persisted, failed } = await resolveBlocks(editingTask.id, blocks);
    const after = new Set(persisted.filter((b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image').map((b) => b.attachment_id));
    // A photo the user removed while editing was only dropped locally (see
    // ContentEditor) -- only actually delete it now that the edit is saved,
    // so hitting Cancel never destroys an attachment.
    const removed = before.filter((id) => !after.has(id));
    await Promise.allSettled(removed.map((id) => deleteAttachment(id)));
    await updateTask(editingTask.id, { ...input, content_blocks: JSON.stringify(persisted) });
    setEditingTask(null);
    fetchTasks();
    if (failed) setActionError(`Task saved, but ${failed} photo(s) failed to upload.`);
  }

  const memberById = new Map(members.map((m) => [m.id, m]));

  return (
    <div className="flex h-full flex-col p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-900">{project.name}</h1>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          New task
        </button>
      </div>

      {loadError ? (
        <div role="alert" className="mb-3 rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          {loadError}
        </div>
      ) : null}
      {actionError ? (
        <div role="alert" className="mb-3 rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          {actionError}
        </div>
      ) : null}
      {actionInfo ? (
        <div role="status" className="mb-3 rounded-md border border-emerald-300 bg-emerald-50 p-2 text-sm text-emerald-800">
          {actionInfo}
        </div>
      ) : null}

      <div className="grid flex-1 grid-cols-1 gap-4 overflow-y-auto sm:grid-cols-3">
        {COLUMNS.map((col) => (
          <div key={col.status} className="flex min-h-0 flex-col rounded-lg bg-slate-50 p-3">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
              {col.label}
              <span className="ml-2 rounded-full bg-slate-200 px-2 py-0.5 text-xs font-normal text-slate-600">
                {tasks.filter((t) => t.status === col.status).length}
              </span>
            </h2>
            <div className="flex flex-1 flex-col gap-2 overflow-y-auto">
              {tasks
                .filter((t) => t.status === col.status)
                .map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    responsible={memberById.get(task.responsible_user_id)}
                    canManage={canManage}
                    busy={busyId === task.id}
                    onEdit={() => setEditingTask(task)}
                    onAdvance={() => handleAdvance(task)}
                    onConfirm={() => handleConfirm(task)}
                    onReject={() => handleReject(task)}
                    onDelete={() => handleDelete(task)}
                    onView={() => setViewingTask(task)}
                  />
                ))}
            </div>
          </div>
        ))}
      </div>

      {viewingTask ? (
        <TaskDetailModal
          task={viewingTask}
          responsible={memberById.get(viewingTask.responsible_user_id)}
          onClose={() => setViewingTask(null)}
        />
      ) : null}

      {creating ? (
        <TaskFormModal members={members} onClose={() => setCreating(false)} onSubmit={handleCreateSubmit} />
      ) : null}
      {editingTask ? (
        <TaskFormModal
          task={editingTask}
          members={members}
          onClose={() => setEditingTask(null)}
          onSubmit={handleEditSubmit}
        />
      ) : null}
    </div>
  );
}
