# Pi Harness（Obsidian 插件）

[English](README.md) | **简体中文**

在 Obsidian 里和你**本机的 pi agent** 对话 —— 手机端同样可用。agent 跑在 Termux 侧（那里才能真正 spawn 进程、用 skills、MCP 服务器和你的笔记库索引）；本插件是跟它对话的面板，也是唯一知道*你正在看哪篇笔记*的那一环。

```
Obsidian（本插件）                          Termux
  面板 + 上下文   ── ws ──►  pi-relay.mjs ── spawn ──►  pi --mode rpc
        ▲                                                        │
        └────────── 通过 WebSocket 传输 JSONL 记录 ◄──────────────┘
```

需要同机运行 `pi-relay` —— 源码见 [`relay/`](relay/)；用 `sh ~/pi-relay/start.sh` 启动（首次安装、包括 `token` 文件的生成，见 [relay/README.md](relay/README.md)（中文）/[relay/README.en.md](relay/README.en.md)（英文））。

## 安装

```sh
# 1. 中继（Termux 侧）
cp -r relay ~/pi-relay && cd ~/pi-relay && npm install && sh start.sh

# 2. 插件
npm install && npm run build
OBSIDIAN_VAULT="/storage/emulated/0/Obsidian Vault" npm run build   # 构建并直接拷进 vault
```

然后在 Obsidian → 设置 → 第三方插件里启用 **Pi Harness**（每次重新构建后要关掉再启用一次插件），从侧边栏图标打开面板，并确认插件设置里的中继地址和令牌与 `~/pi-relay/token` 一致。

## 为什么需要一个独立插件

移动端 Obsidian 插件**无法 spawn 进程**，所以 agent 必须活在外部。这样一来，能不能用得顺手取决于两件事：

1. **上下文。** pi 的工作方式是一个工作目录，而不是一个光标。你问「总结一下这篇笔记」，它并不知道「这篇」指什么。RPC 模式会拒绝 `@file` 参数（见 `pi docs/rpc.md`），所以当前笔记要作为显式的上下文前缀放进消息里（`src/core/context.ts`）。
2. **轻量。** pi 本身已经持久化对话，所以插件不另存一份记录 —— 它通过 `get_messages` 回放 pi 自己的记录，并实时渲染事件流。

## 功能

- **流式对话面板**：位于右侧边栏（侧边栏图标 / 命令面板均可打开），Markdown 交给 Obsidian 自带渲染器渲染。
- **附件上传**：📎 按钮可挂图片（以 pi 原生的图片内容形式发送，base64）和文件。库内文件直接引用路径；从手机选择器挑的文件先复制进库，再由 agent 用自己的工具去读。选中的附件以可逐个移除的 chip 显示在输入框上方。
- **感知当前笔记**：你进入面板前所在的笔记（以及其中的选中文本）会随每条消息一起送过去；具体送什么由设置决定（笔记路径 / 选中内容 / 全文）。用户自己的气泡会记下本条消息实际附带了什么。
- **回写笔记**：「写入当前笔记」——有选中内容就替换选区，否则插入到光标处。
- **工具卡片**：默认折叠、可展开，含参数、输出、错误样式；当工具调用涉及库内路径时，提供**打开**按钮。
- **模型 / 思考强度 chip**：直接驱动 pi（`set_model`、`set_thinking_level`）；**新建会话**会轮换 pi 的 session id。
- **断线自愈**：socket 断开（手机休眠、中继重启）后，下一条消息自动重连，且同一个 session id 会接着原来的对话继续。

## 设置

| 字段 | 说明 |
| --- | --- |
| relay 地址 | 中继与插件同机时用 `ws://127.0.0.1:8346` |
| relay 令牌 | 必须与 `~/pi-relay/token` 一致 |
| 工作目录 | vault 路径 —— pi 自己的工具在此读写；中继只接受白名单内的根目录 |
| 会话名称 / 会话 ID | 会话身份；面板上的新建对话按钮会轮换 id |
| 初始模型 / 思考强度 | 会话启动时交给 pi |
| 上下文三档 | 输入框上方 chip 的默认值 |

## 开发

```sh
npm install
npm run build          # 产出 main.js + styles.css
OBSIDIAN_VAULT="/storage/emulated/0/Obsidian Vault" npm run build   # 构建并拷进 vault
npm run typecheck
npx jest               # 单元测试（上下文 + 事件映射）
PI_RELAY_E2E=1 npx jest tests/e2e.test.ts   # 真实中继 + 一次真实 pi 交互
```

e2e 套件里的第二个用例是承重的那一个：它喂入 `buildPrompt` 生成的前缀，断言 pi 的回答里带上了被告知的笔记路径 —— 这正是本插件存在的意义所在。

## 环境要求

- **Termux 且已安装 pi**（`pi` 在 `PATH` 上）—— agent 跑在那边，只有那里能 spawn 进程、用 skills、MCP 服务器和你的笔记库索引。
- **中继在运行**：本仓库的 `~/pi-relay`，用 `sh ~/pi-relay/start.sh` 启动。
- Obsidian 1.7.2 及以上。支持移动端；Termux 侧细节见 [relay/README.md](relay/README.md)。

## 披露事项

上架 Obsidian 社区目录的硬性要求，也是装前该知道的：

- **网络使用**：插件只向设置里的中继地址开一条 WebSocket —— 默认 `ws://127.0.0.1:8346`，即你自己的设备。不访问任何外部服务，也不向别处发送数据。
- **库外访问**：用 📎 从手机选的文件会被**复制进库**（默认 `50-附件/pi-harness上传/`）以便 agent 读取；插件本身不触碰库外路径。但中继与 agent 运行在 Obsidian 之外、使用你配置的工作目录，你让它读写什么它就会读写什么。
- **剪贴板**：回答上的复制按钮会把该回答写入系统剪贴板，仅此而已；插件从不读取剪贴板内容。
- **无遥测、不自动更新、无广告**：插件不含任何统计，从不自动更新自身或依赖。`data.json` 保存设置，其中中继 token 为明文。
- **agent 不受插件沙箱约束**：你让 pi 做什么，它就以你 Termux 用户权限执行。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| `src/`、`manifest.json`、`esbuild.config.mjs` | Obsidian 插件本体（`npm run build` 产出 `main.js` + `styles.css`） |
| `relay/` | Termux 侧的 WebSocket 中继，负责把 Obsidian 接到 `pi --mode rpc`（端口 8346）。这是源码镜像；其 `token` 文件与日志**故意不入库** |
| `tests/` | Jest 测试，含一套 Obsidian API 的 mock |
| `scripts/sync-relay.sh` | 把正在运行的 `~/pi-relay` 同步进 `relay/` 并报告漂移（`--check` 只查不改） |

实际运行的中继在 `~/pi-relay`，`relay/` 只是镜像 —— 所以改完中继要跑一次 `sh scripts/sync-relay.sh`，review 差异后再提交。脚本还会把"它不认识的文件"列出来，而不是静默漏掉。

两半缺一不可：插件在移动端无法 spawn 进程，中继本身又没有界面。先在 Termux 装好中继，再把构建产物载入 vault。
