#!/usr/bin/env node
// pi-relay: WebSocket ↔ pi RPC 桥。
// 移动端插件（Obsidian 安卓）无法 spawn 进程，故由本进程在 Termux 侧 spawn `pi --mode rpc`，
// 把 stdin/stdout 的 JSONL 记录原样透传到 ws://127.0.0.1:<port>。
// 协议参考: pi docs rpc.md / rpc-commands.md
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const HOME = homedir();
const VAULT = '/storage/emulated/0/Obsidian Vault';

const cfg = {
  host: process.env.PI_RELAY_HOST || '127.0.0.1',
  port: Number(process.env.PI_RELAY_PORT || 8346),
  piBin: process.env.PI_RELAY_PI_BIN || 'pi',
  piArgs: (process.env.PI_RELAY_PI_ARGS || '').split(' ').filter(Boolean),
  sessionDir: process.env.PI_RELAY_SESSION_DIR || join(HOME, '.pi/agent/sessions'),
  defaultCwd: process.env.PI_RELAY_CWD || VAULT,
  maxConns: Number(process.env.PI_RELAY_MAX_CONNS || 2),
  idleKillMs: Number(process.env.PI_RELAY_IDLE_KILL_MS || 0), // 0 = 常驻，WS 断开即回收 pi
  logFile: process.env.PI_RELAY_LOG || join(HERE, 'logs/pi-relay.log'),
};

const ALLOW_ROOTS = (process.env.PI_RELAY_ALLOW_ROOTS || `${VAULT}|${HOME}|/storage/emulated/0`)
  .split('|').filter(Boolean).map((p) => resolve(p));

const TOKEN = loadToken();
const startedAt = Date.now();
const conns = new Set();
let seq = 0;

function loadToken() {
  if (process.env.PI_RELAY_TOKEN) return process.env.PI_RELAY_TOKEN;
  const f = join(HERE, 'token');
  if (existsSync(f)) return readFileSync(f, 'utf8').trim();
  const t = randomBytes(24).toString('base64url');
  writeFileSync(f, t + '\n', { mode: 0o600 });
  return t;
}

function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(' ')}`;
  try {
    mkdirSync(join(HERE, 'logs'), { recursive: true });
    appendFileSync(cfg.logFile, line + '\n');
  } catch {}
  if (!process.env.PI_RELAY_QUIET) console.log(line);
}

function tokenOk(given) {
  if (!given) return false;
  const a = createHash('sha256').update(String(given)).digest();
  const b = createHash('sha256').update(TOKEN).digest();
  return timingSafeEqual(a, b);
}

function resolveCwd(requested) {
  if (!requested) return cfg.defaultCwd;
  const abs = resolve(requested);
  const allowed = ALLOW_ROOTS.some((root) => abs === root || abs.startsWith(root + sep));
  return allowed ? abs : null;
}

function wsUrlToken(req, url) {
  const q = url.searchParams.get('token');
  if (q) return q;
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return req.headers['x-pi-token'] || null;
}

// —— 一个 WS 连接 = 一个 pi 进程 ——
class Session {
  constructor(ws, opts, req) {
    this.id = `c${++seq}`;
    this.ws = ws;
    this.opts = opts;
    this.remote = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
    this.decoder = new StringDecoder('utf8');
    this.buf = '';
    this.queue = [];
    this.draining = false;
    this.closed = false;
    this.alive = true;
    this.lastPingAt = 0;
    this.startedAt = Date.now();
    this.events = 0;
    this.spawnPi();
  }

  piArgsFor(opts) {
    const a = ['--mode', 'rpc'];
    if (opts.session) a.push('--session-id', opts.session);
    if (opts.sessionFile) a.push('--session', opts.sessionFile);
    if (opts.name) a.push('--name', opts.name);
    if (opts.model) a.push('--model', opts.model);
    if (opts.thinking) a.push('--thinking', opts.thinking);
    if (opts.tools) a.push('--tools', opts.tools);
    if (opts.noSession) a.push('--no-session');
    if (opts.sessionDir) a.push('--session-dir', opts.sessionDir);
    if (opts.approve) a.push('--approve');
    return [...a, ...cfg.piArgs];
  }

  spawnPi() {
    const args = this.piArgsFor(this.opts);
    this.pi = spawn(cfg.piBin, args, {
      cwd: this.opts.cwd,
      env: { ...process.env, PI_RELAY_CLIENT: this.id },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    log(`[${this.id}] pi spawned pid=${this.pi.pid} cwd=${this.opts.cwd} args=${args.join(' ')}`);
    this.notice('pi_spawn', { pid: this.pi.pid, cwd: this.opts.cwd, args });

    this.pi.stdout.on('data', (chunk) => this.onPiData(chunk));
    this.pi.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trimEnd();
      if (text) log(`[${this.id}] pi stderr: ${text.slice(0, 2000)}`);
    });
    this.pi.on('error', (err) => {
      log(`[${this.id}] pi error: ${err.message}`);
      this.notice('pi_error', { message: err.message });
      this.send({ type: 'relay', event: 'pi_error', message: err.message });
      this.close(1011, 'pi failed to start');
    });
    this.pi.on('exit', (code, signal) => {
      log(`[${this.id}] pi exited code=${code} signal=${signal}`);
      this.notice('pi_exit', { code, signal });
      if (!this.closed) {
        this.send({ type: 'relay', event: 'pi_exit', code, signal });
        this.close(1011, 'pi exited');
      }
    });
  }

  // pi stdout: 严格按 \n 分帧（不能用 readline，它会误切 U+2028/U+2029）
  onPiData(chunk) {
    this.buf += this.decoder.write(chunk);
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      let line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.trim()) this.sendRaw(line);
    }
  }

  sendRaw(line) {
    this.events++;
    this.send(line);
  }

  send(payload) {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    try {
      this.ws.send(text);
    } catch (err) {
      log(`[${this.id}] ws send failed: ${err.message}`);
    }
    // pi 尊重 stdout 背压：客户端消费不过来时先暂停 pi 输出
    if (this.ws.bufferedAmount > 1_000_000 && this.pi?.stdout) {
      this.pi.stdout.pause();
      const timer = setInterval(() => {
        if (this.closed || this.ws.bufferedAmount < 256 * 1024) {
          clearInterval(timer);
          if (!this.closed) this.pi?.stdout?.resume();
        }
      }, 20);
    }
  }

  notice(event, data) {
    this.send({ type: 'relay', event, ...data, session: this.id });
  }

  onClientMessage(text) {
    if (this.closed) return;
    if (this.pi.stdin.writableEnded) return;
    const ok = this.pi.stdin.write(text + '\n');
    if (!ok) {
      this.draining = true;
      this.pi.stdin.once('drain', () => {
        this.draining = false;
        const next = this.queue.shift();
        if (next !== undefined) this.onClientMessage(next);
      });
    }
  }

  ping() {
    if (this.closed) return;
    // A missed close event (or a socket the runtime already gave up on)
    // shows up as a non-OPEN readyState; treat it as gone.
    if (this.ws.readyState !== this.ws.OPEN) {
      log(`[${this.id}] socket not open (${this.ws.readyState}), reaping session`);
      return this.close(1001, 'socket gone');
    }
    if (!this.alive) {
      // Two intervals without a pong: the client is gone (app killed, wifi
      // dropped, process exited) and this pi process would otherwise hold a
      // slot forever.
      log(`[${this.id}] no pong, reaping session`);
      return this.close(1001, 'pong timeout');
    }
    this.alive = false;
    this.lastPingAt = Date.now();
    try { this.ws.ping(); } catch {}
  }

  pong() {
    this.alive = true;
    if (this.lastPingAt) {
      this.lastPingAt = 0;
      log(`[${this.id}] pong ok`);
    }
  }

  close(code, reason) {
    if (this.closed) return;
    this.closed = true;
    conns.delete(this);
    if (this.pi && this.pi.exitCode === null) {
      this.pi.kill('SIGTERM');
      const t = setTimeout(() => {
        if (this.pi && this.pi.exitCode === null) this.pi.kill('SIGKILL');
      }, 5000);
      t.unref?.();
    }
    try { this.ws.close(code, reason); } catch {}
    log(`[${this.id}] session closed (${reason || code}) events=${this.events} dur=${Date.now() - this.startedAt}ms`);
  }
}

const http = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      service: 'pi-relay',
      uptimeMs: Date.now() - startedAt,
      conns: conns.size,
      maxConns: cfg.maxConns,
      pi: cfg.piBin,
      sessionDir: cfg.sessionDir,
    }));
  }
  if (url.pathname === '/sessions') {
    if (!tokenOk(wsUrlToken(req, url))) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    }
    const cwd = resolveCwd(url.searchParams.get('cwd')) || cfg.defaultCwd;
    const limit = Number(url.searchParams.get('limit') || 30);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, cwd, sessions: listSessions(cwd, limit) }));
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('pi-relay — connect via ws://host:port/?token=<token>\n');
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found\n');
});

// pi 的会话文件名编码：/a/b → --a-b--；不如直接读 header 的 cwd 字段做归属判断
function listSessions(cwd, limit) {
  const out = [];
  let dirs = [];
  try { dirs = readdirSync(cfg.sessionDir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return out; }
  for (const d of dirs) {
    const dir = join(cfg.sessionDir, d.name);
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const path = join(dir, f);
      try {
        const st = statSync(path);
        const head = readFileSync(path, 'utf8').slice(0, 400_000).split('\n');
        const header = JSON.parse(head[0] || '{}');
        if (header.type !== 'session' || resolve(header.cwd || '') !== cwd) continue;
        let preview = '';
        for (const line of head) {
          if (!line.trim()) continue;
          try {
            const rec = JSON.parse(line);
            if (rec.type === 'message' && rec.message?.role === 'user') {
              const c = rec.message.content;
              preview = typeof c === 'string' ? c : (c || []).map((p) => p.text || '').join(' ');
              break;
            }
          } catch {}
        }
        out.push({
          id: header.id,
          file: path,
          timestamp: header.timestamp,
          mtime: st.mtimeMs,
          bytes: st.size,
          preview: preview.replace(/\s+/g, ' ').slice(0, 120),
        });
      } catch {}
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

const wss = new WebSocketServer({ server: http, maxPayload: 32 * 1024 * 1024 });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (payload) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(payload));

  if (!tokenOk(wsUrlToken(req, url))) {
    log(`rejected unauthorized connection from ${req.socket.remoteAddress}`);
    send({ type: 'relay', event: 'unauthorized' });
    return ws.close(4001, 'unauthorized');
  }
  if (conns.size >= cfg.maxConns) {
    log(`rejected: max conns (${cfg.maxConns}) reached`);
    send({ type: 'relay', event: 'busy', maxConns: cfg.maxConns });
    return ws.close(4002, 'busy');
  }
  const cwd = resolveCwd(url.searchParams.get('cwd'));
  if (cwd === null) {
    send({ type: 'relay', event: 'bad_cwd', requested: url.searchParams.get('cwd') });
    return ws.close(4003, 'cwd not allowed');
  }

  const session = new Session(ws, {
    cwd,
    session: url.searchParams.get('session') || undefined,
    sessionFile: url.searchParams.get('sessionFile') || undefined,
    name: url.searchParams.get('name') || undefined,
    model: url.searchParams.get('model') || undefined,
    thinking: url.searchParams.get('thinking') || undefined,
    tools: url.searchParams.get('tools') || undefined,
    sessionDir: url.searchParams.get('sessionDir') || undefined,
    noSession: url.searchParams.get('noSession') === '1',
    approve: url.searchParams.get('approve') === '1',
  }, req);
  conns.add(session);
  session.notice('ready', { token: 'ok', cwd });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const text = data.toString('utf8').trim();
    if (!text) return;
    let record;
    try {
      record = JSON.parse(text);
    } catch {
      return session.send({ type: 'relay', event: 'bad_frame', message: 'client must send one JSON object per message' });
    }
    // Client-side diagnostics: logged here rather than forwarded to pi, so a
    // phone whose console we cannot read still has a paper trail.
    if (record && record.type === 'relay_log') {
      log(`[${session.id}] client: ${String(record.message ?? '').slice(0, 2000)}`);
      return;
    }
    session.onClientMessage(text);
  });
  ws.on('pong', () => session.pong());
  ws.on('close', () => session.close(1000, 'client closed'));
  ws.on('error', (err) => log(`[${session.id}] ws error: ${err.message}`));
});

const HEARTBEAT_MS = Number(process.env.PI_RELAY_HEARTBEAT_MS || 30_000);
const heartbeat = setInterval(() => { for (const s of conns) s.ping(); }, HEARTBEAT_MS);
heartbeat.unref?.();

function shutdown(signal) {
  log(`shutting down (${signal})`);
  clearInterval(heartbeat);
  for (const s of conns) s.close(1001, 'server shutting down');
  wss.close(() => http.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 3000).unref?.();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => log(`unhandledRejection: ${err?.stack || err}`));
process.on('uncaughtException', (err) => log(`uncaughtException: ${err?.stack || err}`));

http.listen(cfg.port, cfg.host, () => {
  log(`pi-relay listening on ws://${cfg.host}:${cfg.port}/ (maxConns=${cfg.maxConns}, heartbeat=${HEARTBEAT_MS}ms, cwd=${cfg.defaultCwd})`);
  log(`token file: ${join(HERE, 'token')} — client URL: ws://${cfg.host}:${cfg.port}/?token=${TOKEN}`);
});
