import { Plugin, WorkspaceLeaf } from "obsidian";

import { disconnect, type RelaySettings } from "@/core/session";
import { PiHarnessView, VIEW_TYPE } from "@/ui/ChatView";
import { DEFAULT_SETTINGS, type PiHarnessSettings, PiHarnessSettingsTab } from "@/ui/SettingsTab";

export default class PiHarnessPlugin extends Plugin {
  settings: PiHarnessSettings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    await this.loadSettings();
    this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) => new PiHarnessView(leaf, this));
    this.addRibbonIcon("bot", "Pi Harness", () => void this.activateView());
    this.addCommand({
      id: "open-panel",
      name: "打开 Pi Harness 面板",
      callback: () => void this.activateView(),
    });
    this.addSettingTab(new PiHarnessSettingsTab(this.app, this));
  }

  onunload(): void {
    disconnect();
  }

  /** What the relay client needs; pi's own config stays in pi. */
  relaySettings(): RelaySettings {
    return {
      url: this.settings.relayUrl,
      token: this.settings.token,
      cwd: this.settings.cwd,
      sessionId: this.settings.sessionId,
      sessionName: this.settings.sessionName || undefined,
      model: this.settings.model || undefined,
    };
  }

  /** New conversation = a new pi session id, which needs a fresh socket. */
  async rotateSession(): Promise<void> {
    this.settings.sessionId = newSessionId();
    disconnect();
    await this.saveSettings();
  }

  async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) as { settings?: Partial<PiHarnessSettings> } | null;
    this.settings = { ...DEFAULT_SETTINGS, ...raw?.settings };
    if (!this.settings.relayUrl) this.settings.relayUrl = DEFAULT_SETTINGS.relayUrl;
    if (!this.settings.cwd) this.settings.cwd = DEFAULT_SETTINGS.cwd;
    // Seeded once and kept: reconnecting with the same id resumes the conversation.
    if (!this.settings.sessionId) this.settings.sessionId = newSessionId();
  }

  async saveSettings(): Promise<void> {
    await this.saveData({ ...(await this.loadData()), settings: this.settings });
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof PiHarnessView) leaf.view.refreshChips();
    }
  }

  private async activateView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (existing) {
      await workspace.revealLeaf(existing);
      return;
    }
    const leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    await workspace.revealLeaf(leaf);
  }
}

function newSessionId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `pi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
