#!/usr/bin/env node
// pi-relay-cli: 最小 WS 客户端，用于验证 relay ↔ pi RPC 链路。
// 用法: node pi-relay-cli.mjs "写个 hello" [--url ws://127.0.0.1:8346] [--session <id>] [--raw] [--timeout 120]
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const VALUE_FLAGS = new Set(['url', 'token', 'session', 'name', 'timeout', 'cwd', 'model', 'thinking', 'tools']);
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { if (VALUE_FLAGS.has(a.slice(2))) i++; continue; }
  positional.push(a);
}
const prompt = positional.join(' ').trim();
const token = arg('token', existsSync(join(HERE, 'token')) ? readFileSync(join(HERE, 'token'), 'utf8').trim() : '');
const url = `${arg('url', 'ws://127.0.0.1:8346')}/?token=${encodeURIComponent(token)}` +
  (arg('session') ? `&session=${encodeURIComponent(arg('session'))}` : '') +
  (arg('cwd') ? `&cwd=${encodeURIComponent(arg('cwd'))}` : '') +
  (arg('model') ? `&model=${encodeURIComponent(arg('model'))}` : '') +
  (arg('thinking') ? `&thinking=${encodeURIComponent(arg('thinking'))}` : '') +
  (arg('tools') ? `&tools=${encodeURIComponent(arg('tools'))}` : '') +
  (arg('name') ? `&name=${encodeURIComponent(arg('name'))}` : '');
const timeoutMs = Number(arg('timeout', 180)) * 1000;
const raw = argv.includes('--raw');

const ws = new WebSocket(url);
let streamed = '';
const t0 = Date.now();
const stop = (code = 0) => { try { ws.close(); } catch {} ; console.log(`\n[cli] exit after ${((Date.now() - t0) / 1000).toFixed(1)}s`); process.exit(code); };
const timer = setTimeout(() => { console.log('\n[cli] timeout'); stop(2); }, timeoutMs);

ws.on('open', () => console.log(`[cli] connected ${url.replace(token, '***')}`));
ws.on('message', (data) => {
  const text = data.toString('utf8');
  if (raw) return console.log(`< ${text}`);
  let rec;
  try { rec = JSON.parse(text); } catch { return console.log(`< ${text}`); }
  switch (rec.type) {
    case 'relay':
      console.log(`[relay] ${rec.event}${rec.pid ? ` pid=${rec.pid}` : ''}${rec.message ? ` ${rec.message}` : ''}${rec.code !== undefined ? ` code=${rec.code}` : ''}`);
      if (rec.event === 'ready') {
        if (prompt) { console.log(`> ${prompt}`); ws.send(JSON.stringify({ id: 'p1', type: 'prompt', message: prompt })); }
        else console.log('[cli] no prompt given; sending get_state'); 
        if (!prompt) ws.send(JSON.stringify({ id: 's1', type: 'get_state' }));
      }
      break;
    case 'response':
      console.log(`[resp] ${rec.command} success=${rec.success}${rec.error ? ` error=${rec.error}` : ''}${rec.data ? ` ${JSON.stringify(rec.data).slice(0, 200)}` : ''}`);
      break;
    case 'message_update': {
      const e = rec.assistantMessageEvent || {};
      if (e.type === 'text_delta') { streamed += e.delta; process.stdout.write(e.delta); }
      else if (e.type === 'thinking_delta') process.stdout.write(`\x1b[2m${e.delta}\x1b[0m`);
      else if (e.type === 'text_end') streamed = e.content ?? streamed;
      else if (e.type === 'error') console.log(`\n[stream error] ${e.reason} ${e.error ?? ''}`);
      break;
    }
    case 'message_end':
      if (rec.message?.role === 'assistant') console.log(`\n[message_end role=assistant stop=${rec.message?.stopReason ?? '?'}]`);
      break;
    case 'extension_ui_request':
      console.log(`[ui_request] method=${rec.method ?? rec.request?.method ?? '?'} ${JSON.stringify(rec).slice(0, 220)}`);
      break;
    case 'tool_execution_start':
      console.log(`\n[tool] ${rec.toolName} ${JSON.stringify(rec.args ?? {}).slice(0, 160)}`);
      break;
    case 'tool_execution_end':
      console.log(`[tool:end] ${rec.toolName}${rec.isError ? ' ERROR' : ''}`);
      break;
    case 'agent_settled':
      console.log('\n[cli] agent_settled');
      clearTimeout(timer);
      return stop(0);
    case 'agent_end':
      console.log('[cli] agent_end');
      break;
    default:
      console.log(`[evt] ${rec.type}${rec.command ? ` ${rec.command}` : ''}`);
  }
});
ws.on('close', (code, reason) => { clearTimeout(timer); console.log(`[cli] closed ${code} ${reason || ''}`); process.exit(code === 1000 ? 0 : 1); });
ws.on('error', (err) => { clearTimeout(timer); console.error(`[cli] error: ${err.message}`); process.exit(1); });
