/**
 * One pi session, one relay socket. pi owns the conversation, the tools and
 * the compaction, so this module holds almost no state — only what the
 * composer chips need to stay honest (live model, thinking level).
 */
import { PiRelay, RelayError, responseError, type PiRecord, type RelayTarget } from "./relay";

export interface RelaySettings extends RelayTarget {
  /** model id handed to pi when the session starts; empty = pi's own default */
  model?: string;
}

export interface PiModelInfo {
  provider: string;
  id: string;
  name: string;
}

interface PiStatus {
  provider: string;
  modelId: string;
  label: string;
  thinkingLevel: string | null;
}

const MODELS_CACHE_MS = 60_000;

let relay: PiRelay | null = null;
let currentStatus: PiStatus | null = null;
let modelsCache: { at: number; models: PiModelInfo[] } | null = null;

export function piRelay(): PiRelay {
  relay ??= new PiRelay();
  return relay;
}

export async function connect(settings: RelaySettings): Promise<void> {
  await piRelay().ensure(settings);
}

export function isConnected(): boolean {
  return relay?.connected ?? false;
}

/** Drops the socket; the next turn reconnects (same session id → same conversation). */
export function disconnect(): void {
  relay?.disconnect();
}

export function status(): PiStatus | null {
  return currentStatus;
}

/** Mirrors model/thinking out of the record stream so the chips do not poll. */
export function noteRecord(record: PiRecord): void {
  if (record.type === "response") {
    const data = isObject(record.data) ? record.data : null;
    const model = data && isObject(data.model) ? data.model : null;
    if (model) currentStatus = { ...(currentStatus ?? blank()), ...readModel(model) };
    if (data && typeof data.thinkingLevel === "string") {
      currentStatus = { ...(currentStatus ?? blank()), thinkingLevel: data.thinkingLevel };
    }
    return;
  }
  if (record.type === "thinking_level_changed" && typeof record.level === "string") {
    currentStatus = { ...(currentStatus ?? blank()), thinkingLevel: record.level };
    return;
  }
  if (record.type === "message_start") {
    const message = isObject(record.message) ? record.message : null;
    if (message?.role === "assistant" && typeof message.model === "string") {
      currentStatus = { ...(currentStatus ?? blank()), label: message.model, modelId: message.model };
    }
  }
}

/** Refreshes status from pi (call once when the view opens). */
export async function refreshStatus(settings: RelaySettings): Promise<void> {
  await connect(settings);
  noteRecord(await piRelay().request({ type: "get_state" }));
}

export async function availableModels(settings: RelaySettings, force = false): Promise<PiModelInfo[]> {
  if (!force && modelsCache && Date.now() - modelsCache.at < MODELS_CACHE_MS) return modelsCache.models;
  await connect(settings);
  const response = await piRelay().request({ type: "get_available_models" });
  const error = responseError(response);
  if (error) throw new RelayError(error);
  const data = isObject(response.data) ? response.data : null;
  const models: PiModelInfo[] = [];
  for (const entry of Array.isArray(data?.models) ? data.models : []) {
    if (!isObject(entry) || typeof entry.id !== "string" || !entry.id) continue;
    models.push({
      provider: typeof entry.provider === "string" ? entry.provider : "",
      id: entry.id,
      name: typeof entry.name === "string" && entry.name ? entry.name : entry.id,
    });
  }
  modelsCache = { at: Date.now(), models };
  return models;
}

export async function setModel(settings: RelaySettings, provider: string, modelId: string): Promise<void> {
  await connect(settings);
  const response = await piRelay().request({ type: "set_model", provider, modelId });
  const error = responseError(response);
  if (error) throw new RelayError(error);
  noteRecord(response);
}

export async function setThinkingLevel(settings: RelaySettings, level: string): Promise<void> {
  await connect(settings);
  const response = await piRelay().request({ type: "set_thinking_level", level });
  const error = responseError(response);
  if (error) throw new RelayError(error);
  noteRecord(response);
}

/** Best-effort: nothing is running if the socket is already gone. */
export function abortTurn(): void {
  try {
    piRelay().send({ type: "abort" });
  } catch {
    // Not connected.
  }
}

function readModel(model: Record<string, unknown>): PiStatus {
  const id = typeof model.id === "string" ? model.id : "";
  return {
    provider: typeof model.provider === "string" ? model.provider : "",
    modelId: id,
    label: typeof model.name === "string" && model.name ? model.name : id,
    thinkingLevel: currentStatus?.thinkingLevel ?? null,
  };
}

function blank(): PiStatus {
  return { provider: "", modelId: "", label: "", thinkingLevel: null };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
