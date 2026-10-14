/**
 * Transport to the Termux-side pi relay: one WebSocket text frame per pi RPC
 * record. An Obsidian plugin — on mobile above all — cannot spawn a process,
 * so the agent runs in Termux and this is the only thing that talks to it.
 *
 * Protocol: pi `docs/rpc.md` (JSONL records), `docs/json.md` (events).
 */

export type PiRecord = Record<string, unknown> & { type: string };

export interface RelayTarget {
  /** e.g. ws://127.0.0.1:8346 */
  url: string;
  token: string;
  cwd: string;
  sessionId: string;
  sessionName?: string;
}

export class RelayError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "RelayError";
  }
}

const CONNECT_TIMEOUT_MS = 10_000;
const POLL_MS = 40;

export class PiRelay {
  private socket: WebSocket | null = null;
  private readonly queue: PiRecord[] = [];
  private readonly waiting = new Map<string, (record: PiRecord) => void>();
  private seq = 0;
  private signature = "";

  get connected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  /** Opens a socket when there is none for this exact target; reuses it otherwise. */
  async ensure(target: RelayTarget): Promise<void> {
    const url = targetUrl(target);
    if (this.connected && this.signature === url) return;
    this.disconnect();
    await this.open(url);
    this.signature = url;
  }

  private open(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let opened = false;
      const socket = new WebSocket(url);
      this.socket = socket;
      const timer = window.setTimeout(() => {
        if (opened) return;
        this.disconnect();
        reject(new RelayError("relay connect timeout", url));
      }, CONNECT_TIMEOUT_MS);

      socket.onopen = () => {
        opened = true;
        window.clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {
        if (opened) return;
        window.clearTimeout(timer);
        reject(new RelayError("relay unreachable", url));
      };
      socket.onclose = (evt) => {
        if (this.socket === socket) this.socket = null;
        if (!opened) {
          window.clearTimeout(timer);
          reject(new RelayError("relay refused connection", `code ${evt.code}`));
          return;
        }
        // The relay kills its pi process with the socket, so a closed socket
        // is a fact the current turn must hear about.
        this.queue.push({ type: "relay", event: "disconnected", code: evt.code });
      };
      socket.onmessage = (evt: MessageEvent) => {
        if (typeof evt.data !== "string") return;
        for (const line of evt.data.split("\n")) {
          const text = line.trim();
          if (!text) continue;
          try {
            this.deliver(JSON.parse(text) as PiRecord);
          } catch {
            this.queue.push({ type: "relay", event: "bad_frame", message: text.slice(0, 300) });
          }
        }
      };
    });
  }

  private deliver(record: PiRecord): void {
    const id = typeof record.id === "string" ? record.id : "";
    if (record.type === "response" && id) {
      const resolve = this.waiting.get(id);
      if (resolve) {
        this.waiting.delete(id);
        resolve(record);
        return;
      }
    }
    this.queue.push(record);
  }

  send(record: Record<string, unknown>): void {
    if (!this.connected || !this.socket) throw new RelayError("relay not connected");
    this.socket.send(JSON.stringify(record));
  }

  /** Sends a command and resolves with its own `response` record. */
  request(record: Record<string, unknown>, timeoutMs = 30_000): Promise<PiRecord> {
    const id = `q${++this.seq}`;
    return new Promise<PiRecord>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.waiting.delete(id);
        reject(new RelayError("relay request timeout", String(record.type)));
      }, timeoutMs);
      this.waiting.set(id, (response) => {
        window.clearTimeout(timer);
        resolve(response);
      });
      this.send({ ...record, id });
    });
  }

  /** Records in arrival order, until the signal aborts or the relay goes quiet. */
  async *stream(signal: AbortSignal, idleTimeoutMs = 900_000): AsyncGenerator<PiRecord> {
    const deadline = Date.now() + idleTimeoutMs;
    for (;;) {
      const record = this.queue.shift();
      if (record) {
        yield record;
        continue;
      }
      if (signal.aborted) return;
      if (Date.now() > deadline) throw new RelayError("relay went quiet");
      await new Promise((r) => window.setTimeout(r, POLL_MS));
    }
  }

  /** Drops the socket and any in-flight request. */
  disconnect(): void {
    for (const [, resolve] of this.waiting) resolve({ type: "response", success: false, error: "relay disconnected" });
    this.waiting.clear();
    this.queue.length = 0;
    const socket = this.socket;
    this.socket = null;
    this.signature = "";
    if (!socket) return;
    socket.onopen = null;
    socket.onerror = null;
    socket.onmessage = null;
    socket.onclose = null;
    try {
      socket.close(1000, "client closing");
    } catch {
      // Already closed.
    }
  }
}

function targetUrl(target: RelayTarget): string {
  const query = new URLSearchParams({ token: target.token, cwd: target.cwd });
  if (target.sessionId) query.set("session", target.sessionId);
  if (target.sessionName) query.set("name", target.sessionName);
  return `${target.url.replace(/\/+$/, "")}/?${query.toString()}`;
}

/** `{"type":"response","success":false,"error":"…"}` → "…" */
export function responseError(record: PiRecord): string | null {
  if (record.type !== "response" || record.success !== false) return null;
  if (typeof record.error === "string" && record.error) return record.error;
  return typeof record.command === "string" ? `${record.command} failed` : "command failed";
}
