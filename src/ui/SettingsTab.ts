import { App, Notice, PluginSettingTab, type SettingDefinitionItem } from "obsidian";

import { setDebugEnabled } from "@/core/debug";
import { refreshStatus, status } from "@/core/session";
import type PiHarnessPlugin from "@/main";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface PiHarnessSettings {
  /** e.g. ws://127.0.0.1:8346 — the pi-relay endpoint on this device. */
  relayUrl: string;
  /** Same value as ~/pi-relay/token. */
  token: string;
  /** pi's working directory: the vault, so its own tools can read the notes. */
  cwd: string;
  sessionId: string;
  sessionName: string;
  /** Model handed to pi when a session starts; empty = pi's default. */
  model: string;
  /** Default thinking level for new sessions. */
  thinkingLevel: string;
  /** Context defaults for the composer chip. */
  includePath: boolean;
  includeSelection: boolean;
  includeBody: boolean;
  /** Enter sends the message (Shift+Enter inserts a newline). */
  enterToSend: boolean;
  /** Append a debug log next to the plugin (used while wiring this up on a phone). */
  debug: boolean;
}

export const DEFAULT_SETTINGS: PiHarnessSettings = {
  relayUrl: "ws://127.0.0.1:8346",
  token: "",
  cwd: "/storage/emulated/0/Obsidian Vault",
  sessionId: "",
  sessionName: "obsidian",
  model: "",
  thinkingLevel: "medium",
  includePath: true,
  includeSelection: true,
  includeBody: false,
  enterToSend: true,
  debug: true,
};

export class PiHarnessSettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: PiHarnessPlugin,
  ) {
    super(app, plugin);
  }

  /**
   * The settings are declared once, here: Obsidian renders them, indexes them
   * for search, and keeps them in step with the rest of the app. Keys must
   * match DEFAULT_SETTINGS — `tests/settings-definitions.test.ts` fails if a
   * setting exists in one place and not the other.
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        type: "group",
        heading: "连接（pi-relay）",
        items: [
          {
            name: "relay 地址",
            desc: "本机 pi-relay 的 WebSocket 地址。同机部署用 127.0.0.1。",
            control: { type: "text", key: "relayUrl", placeholder: DEFAULT_SETTINGS.relayUrl },
          },
          {
            name: "relay 令牌",
            desc: "与 Termux 里 ~/pi-relay/token 一致。",
            control: { type: "secret", key: "token" },
          },
          {
            name: "工作目录",
            desc: "pi 的工作目录：填 vault 路径，pi 自己的工具才能读写笔记。relay 只接受白名单内的目录。",
            control: { type: "text", key: "cwd", placeholder: DEFAULT_SETTINGS.cwd },
          },
          { name: "会话名称", desc: "写入 pi 会话的显示名。", control: { type: "text", key: "sessionName" } },
          {
            name: "会话 ID",
            desc: "决定接哪个 pi 会话；面板里的「新建会话」按钮会换一个新的。",
            control: { type: "text", key: "sessionId" },
          },
          {
            name: "检查连接",
            desc: "连一次 relay 并读取 pi 当前模型。",
            action: (el) => {
              const button = el.createEl("button", { text: "检查" });
              button.addClass("mod-cta");
              // void: the listener must return void, the async work is its own.
              button.addEventListener("click", () => void this.checkConnection(button));
            },
          },
        ],
      },
      {
        type: "group",
        heading: "默认值",
        items: [
          {
            name: "初始模型",
            desc: "新会话启动时传给 pi；留空则用 pi 自己的默认模型。",
            control: { type: "text", key: "model" },
          },
          {
            name: "思考强度",
            desc: "新会话的默认 thinking level。",
            control: {
              type: "dropdown",
              key: "thinkingLevel",
              options: Object.fromEntries(THINKING_LEVELS.map((level) => [level, level])),
            },
          },
        ],
      },
      {
        type: "group",
        heading: "上下文",
        items: [
          {
            name: "附带当前笔记路径",
            desc: "提问时告诉 pi 你正在看哪篇笔记（默认开）。",
            control: { type: "toggle", key: "includePath" },
          },
          {
            name: "附带选中文本",
            desc: "有选中内容时把选中的文字一起发给 pi。",
            control: { type: "toggle", key: "includeSelection" },
          },
          {
            name: "附带笔记全文",
            desc: "连同整篇笔记内容一起发送；长笔记会截断。省 token 就不开。",
            control: { type: "toggle", key: "includeBody" },
          },
          {
            name: "回车发送",
            desc: "按回车直接发送，Shift+回车换行。关掉则回车只换行（手机上某些输入法需要重开面板才生效）。",
            control: { type: "toggle", key: "enterToSend" },
          },
        ],
      },
      {
        type: "group",
        heading: "诊断",
        items: [
          {
            name: "写调试日志",
            desc: `把面板与 relay 的往返写进 ${this.app.vault.configDir}/plugins/pi-harness/debug.log，排查问题时打开。`,
            control: { type: "toggle", key: "debug" },
          },
        ],
      },
    ];
  }

  /** Read by the framework for every `control` definition it renders. */
  getControlValue(key: string): unknown {
    return this.plugin.settings[key as keyof PiHarnessSettings];
  }

  /** The 检查连接 button: one connection attempt, reported through a Notice. */
  private async checkConnection(button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      await refreshStatus(this.plugin.relaySettings());
      const info = status();
      new Notice(info?.label ? `已连接，当前模型：${info.label}` : "已连接");
    } catch (error) {
      new Notice(`连接失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      button.disabled = false;
    }
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const settings = this.plugin.settings as unknown as Record<string, unknown>;
    if (!(key in settings)) return;
    settings[key] = value;
    if (key === "debug") setDebugEnabled(Boolean(value));
    await this.plugin.saveSettings();
  }
}
