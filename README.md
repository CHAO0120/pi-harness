# Pi Harness (Obsidian plugin)

**English** | [简体中文](README.zh.md)

Chat with **your local pi agent** from inside Obsidian — phone included. The agent runs in Termux (where it can spawn processes, use skills, MCP servers and your vault index); this plugin is the panel that talks to it, and the part that knows *which note you are looking at*.

```
Obsidian (this plugin)                     Termux
  panel + context   ── ws ──►  pi-relay.mjs ── spawn ──►  pi --mode rpc
        ▲                                                        │
        └────────────── JSONL records over WebSocket ◄────────────┘
```

Requires `pi-relay` running on the same device — sources in [`relay/`](relay/); start it with `sh ~/pi-relay/start.sh` (see [relay/README.md](relay/README.md) (Chinese) or [relay/README.en.md](relay/README.en.md) for a first-time setup, including the token file).

## Install

```sh
# 1. relay, in Termux
cp -r relay ~/pi-relay && cd ~/pi-relay && npm install && sh start.sh

# 2. plugin
npm install && npm run build
OBSIDIAN_VAULT="/storage/emulated/0/Obsidian Vault" npm run build   # builds and copies into the vault
```

Then enable **Pi Harness** in Obsidian → Settings → Community plugins (restart the plugin after a rebuild), open the panel from the ribbon, and make sure the relay URL and token in the plugin settings match `~/pi-relay/token`.

## Why a plugin of its own

A mobile Obsidian plugin cannot spawn a process, so the agent has to live outside. Two things then decide whether the setup is usable:

1. **Context.** pi runs with a working directory, not a cursor. Asked "总结一下这篇笔记" it has no idea what "这篇" means. RPC mode rejects `@file` arguments (`pi docs/rpc.md`), so the active note travels inside the message as an explicit preamble (`src/core/context.ts`).
2. **Weight.** pi already persists the conversation, so the plugin does not keep a transcript — it replays pi's own (`get_messages`) and renders events as they stream.

## What it does

- **Streaming chat panel** in the right sidebar (ribbon icon / command palette), markdown rendered with Obsidian's own renderer.
- **Attachments** — the 📎 button attaches images (sent to pi as native image content, base64) and files. Vault files are referenced by path; files picked from the phone are copied into the vault first, so the agent reads them with its own tools. Staged as removable chips above the composer.
- **Active-note awareness** — the note the user came from (and their selection) is attached to every message; what gets attached is configured in settings (note path / selection / full body). The user's own bubble records what was attached.
- **Write back into the note** — 「写入当前笔记」 replaces the selection if there is one, otherwise inserts at the cursor.
- **Tool cards** — collapsed by default, expandable, with the arguments, the output, error styling, and an **打开** button when the call names a vault path.
- **Model / thinking chips** drive pi live (`set_model`, `set_thinking_level`); **new conversation** rotates the pi session id.
- Reconnects on the next message after the socket dies (phone sleeping, relay restart) — the same session id resumes the same conversation.

## Settings

| Field | Notes |
| --- | --- |
| relay 地址 | `ws://127.0.0.1:8346` when the relay is on the same device |
| relay 令牌 | must equal `~/pi-relay/token` |
| 工作目录 | the vault path — pi's own tools read and write here; the relay only accepts allowlisted roots |
| 会话名称 / 会话 ID | session identity; the panel's new-chat button rotates the id |
| 初始模型 / 思考强度 | handed to pi when a session starts |
| 上下文三档 | defaults for the composer chip |

## Development

```sh
npm install
npm run build          # writes main.js + styles.css
OBSIDIAN_VAULT="/storage/emulated/0/Obsidian Vault" npm run build   # and copies into the vault
npm run typecheck
npx jest               # unit tests (context + event mapping)
PI_RELAY_E2E=1 npx jest tests/e2e.test.ts   # live relay + a real pi turn
```

The e2e suite's second case is the load-bearing one: it feeds a `buildPrompt` preamble and asserts pi answers with the note path it was told, which is exactly the behaviour this plugin exists to provide.

## Repo layout

| Path | What it is |
| --- | --- |
| `src/`, `manifest.json`, `esbuild.config.mjs` | The Obsidian plugin (build with `npm run build` → `main.js` + `styles.css`) |
| `relay/` | The Termux-side WebSocket relay that bridges Obsidian to `pi --mode rpc` on port 8346 (source mirror; its `token` file and logs are intentionally not tracked) |
| `scripts/sync-relay.sh` | Mirrors the running `~/pi-relay` into `relay/` and reports drift (`--check` changes nothing) |
| `tests/` | Jest suites, including a mock of the Obsidian API |

The relay that actually runs lives in `~/pi-relay`; `relay/` is a mirror, so after touching the relay run `sh scripts/sync-relay.sh`, review the diff, and commit it. The script also names any file it does not know about rather than dropping it silently.

Neither half is useful alone: the plugin cannot spawn a process on mobile, and the relay has no UI. Install the relay in Termux, then load the built plugin into the vault.
