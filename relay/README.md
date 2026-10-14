# pi-relay

把**本机 pi**（Termux 侧）通过 WebSocket 暴露给**移动端 Obsidian 插件**（claudian-mobile 的 fork）。

```
Obsidian 安卓 (claudian-mobile fork)          Termux 侧
  PiProvider / WS 客户端  ──ws://127.0.0.1:8346──►  pi-relay.mjs
                                                      │ spawn `pi --mode rpc`
                                                      ▼
                                                    pi（完整 harness：vault MCP / skills / 扩展）
                                                      │
                                                      ▼ 直接读写
                                                    /storage/emulated/0/Obsidian Vault
```

跑在**同一台设备**上，所以不需要 Tailscale、不需要文件同步——pi 直接改本地 vault 文件。

## 为什么需要它

Obsidian 安卓端是 Capacitor WebView：**没有 Node、不能 spawn 进程**（这就是 `agent-client` 桌面插件无法直接上安卓的根因）。所以把"启动 agent"留在 Termux，插件只做一个 WS 客户端。pi 的 RPC 模式是纯 JSONL over stdio（`docs/rpc.md`），协议与传输无关，透传即可。

## 安装 / 启停

```sh
cd ~/pi-relay && npm install      # 仅依赖 ws
sh ~/pi-relay/start.sh            # 启动（已在跑则先杀再起）
curl -s http://127.0.0.1:8346/health
```

- 开机自启：`~/.termux/boot/25-pi-relay.sh`
- 日志：`~/pi-relay/logs/pi-relay.log`
- token：`~/pi-relay/token`（首次启动自动生成，0600）
- 端口：`PI_RELAY_PORT`（默认 8346，`8341` pi-gui / `8342` APK GUI / `8765` llm-proxy 已占）

## 连接 URL

```
ws://127.0.0.1:8346/?token=<token>
```

| 参数 | 说明 |
|---|---|
| `token` | 必填（或 `Authorization: Bearer`，浏览器 WS 只能用 query） |
| `session` | 会话 ID → `pi --session-id`；**重连即续聊**（实测通过） |
| `sessionFile` | 会话文件路径 → `pi --session` |
| `cwd` | 工作目录，必须落在 `PI_RELAY_ALLOW_ROOTS` 内（默认 vault / home / /storage/emulated/0） |
| `name` | 会话显示名 → `pi --name` |
| `model` / `thinking` / `tools` | 透传给 pi（`--model` / `--thinking` / `--tools`） |
| `noSession=1` | `--no-session`，不落盘 |
| `approve=1` | `--approve`，信任项目内文件 |

一个连接 = 一个 pi 进程；断开即 SIGTERM 回收（默认 `maxConns=2`）。同一 `session` 重连会接着原会话继续。

## 协议：WS 上就是 pi RPC 的 JSONL

- **客户端 → 服务端**：一条 WS 文本消息 = 一条 RPC 命令（`{"id":"p1","type":"prompt","message":"…"}`）
- **服务端 → 客户端**：每条 pi stdout 记录原样一条 WS 消息；另有 relay 自有事件
  `{"type":"relay","event":"ready|pi_spawn|pi_exit|pi_error|bad_frame|unauthorized|busy|bad_cwd", …}`（可用 `event` 字段与 pi 事件区分）

### 插件端要处理的事件（`docs/json.md` 为准）

| pi 事件 | 处理 |
|---|---|
| `message_update` + `assistantMessageEvent.type` | `text_delta`/`thinking_delta` 追加显示；`toolcall_delta` 忽略；用 `text_end`/`thinking_end`/`toolcall_end` 收敛，`message_end.message` 为最终权威 |
| `message_start` / `message_end` | 建立/收敛消息气泡 |
| `tool_execution_start/update/end` | 按 `toolCallId` 关联成内联工具卡；`end.result.content[].text` 是结果文本 |
| `turn_start` / `turn_end` | 一轮（含工具调用）开始/结束 |
| `agent_end` | 一次低层 run 结束，**可能还有重试/压缩/排队**，别在这里收尾 |
| `agent_settled` | 真正空闲：这时才结束"正在输入"、放开 composer |
| `extension_ui_request`（`setStatus`/`setWidget` 等） | 展示类，可忽略；不回应不会阻塞（实测 `setStatus`/`setWidget` 均无阻塞） |
| `queue_update` / `session_info_changed` / `thinking_level_changed` / `compaction_*` | 可选 UI 提示 |

命令面：`prompt`（流式中要带 `streamingBehavior: "steer"|"followUp"`）、`steer`、`follow_up`、`get_state`、`set_model`、中断类命令见 `docs/rpc-commands.md`。

## 自测

```sh
# 最小客户端：发一条 prompt 并打印事件流
node ~/pi-relay/pi-relay-cli.mjs "只回复：链路已通"
node ~/pi-relay/pi-relay-cli.mjs "接着上文回答" --session relaytest-001
node ~/pi-relay/pi-relay-cli.mjs --raw --timeout 20        # 只看原始记录

# 会话列表（插件会话选择器可复用）
curl -s "http://127.0.0.1:8346/sessions?token=$(cat ~/pi-relay/token)&limit=5"
```

已实测：prompt→流式→`agent_settled`（3.2s）；同 `session` 断开重连续聊（答出上文数字 42）；
断连后无残留 pi 进程；错误 token → 4001；越权 `cwd=/etc` → 4003。

## 安全

- 默认只绑 `127.0.0.1`。要跨设备用（如 Tailscale）才设 `PI_RELAY_HOST=0.0.0.0`，**务必确认 token 未泄漏**——relay 等于把本机 shell 能力交出去。
- `cwd` 白名单由 `PI_RELAY_ALLOW_ROOTS` 控制；token 用常量时间比较。
- 插件侧 token 存在 `data.json` 里（明文），别把 vault 同步到不受信任的地方。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PI_RELAY_HOST` / `PI_RELAY_PORT` | `127.0.0.1` / `8346` | 监听地址 |
| `PI_RELAY_TOKEN` | 文件 `./token` | 覆盖 token |
| `PI_RELAY_CWD` | vault | 默认工作目录 |
| `PI_RELAY_ALLOW_ROOTS` | vault\|home\|/storage/emulated/0 | `cwd` 白名单，`\|` 分隔 |
| `PI_RELAY_MAX_CONNS` | `2` | 并发连接上限 |
| `PI_RELAY_PI_BIN` / `PI_RELAY_PI_ARGS` | `pi` / 空 | pi 路径与附加参数 |
| `PI_RELAY_SESSION_DIR` | `~/.pi/agent/sessions` | `/sessions` 扫描目录 |
| `PI_RELAY_QUIET` | 空 | 非空则不打 stdout（只写日志） |

## 下一步（插件侧）

在 claudian-mobile fork 里加一个 `PiProvider`：沿用它的聊天面板/composer/diff 视图，只把"调 Anthropic API"换成"WS 上的 pi RPC"，事件按上表映射。原 Anthropic 直连路径保留为可切换后端。
