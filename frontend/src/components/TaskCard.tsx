import type { MouseEvent } from 'react';
import { ArrowRight, Check, CheckCircle2, Pencil, Trash2, User as UserIcon, X } from 'lucide-react';
import type { Task, User } from '../types';
import { userBadgeColor } from '../lib/badgeColor';

interface TaskCardProps {
  task: Task;
  responsible: User | undefined;
  canManage: boolean; // super_admin/creator
  onEdit: () => void;
  onAdvance: () => void;
  onConfirm: () => void;
  onReject: () => void;
  onDelete: () => void;
  onView: () => void;
  busy: boolean;
}

function formatDeadline(deadline: string) {
  const d = new Date(deadline);
  if (Number.isNaN(d.getTime())) return deadline;
  return d.toLocaleDateString();
}

const ADVANCE_LABEL: Partial<Record<Task['status'], string>> = {
  todo: 'Move to In Progress',
  in_progress: 'Move to Done',
};

// Uniform-size, single-line card: title/description never wrap past one line
// (truncated with ellipsis), so every card in a column is the same height
// regardless of content. Full text + attachments live in the detail modal
// (onView), not here -- that's what keeps this height fixed.
export function TaskCard({
  task,
  responsible,
  canManage,
  onEdit,
  onAdvance,
  onConfirm,
  onReject,
  onDelete,
  onView,
  busy,
}: TaskCardProps) {
  // todo: anyone with project access. in_progress: super_admin/creator only
  // (editing it hands it back to todo -- see routes.ts PATCH /tasks/:id).
  const editable = task.status === 'todo' || (task.status === 'in_progress' && canManage);
  const advanceLabel = ADVANCE_LABEL[task.status];
  const isOverdue =
    !!task.deadline &&
    task.status === 'in_progress' &&
    new Date(task.deadline).getTime() < Date.now();

  function stop(fn: () => void) {
    return (e: MouseEvent) => {
      e.stopPropagation();
      fn();
    };
  }

  return (
    <div
      onClick={onView}
      className={`relative flex cursor-pointer flex-col gap-1.5 rounded-md border bg-white p-3 shadow-sm hover:shadow-md ${
        isOverdue ? 'border-red-300' : 'border-slate-200'
      }`}
    >
      {advanceLabel ? (
        <button
          type="button"
          onClick={stop(onAdvance)}
          disabled={busy}
          title={advanceLabel}
          aria-label={advanceLabel}
          className="absolute right-2 top-2 rounded p-1 text-slate-400 hover:bg-blue-50 hover:text-blue-700 disabled:opacity-50"
        >
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : null}

      <h3 className="truncate pr-7 text-sm font-medium text-slate-900">{task.title}</h3>
      <p className="truncate pr-7 text-xs text-slate-600">{task.description || ' '}</p>

      <div className="flex min-w-0 items-center gap-1.5">
        <span
          className={`inline-flex min-w-0 items-center gap-1 truncate rounded-full px-2 py-0.5 text-xs font-medium ${userBadgeColor(task.responsible_user_id)}`}
        >
          <UserIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{responsible ? responsible.name : 'Unassigned'}</span>
        </span>
        {task.deadline ? (
          <span
            className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
              isOverdue ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-600'
            }`}
          >
            {formatDeadline(task.deadline)}
            {isOverdue ? <span className="sr-only"> (overdue)</span> : null}
          </span>
        ) : null}
      </div>

      <div className="flex min-h-[1.75rem] items-center gap-2">
        {task.status === 'done' && canManage && !task.confirmed_at ? (
          <>
            <button
              type="button"
              onClick={stop(onConfirm)}
              disabled={busy}
              aria-label="Confirm task complete"
              title="Confirm complete"
              className="flex items-center gap-1 rounded bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              <Check className="h-3 w-3" aria-hidden="true" />
              Confirm
            </button>
            <button
              type="button"
              onClick={stop(onReject)}
              disabled={busy}
              aria-label="Reject, send back to In Progress"
              title="Reject: not actually done"
              className="flex items-center gap-1 rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <X className="h-3 w-3" aria-hidden="true" />
              Reject
            </button>
          </>
        ) : null}

        {task.status === 'done' && task.confirmed_at ? (
          <span className="flex items-center gap-1 text-xs font-medium text-emerald-700">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
            Confirmed
          </span>
        ) : null}

        <div className="ml-auto flex items-center gap-1">
          {editable ? (
            <button
              type="button"
              onClick={stop(onEdit)}
              disabled={busy}
              aria-label="Edit task"
              title="Edit"
              className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50"
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : null}
          {canManage ? (
            <button
              type="button"
              onClick={stop(onDelete)}
              disabled={busy}
              aria-label="Delete task (archive)"
              title="Archive this task"
              className="rounded p-1 text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
