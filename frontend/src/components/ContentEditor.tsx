import { useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent as ReactDragEvent } from 'react';
import { GripVertical, ImagePlus, Plus, Type, X } from 'lucide-react';
import { MAX_ATTACHMENT_BYTES } from '../lib/api';

// Compose-time block. `attachmentId` is set once a photo is uploaded (or was
// already an existing attachment when editing); `file`+`previewUrl` (a local
// blob: URL) carry a not-yet-uploaded photo. Never both unset at once.
export type ComposeBlock =
  | { id: string; kind: 'text'; text: string }
  | { id: string; kind: 'image'; attachmentId: string | null; file: File | null; previewUrl: string };

export function newTextBlock(text = ''): ComposeBlock {
  return { id: crypto.randomUUID(), kind: 'text', text };
}

interface ContentEditorProps {
  blocks: ComposeBlock[];
  onChange: (blocks: ComposeBlock[]) => void;
}

// Consecutive photo blocks form one drag/reorder unit and render as a single
// horizontal, wrapping strip -- a run of photos reads as a gallery, not a scroll.
type Group = { kind: 'text'; block: Extract<ComposeBlock, { kind: 'text' }> } | { kind: 'images'; blocks: Extract<ComposeBlock, { kind: 'image' }>[] };

function groupBlocks(blocks: ComposeBlock[]): Group[] {
  const groups: Group[] = [];
  for (const block of blocks) {
    if (block.kind === 'text') {
      groups.push({ kind: 'text', block });
    } else {
      const last = groups[groups.length - 1];
      if (last?.kind === 'images') last.blocks.push(block);
      else groups.push({ kind: 'images', blocks: [block] });
    }
  }
  return groups;
}

function buildImageBlocks(files: File[]): { blocks: ComposeBlock[]; error: string | null } {
  const images = files.filter((f) => f.type.startsWith('image/'));
  const tooBig = images.filter((f) => f.size > MAX_ATTACHMENT_BYTES);
  const ok = images.filter((f) => f.size <= MAX_ATTACHMENT_BYTES);

  let error: string | null = null;
  if (images.length < files.length) error = 'Only image files can be added here.';
  else if (tooBig.length > 0) error = `${tooBig.map((f) => f.name).join(', ')} exceeds the 20MB limit.`;

  const blocks: ComposeBlock[] = ok.map((f) => ({
    id: crypto.randomUUID(),
    kind: 'image',
    attachmentId: null,
    file: f,
    previewUrl: URL.createObjectURL(f),
  }));
  return { blocks, error };
}

// Notion-lite canvas: an ordered sequence of text blocks and inline photos,
// nothing else (no headings/lists/tables -- out of scope for now). A "+" sits
// at every gap (including before the first block and after the last) so any
// block can start as either text or a photo, inserted at that exact spot --
// not just appended. Each block/photo-row has a drag handle to reorder.
export function ContentEditor({ blocks, onChange }: ContentEditorProps) {
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingInsertIndex = useRef(0);

  function updateText(id: string, text: string) {
    onChange(blocks.map((b) => (b.id === id ? { ...b, text } : b)));
  }

  function removeBlock(id: string) {
    const block = blocks.find((b) => b.id === id);
    if (block?.kind === 'image' && block.previewUrl.startsWith('blob:')) URL.revokeObjectURL(block.previewUrl);
    onChange(blocks.filter((b) => b.id !== id));
  }

  function insertTextAt(index: number) {
    onChange([...blocks.slice(0, index), newTextBlock(), ...blocks.slice(index)]);
  }

  function insertImagesAt(index: number, files: File[]) {
    const { blocks: imageBlocks, error } = buildImageBlocks(files);
    setFileError(error);
    if (imageBlocks.length === 0) return;
    onChange([...blocks.slice(0, index), ...imageBlocks, ...blocks.slice(index)]);
  }

  function requestImagesAt(index: number) {
    pendingInsertIndex.current = index;
    fileInputRef.current?.click();
  }

  function handleFileInput(e: ChangeEvent<HTMLInputElement>) {
    insertImagesAt(pendingInsertIndex.current, Array.from(e.target.files ?? []));
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handlePaste(e: ClipboardEvent<HTMLDivElement>) {
    // .files (not .items): a single pasted screenshot often shows up as
    // multiple .items entries (e.g. macOS offers both a PNG and a TIFF
    // representation of the same image), which double-inserted it. .files is
    // the browser's already-deduplicated file list for the paste.
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length > 0) insertImagesAt(blocks.length, files);
  }

  function handleDrop(e: ReactDragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (dragFrom !== null) return; // this is a block-reorder drop, handled by the group's own onDrop
    insertImagesAt(blocks.length, Array.from(e.dataTransfer.files ?? []));
  }

  function moveGroup(from: number, to: number) {
    if (from === to) return;
    const groups = groupBlocks(blocks);
    const reordered = [...groups];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);
    onChange(reordered.flatMap((g): ComposeBlock[] => (g.kind === 'text' ? [g.block] : g.blocks)));
  }

  const groups = groupBlocks(blocks);
  let cursor = 0;
  const gapIndexes: number[] = [0];
  for (const group of groups) {
    cursor += group.kind === 'text' ? 1 : group.blocks.length;
    gapIndexes.push(cursor);
  }

  return (
    <div
      onPaste={handlePaste}
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
      className="flex flex-col rounded-md border border-slate-300 p-2"
    >
      <input ref={fileInputRef} type="file" accept="image/*" multiple className="sr-only" onChange={handleFileInput} />

      <InsertGap index={gapIndexes[0]} onInsertText={insertTextAt} onInsertImages={requestImagesAt} />

      {groups.length === 0 ? <p className="py-4 text-center text-xs text-slate-400">Click + to write or add a photo.</p> : null}

      {groups.map((group, gi) => (
        <div key={group.kind === 'text' ? group.block.id : group.blocks[0].id}>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(gi);
            }}
            onDragLeave={() => setDragOver((d) => (d === gi ? null : d))}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation(); // this is a reorder drop, not a photo drop -- don't let the container's onDrop also fire
              setDragOver(null);
              if (dragFrom !== null) moveGroup(dragFrom, gi);
              setDragFrom(null);
            }}
            className={`group flex items-start gap-1 rounded ${dragOver === gi && dragFrom !== null && dragFrom !== gi ? 'bg-blue-50 ring-1 ring-blue-300' : ''}`}
          >
            <div
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', String(gi));
                setDragFrom(gi);
              }}
              onDragEnd={() => {
                setDragFrom(null);
                setDragOver(null);
              }}
              aria-label="Drag to reorder"
              title="Drag to reorder"
              className="mt-1 shrink-0 cursor-grab rounded p-0.5 text-slate-300 opacity-0 group-hover:opacity-100 hover:bg-slate-100 hover:text-slate-500 active:cursor-grabbing"
            >
              <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
            </div>

            <div className="min-w-0 flex-1">
              {group.kind === 'text' ? (
                <div className="relative">
                  <textarea
                    value={group.block.text}
                    onChange={(e) => updateText(group.block.id, e.target.value)}
                    placeholder="Write something…"
                    rows={3}
                    className="w-full resize-y rounded-md border-none px-1 py-1 text-sm text-slate-900 focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-600"
                  />
                  <button
                    type="button"
                    onClick={() => removeBlock(group.block.id)}
                    aria-label="Remove text block"
                    className="absolute right-1 top-1 rounded p-0.5 text-slate-300 opacity-0 hover:bg-slate-100 hover:text-red-700 group-hover:opacity-100"
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2 py-1">
                  {group.blocks.map((block) => (
                    <div key={block.id} className="relative">
                      <img src={block.previewUrl} alt="" className="h-28 w-28 rounded-md object-cover" />
                      <button
                        type="button"
                        onClick={() => removeBlock(block.id)}
                        aria-label="Remove photo"
                        className="absolute right-1 top-1 rounded-full bg-slate-900/60 p-1 text-white hover:bg-slate-900/80"
                      >
                        <X className="h-3 w-3" aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <InsertGap index={gapIndexes[gi + 1]} onInsertText={insertTextAt} onInsertImages={requestImagesAt} />
        </div>
      ))}

      {fileError ? (
        <p role="alert" className="mt-1 text-xs text-red-700">
          {fileError}
        </p>
      ) : null}
      <p className="mt-1 text-xs text-slate-400">Paste or drag a photo in anywhere, or use + to place one exactly.</p>
    </div>
  );
}

interface InsertGapProps {
  index: number;
  onInsertText: (index: number) => void;
  onInsertImages: (index: number) => void;
}

// The "+" between every pair of blocks (and before the first / after the
// last): click inserts a text block immediately; hover past ~100ms instead
// expands into an explicit Text/Photo choice, so a quick click stays fast.
function InsertGap({ index, onInsertText, onInsertImages }: InsertGapProps) {
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);

  function clearTimer() {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }

  return (
    <div
      className="flex h-4 items-center justify-center"
      onMouseEnter={() => {
        timer.current = window.setTimeout(() => setOpen(true), 100);
      }}
      onMouseLeave={() => {
        clearTimer();
        setOpen(false);
      }}
    >
      {open ? (
        <div className="flex items-center gap-0.5 rounded-full border border-slate-300 bg-white px-1 py-0.5 shadow-sm">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onInsertText(index);
            }}
            aria-label="Insert a text block here"
            title="Text"
            className="rounded-full p-1 text-slate-500 hover:bg-slate-100"
          >
            <Type className="h-3 w-3" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onInsertImages(index);
            }}
            aria-label="Insert a photo here"
            title="Photo"
            className="rounded-full p-1 text-slate-500 hover:bg-slate-100"
          >
            <ImagePlus className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            clearTimer();
            onInsertText(index);
          }}
          aria-label="Insert a text block here"
          className="rounded-full p-0.5 text-slate-300 hover:bg-slate-100 hover:text-slate-500"
        >
          <Plus className="h-3 w-3" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
