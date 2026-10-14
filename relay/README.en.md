# pi-relay

Expose the **local pi** (running in Termux) over WebSocket to the **mobile Obsidian plugin**.

> [简体中文](README.md) | English

```
Obsidian for Android (the pi-harness plugin)   Termux side
  panel / WS client  ──ws://127.0.0.1:8346──►  pi-relay.mjs
                                                 │ spawn `pi --mode rpc`
                                                 ▼
                                               pi (the full harness: vault MCP / skills / extensions)
                                                 │
                                                 ▼ read & write directly
                                               /storage/emulated/0/Obsidian Vault
```

It runs on the **same device**, so there is no Tailscale and no file syncing — pi edits the local vault files directly.

## Why it exists

Obsidian for Android is a Capacitor WebView: **no Node, no way to spawn a process** (which is why desktop-only plugins such as `agent-client` cannot work there). So "starting the agent" stays in Termux and the plugin is nothing but a WS client. pi's RPC mode is plain JSONL over stdio (`docs/rpc.md`), and the protocol does not care about the transport, so the relay just pipes it through.

## Install / start-stop

```sh
cd ~/pi-relay && npm install      # the only dependency is ws
sh ~/pi-relay/start.sh            # start (kills the old one first if running)
curl -s http://127.0.0.1:8346/health
```

- Autostart on boot: `~/.termux/boot/25-pi-relay.sh`
- Log: `~/pi-relay/logs/pi-relay.log`
- Token: `~/pi-relay/token` (generated on first start, mode 0600)
- Port: `PI_RELAY_PORT` (default 8346; 8341 pi-gui / 8342 APK GUI / 8765 llm-proxy are taken)

## Connection URL

```
ws://127.0.0.1:8346/?token=<token>
```

| Parameter | Meaning |
|---|---|
| `token` | Required (or `Authorization: Bearer`; a browser WS can only use the query string) |
| `session` | Session ID → `pi --session-id`; **reconnecting resumes the conversation** (verified) |
| `sessionFile` | Session file path → `pi --session` |
| `cwd` | Working directory; must sit inside `PI_RELAY_ALLOW_ROOTS` (default: vault / home / /storage/emulated/0) |
| `name` | Display name → `pi --name` |
| `model` / `thinking` / `tools` | Passed through to pi (`--model` / `--thinking` / `--tools`) |
| `noSession=1` | `--no-session`, nothing is persisted |
| `approve=1` | `--approve`, trust project files |

One connection = one pi process; closing it SIGTERMs the process (default `maxConns=2`). Reconnecting with the same `session` continues the original conversation.

## Protocol: the WS payload *is* pi RPC's JSONL

- **Client → server**: one WS text message = one RPC command (`{"id":"p1","type":"prompt","message":"…"}`)
- **Server → client**: one WS message per line of pi stdout, verbatim; plus relay's own events
  `{"type":"relay","event":"ready|pi_spawn|pi_exit|pi_error|bad_frame|unauthorized|busy|bad_cwd", …}` (distinguish them by the `event` field)

### Events the plugin has to handle (authority: `docs/json.md`)

| pi event | Handling |
|---|---|
| `message_update` + `assistantMessageEvent.type` | Append `text_delta`/`thinking_delta` to the display; ignore `toolcall_delta`; converge on `text_end`/`thinking_end`/`toolcall_end`; `message_end.message` is the final authority |
| `message_start` / `message_end` | Open / close a message bubble |
| `tool_execution_start/update/end` | Correlate into an inline tool card by `toolCallId`; `end.result.content[].text` is the result text |
| `turn_start` / `turn_end` | A turn (tool calls included) starts / ends |
| `agent_end` | A low-level run ended — **retries, compaction or queuing may still follow**; do not finish up here |
| `agent_settled` | Truly idle: only now clear the "typing" state and re-enable the composer |
| `extension_ui_request` (`setStatus`/`setWidget`, …) | Presentation only; safe to ignore — not answering does not block (verified for both) |
| `queue_update` / `session_info_changed` / `thinking_level_changed` / `compaction_*` | Optional UI hints |

Commands: `prompt` (while streaming, pass `streamingBehavior: "steer"|"followUp"`), `steer`, `follow_up`, `get_state`, `set_model`; see `docs/rpc-commands.md` for interrupt commands.

## Self-test

```sh
# Minimal client: send one prompt and print the event stream
node ~/pi-relay/pi-relay-cli.mjs "只回复：链路已通"
node ~/pi-relay/pi-relay-cli.mjs "接着上文回答" --session relaytest-001
node ~/pi-relay/pi-relay-cli.mjs --raw --timeout 20        # raw records only

# Session list (reusable by a plugin's session picker)
curl -s "http://127.0.0.1:8346/sessions?token=$(cat ~/pi-relay/token)&limit=5"
```

Verified: prompt → streaming → `agent_settled` (3.2s); reconnecting with the same `session` resumes (it answered with the number 42 from earlier); no stray pi process after disconnect; wrong token → 4001; out-of-bounds `cwd=/etc` → 4003.

## Security

- Binds to `127.0.0.1` only. To use it across devices (Tailscale, say) set `PI_RELAY_HOST=0.0.0.0` — and be certain the token has not leaked: the relay hands out shell capability on this machine.
- The `cwd` allowlist comes from `PI_RELAY_ALLOW_ROOTS`; tokens are compared in constant time.
- The plugin stores its token in `data.json` (plain text) — do not sync the vault somewhere untrusted.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PI_RELAY_HOST` / `PI_RELAY_PORT` | `127.0.0.1` / `8346` | Listen address |
| `PI_RELAY_TOKEN` | file `./token` | Overrides the token |
| `PI_RELAY_CWD` | vault | Default working directory |
| `PI_RELAY_ALLOW_ROOTS` | vault\|home\|/storage/emulated/0 | `cwd` allowlist, `\|`-separated |
| `PI_RELAY_MAX_CONNS` | `2` | Concurrent connection limit |
| `PI_RELAY_PI_BIN` / `PI_RELAY_PI_ARGS` | `pi` / empty | pi path and extra arguments |
| `PI_RELAY_SESSION_DIR` | `~/.pi/agent/sessions` | Directory scanned by `/sessions` |
| `PI_RELAY_QUIET` | empty | Non-empty: no stdout, log file only |
