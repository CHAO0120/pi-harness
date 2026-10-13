/**
 * Turns pi's session events into the handful of things a chat panel renders.
 * No transcript is kept here: pi owns the conversation, so the UI reloads it
 * with `get_messages` instead of persisting its own copy.
 */
import { abortTurn, connect, noteRecord, piRelay, type RelaySettings } from "./session";
import { RelayError, responseError, type PiRecord } from "./relay";

export type PiEvent =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool-start"; id: string; name: string; args: unknown }
  | { kind: "tool-end"; id: string; name: string; isError: boolean; output: string }
  | { kind: "error"; message: string }
  | { kind: "settled"; aborted: boolean };

const TOOL_OUTPUT_CHARS = 6_000;
const ABORT_DRAIN_MS = 8_000;

/** Pure mapping so it can be tested without a relay; see tests/loop.test.ts. */
export class PiEventMapper {
  private readonly names = new Map<string, string>();

  push(record: PiRecord): PiEvent[] {
    switch (record.type) {
      case "message_update":
        return this.onMessageUpdate(record);
      case "tool_execution_start":
        return this.onToolStart(record);
      case "tool_execution_end":
        return this.onToolEnd(record);
      case "agent_settled":
        return [{ kind: "settled", aborted: record.aborted === true }];
      case "response":
        return this.onResponse(record);
      case "relay":
        return this.onRelay(record);
      default:
        return [];
    }
  }

  private onMessageUpdate(record: PiRecord): PiEvent[] {
    const event = isObject(record.assistantMessageEvent) ? record.assistantMessageEvent : null;
    if (!event) return [];
    if (event.type === "text_delta" && typeof event.delta === "string") {
      return [{ kind: "text", text: event.delta }];
    }
    // Thinking is rendered collapsed; it is the only other block worth showing.
    if (event.type === "thinking_delta" && typeof event.delta === "string") {
      return [{ kind: "thinking", text: event.delta }];
    }
    if (event.type === "error") {
      return [{ kind: "error", message: text(event.reason, "stream error") }];
    }
    return [];
  }

  private onToolStart(record: PiRecord): PiEvent[] {
    const id = text(record.toolCallId);
    const name = text(record.toolName, "tool");
    if (!id) return [];
    this.names.set(id, name);
    return [{ kind: "tool-start", id, name, args: record.args ?? {} }];
  }

  private onToolEnd(record: PiRecord): PiEvent[] {
    const id = text(record.toolCallId);
    if (!id) return [];
    return [
      {
        kind: "tool-end",
        id,
        name: this.names.get(id) ?? text(record.toolName, "tool"),
        isError: record.isError === true,
        output: clip(toolOutput(record.result), TOOL_OUTPUT_CHARS),
      },
    ];
  }

  private onResponse(record: PiRecord): PiEvent[] {
    const error = responseError(record);
    return error ? [{ kind: "error", message: error }] : [];
  }

  private onRelay(record: PiRecord): PiEvent[] {
    switch (text(record.event)) {
      case "disconnected":
        return [{ kind: "error", message: "与 pi 的连接已断开（下一条消息会自动重连）。" }];
      case "pi_exit":
        return [{ kind: "error", message: `pi 进程已退出（code ${text(record.code, "?")}）。` }];
      case "pi_error":
        return [{ kind: "error", message: `pi 启动失败：${text(record.message)}` }];
      case "busy":
        return [{ kind: "error", message: "pi-relay 连接数已满。" }];
      case "unauthorized":
        return [{ kind: "error", message: "relay 令牌不对，请检查设置。" }];
      case "bad_cwd":
        return [{ kind: "error", message: `relay 不允许这个工作目录：${text(record.requested)}` }];
      default:
        return [];
    }
  }
}

/**
 * Runs one turn. `piPrompt` is the already-built prompt (context preamble
 * included), so the panel decides what the agent gets to see.
 */
export async function* runTurn(
  piPrompt: string,
  settings: RelaySettings,
  signal: AbortSignal,
): AsyncGenerator<PiEvent> {
  const mapper = new PiEventMapper();
  let settled = false;

  try {
    await connect(settings);
    const accepted = await piRelay().request({ type: "prompt", message: piPrompt });
    const error = responseError(accepted);
    if (error) {
      yield { kind: "error", message: error };
      return;
    }

    let drainUntil = 0;
    for await (const record of piRelay().stream(signal)) {
      noteRecord(record);
      for (const event of mapper.push(record)) yield event;
      if (record.type === "agent_settled") {
        settled = true;
        break;
      }
      if (signal.aborted) {
        // pi keeps producing until it has honoured the abort; leaving early
        // would strand an agent_settled for the next turn to consume.
        if (drainUntil === 0) drainUntil = Date.now() + ABORT_DRAIN_MS;
        else if (Date.now() > drainUntil) break;
      }
    }
  } catch (error) {
    yield { kind: "error", message: describeFailure(error) };
  }

  if (!settled && signal.aborted) abortTurn();
}

/** Reloads the visible conversation from pi (the agent is the source of truth). */
export async function loadHistory(settings: RelaySettings): Promise<PiHistoryMessage[]> {
  await connect(settings);
  const response = await piRelay().request({ type: "get_messages" });
  const error = responseError(response);
  if (error) throw new RelayError(error);
  const data = isObject(response.data) ? response.data : null;
  const messages: PiHistoryMessage[] = [];
  for (const entry of Array.isArray(data?.messages) ? data.messages : []) {
    const message = toHistory(entry);
    if (message) messages.push(message);
  }
  return messages;
}

export interface PiHistoryMessage {
  role: "user" | "assistant";
  text: string;
  tools: { name: string; summary: string; output: string; isError: boolean }[];
}

function toHistory(entry: unknown): PiHistoryMessage | null {
  if (!isObject(entry)) return null;
  const role = entry.role;
  const blocks = Array.isArray(entry.content) ? entry.content : [];
  if (role !== "user" && role !== "assistant") return null;
  const texts: string[] = [];
  const tools: PiHistoryMessage["tools"] = [];
  for (const block of blocks) {
    if (!isObject(block)) continue;
    if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    else if (block.type === "toolCall" && typeof block.name === "string") {
      tools.push({ name: block.name, summary: toolSummary(block.name, block.arguments), output: "", isError: false });
    }
  }
  const text = texts.join("\n").trim();
  if (!text && tools.length === 0) return null;
  return { role, text, tools };
}

/** Short human summary of a tool call's arguments, for the collapsed card. */
export function toolSummary(_name: string, args: unknown): string {
  if (!isObject(args)) return "";
  for (const key of ["command", "path", "file_path", "filePath", "pattern", "query", "url"]) {
    const value = args[key];
    if (typeof value === "string" && value) return value.length > 120 ? `${value.slice(0, 120)}…` : value;
  }
  const json = JSON.stringify(args);
  return json === "{}" ? "" : json.length > 120 ? `${json.slice(0, 120)}…` : json;
}

/** Vault path named by a tool call, so the card can offer to open the file. */
export function toolFilePath(args: unknown): string | null {
  if (!isObject(args)) return null;
  for (const key of ["path", "file_path", "filePath", "file"]) {
    const value = args[key];
    if (typeof value === "string" && value && !value.startsWith("http")) return value;
  }
  return null;
}

function toolOutput(result: unknown): string {
  const container = isObject(result) ? result : null;
  const parts = Array.isArray(container?.content) ? container.content : [];
  const texts: string[] = [];
  let images = 0;
  for (const part of parts) {
    if (!isObject(part)) continue;
    if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
    else if (part.type === "image") images += 1;
  }
  if (images > 0) texts.push(`[${images} image(s)]`);
  return texts.join("\n").trim() || "(no output)";
}

function describeFailure(error: unknown): string {
  if (error instanceof RelayError) return `${error.message}${error.detail ? `（${error.detail}）` : ""}`;
  return error instanceof Error ? error.message : String(error);
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n…[truncated]`;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : fallback;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
