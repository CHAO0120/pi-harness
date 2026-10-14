/**
 * On-device diagnostics. A plugin that swallows an exception looks identical
 * to a plugin that does nothing, and the phone has no console worth reading,
 * so a plain log file inside the plugin folder is the only honest option.
 */
import type { App } from "obsidian";

/** The config folder is user-configurable, so never assume `.obsidian`. */
const logPath = (app: App): string => `${app.vault.configDir}/plugins/pi-harness/debug.log`;

let target: App | null = null;
let enabled = true;
let sink: ((message: string) => void) | null = null;

/**
 * Live channel for diagnostics raised while the relay is connected: they go
 * out as a `relay_log` frame and land in the relay's log file, which the
 * desktop side can actually read. The vault file stays as the offline record.
 */
export function setDebugSink(fn: ((message: string) => void) | null): void {
  sink = fn;
}

export function initDebug(app: App, on: boolean): void {
  target = app;
  enabled = on;
}

export function setDebugEnabled(on: boolean): void {
  enabled = on;
}

/** Never throws: logging must not be able to break a turn. */
export function debug(...parts: unknown[]): void {
  if (!enabled || !target) return;
  const stamp = new Date().toISOString().slice(11, 23);
  const body = parts
    .map((part) => {
      if (typeof part === "string") return part;
      try {
        return JSON.stringify(part);
      } catch {
        return String(part);
      }
    })
    .join(" ");
  sink?.(body);
  void target.vault.adapter.append(logPath(target), `${stamp} ${body}\n`).catch(() => undefined);
}
