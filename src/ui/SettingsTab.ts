import { App, Notice, PluginSettingTab, Setting } from "obsidian";

import { setDebugEnabled } from "@/core/debug";
import { refreshStatus, status } from "@/core/session";
import type PiHarnessPlugin from "@/main";

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

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("连接（pi-relay）").setHeading();

    new Setting(containerEl)
      .setName("relay 地址")
      .setDesc("本机 pi-relay 的 WebSocket 地址。同机部署用 127.0.0.1。")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.relayUrl)
          .setValue(this.plugin.settings.relayUrl)
          .onChange(async (value) => {
            this.plugin.settings.relayUrl = value.trim() || DEFAULT_SETTINGS.relayUrl;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("relay 令牌")
      .setDesc("与 Termux 里 ~/pi-relay/token 一致。")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(this.plugin.settings.token).onChange(async (value) => {
          this.plugin.settings.token = value.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("工作目录")
      .setDesc("pi 的工作目录：填 vault 路径，pi 自己的工具才能读写笔记。relay 只接受白名单内的目录。")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.cwd)
          .setValue(this.plugin.settings.cwd)
          .onChange(async (value) => {
            this.plugin.settings.cwd = value.trim() || DEFAULT_SETTINGS.cwd;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("会话名称")
      .setDesc("写入 pi 会话的显示名。")
      .addText((text) =>
        text.setValue(this.plugin.settings.sessionName).onChange(async (value) => {
          this.plugin.settings.sessionName = value.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("会话 ID")
      .setDesc("决定接哪个 pi 会话；面板里的「新建会话」按钮会换一个新的。")
      .addText((text) =>
        text.setValue(this.plugin.settings.sessionId).onChange(async (value) => {
          this.plugin.settings.sessionId = value.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("检查连接")
      .setDesc("连一次 relay 并读取 pi 当前模型。")
      .addButton((button) =>
        button.setButtonText("检查").onClick(async () => {
          button.setDisabled(true);
          try {
            await refreshStatus(this.plugin.relaySettings());
            const info = status();
            new Notice(info?.label ? `已连接，当前模型：${info.label}` : "已连接");
          } catch (error) {
            new Notice(`连接失败：${error instanceof Error ? error.message : String(error)}`);
          } finally {
            button.setDisabled(false);
          }
        }),
      );

    new Setting(containerEl).setName("默认值").setHeading();

    new Setting(containerEl)
      .setName("初始模型")
      .setDesc("新会话启动时传给 pi；留空则用 pi 自己的默认模型。")
      .addText((text) =>
        text.setValue(this.plugin.settings.model).onChange(async (value) => {
          this.plugin.settings.model = value.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("思考强度")
      .setDesc("新会话的默认 thinking level。")
      .addDropdown((dropdown) => {
        for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
          dropdown.addOption(level, level);
        }
        dropdown.setValue(this.plugin.settings.thinkingLevel).onChange(async (value) => {
          this.plugin.settings.thinkingLevel = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl).setName("上下文").setHeading();

    const toggles: [keyof PiHarnessSettings, string, string][] = [
      ["includePath", "附带当前笔记路径", "提问时告诉 pi 你正在看哪篇笔记（默认开）。"],
      ["includeSelection", "附带选中文本", "有选中内容时把选中的文字一起发给 pi。"],
      ["includeBody", "附带笔记全文", "连同整篇笔记内容一起发送；长笔记会截断。省 token 就不开。"],
    ];
    for (const [key, name, desc] of toggles) {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.settings[key] as boolean).onChange(async (value) => {
            (this.plugin.settings[key] as boolean) = value;
            await this.plugin.saveSettings();
          }),
        );
    }

    new Setting(containerEl)
      .setName("回车发送")
      .setDesc("按回车直接发送，Shift+回车换行。关掉则回车只换行（手机上某些输入法需要重开面板才生效）。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enterToSend).onChange(async (value) => {
          this.plugin.settings.enterToSend = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName("诊断").setHeading();

    new Setting(containerEl)
      .setName("写调试日志")
      .setDesc(`把面板与 relay 的往返写进 ${this.app.vault.configDir}/plugins/pi-harness/debug.log，排查问题时打开。`)
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.debug).onChange(async (value) => {
          this.plugin.settings.debug = value;
          setDebugEnabled(value);
          await this.plugin.saveSettings();
        }),
      );
  }
}
