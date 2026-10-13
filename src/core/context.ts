/**
 * The plugin's view of "which note am I on". Obsidian knows; pi does not — the
 * agent runs in Termux with a working directory, not a cursor. So the active
 * note and any selection are rendered into the prompt as an explicit preamble.
 *
 * Text, not `@path`: RPC mode rejects `@file` arguments (pi docs/rpc.md), so
 * the path has to travel inside the message.
 */

export interface NoteContext {
  /** Vault-relative path of the active note, if any. */
  path: string | null;
  /** Currently selected text in that note, if the user selected something. */
  selection: string | null;
  /** Full note body, read only when the user asked for it. */
  body: string | null;
  includePath: boolean;
  includeSelection: boolean;
}

export const MAX_CONTEXT_CHARS = 8_000;

/** Prompt text sent to pi: context preamble (when enabled) + the user's words. */
export function buildPrompt(userText: string, context: NoteContext): string {
  const parts: string[] = [];
  if (context.includePath && context.path) {
    parts.push(`- active note (vault-relative path): ${context.path}`);
    if (context.includeSelection && context.selection?.trim()) {
      parts.push(`- selected text in that note:\n${clip(context.selection)}`);
    }
    if (context.body?.trim()) {
      parts.push(`- full note content:\n${clip(context.body)}`);
    }
  }
  if (parts.length === 0) return userText;
  // "这篇笔记/当前笔记" in the request refers to exactly the note above.
  return `[Obsidian context]\n${parts.join("\n")}\n[/Obsidian context]\n\n[User request]\n${userText}`;
}

function clip(text: string): string {
  if (text.length <= MAX_CONTEXT_CHARS) return text;
  return `${text.slice(0, MAX_CONTEXT_CHARS)}\n…[truncated ${text.length - MAX_CONTEXT_CHARS} chars]`;
}

/** One-line description of what context the composer will attach, for the chip. */
export function describeContext(context: NoteContext): string {
  if (!context.includePath || !context.path) return "no note";
  const name = context.path.split("/").pop() ?? context.path;
  if (context.includeSelection && context.selection?.trim()) return `${name} + selection`;
  return name;
}
