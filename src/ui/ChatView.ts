import {
  ItemView,
  MarkdownRenderer,
  MarkdownView,
  Menu,
  Notice,
  TFile,
  WorkspaceLeaf,
} from "obsidian";

import { buildPrompt, type NoteContext } from "@/core/context";
import { debug } from "@/core/debug";
import { loadHistory, runTurn, toolFilePath, toolSummary, type PiEvent } from "@/core/loop";
import {
  availableModels,
  refreshStatus,
  setModel,
  setThinkingLevel,
  status,
  type PiModelInfo,
} from "@/core/session";
import type PiHarnessPlugin from "@/main";

export const VIEW_TYPE = "pi-harness-view";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const MODEL_MENU_LIMIT = 60;
/** Markdown re-render cadence while a reply streams — 4/s is smooth and cheap. */
const RENDER_THROTTLE_MS = 250;

/**
 * One streamed answer. Text segments are kept per position so a reply that
 * interleaves prose and tool calls still renders in the order it happened.
 */
interface Answer {
  root: HTMLElement;
  textEl: HTMLElement;
  /** Text of the segment currently being streamed. */
  segment: string;
  /** Everything the answer said, for copy/insert. */
  full: string;
  thinkingDetails: HTMLElement;
  thinkingEl: HTMLElement;
  thinking: string;
  toolsEl: HTMLElement;
  cards: Map<string, HTMLElement>;
  renderTimer: number | null;
  actionsEl: HTMLElement;
}

export class PiHarnessView extends ItemView {
  private listEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private stopButton!: HTMLButtonElement;
  private modelButton!: HTMLButtonElement;
  private modelLabelEl!: HTMLElement;
  private effortButton!: HTMLButtonElement;
  private effortLabelEl!: HTMLElement;

  private streaming = false;
  private abortController: AbortController | null = null;
  private historyLoaded = false;
  /**
   * The note the user was looking at before tapping into this panel. Obsidian
   * reports no active file while a sidebar panel has focus, so "the note" has
   * to be remembered rather than looked up at send time.
   */
  private lastNotePath: string | null = null;
  private lastNoteLeaf: WorkspaceLeaf | null = null;
  /** Records whether the Enter that produced a line break had Shift held. */
  private shiftHeld = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: PiHarnessPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Pi Harness";
  }

  getIcon(): string {
    return "bot";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("pi-harness-view");

    this.listEl = root.createDiv({ cls: "pi-harness-messages" });
    this.statusEl = root.createDiv({ cls: "pi-harness-status" });
    const composer = root.createDiv({ cls: "pi-harness-composer" });

    this.inputEl = composer.createEl("textarea", {
      cls: "pi-harness-input",
      attr: { rows: "1", placeholder: "问 PI（选中文字后提问，它会看到选中内容）" },
    });
    this.inputEl.addEventListener("input", () => this.autoResize());
    this.inputEl.addEventListener("keydown", (evt) => {
      this.shiftHeld = evt.shiftKey;
      if (evt.key !== "Enter") return;
      // Never fire while an IME is composing: committing a Chinese candidate
      // with Enter must not send half a sentence.
      if (evt.isComposing || evt.keyCode === 229) return;
      if (evt.shiftKey || evt.altKey) return; // Shift+Enter = newline
      if (!this.plugin.settings.enterToSend) return;
      evt.preventDefault();
      void this.send();
    });
    // Android soft keyboards often deliver the return key as a line break
    // without a keydown, so send from there too.
    this.inputEl.addEventListener("beforeinput", (evt) => {
      const input = evt as InputEvent;
      if (input.inputType !== "insertLineBreak" && input.inputType !== "insertParagraph") return;
      const shiftHeld = this.shiftHeld;
      this.shiftHeld = false;
      if (shiftHeld || input.isComposing) return;
      if (!this.plugin.settings.enterToSend) return;
      evt.preventDefault();
      void this.send();
    });

    const bar = composer.createDiv({ cls: "pi-harness-bar" });
    const newButton = bar.createEl("button", { cls: "pi-harness-icon", attr: { "aria-label": "新建会话" } });
    newButton.setText("✎");
    newButton.addEventListener("click", () => void this.newSession());

    this.modelButton = this.chip(bar, (evt) => void this.openModelMenu(evt));
    this.modelLabelEl = this.modelButton.querySelector(".pi-harness-chip-label") as HTMLElement;
    this.effortButton = this.chip(bar, (evt) => this.openEffortMenu(evt));
    this.effortLabelEl = this.effortButton.querySelector(".pi-harness-chip-label") as HTMLElement;

    this.sendButton = bar.createEl("button", { cls: "pi-harness-send", attr: { "aria-label": "发送" } });
    this.sendButton.createSpan({ cls: "pi-harness-send-glyph", text: "↑" });
    this.sendButton.addEventListener("click", () => void this.send());

    this.stopButton = bar.createEl("button", { cls: "pi-harness-stop", attr: { "aria-label": "停止" } });
    this.stopButton.createSpan({ cls: "pi-harness-send-glyph", text: "■" });
    this.stopButton.hide();
    this.stopButton.addEventListener("click", () => this.abortController?.abort());

    this.refreshChips();
    // Remember the note rather than asking for "the active file" later: while
    // this panel holds focus there is no active file at all.
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file) this.lastNotePath = file.path;
        this.refreshChips();
      }),
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf?.view instanceof MarkdownView) this.lastNoteLeaf = leaf;
        this.refreshChips();
      }),
    );
    this.setStatus("未连接 · 打开面板会先连一次 relay", true);
    this.seedRememberedNote();
    debug("view opened", { relay: this.plugin.settings.relayUrl, cwd: this.plugin.settings.cwd, session: this.plugin.settings.sessionId });
    void this.loadHistoryIntoView();
  }

  /**
   * Opened before the user touched anything: whatever note the workspace is
   * showing (or showed most recently) becomes the starting context.
   */
  private seedRememberedNote(): void {
    const active = this.app.workspace.getActiveFile();
    if (active) {
      this.lastNotePath = active.path;
      return;
    }
    const leaf = this.app.workspace.getMostRecentLeaf?.();
    if (leaf?.view instanceof MarkdownView) {
      this.lastNoteLeaf = leaf;
      this.lastNotePath = leaf.view.file?.path ?? this.lastNotePath;
    }
  }

  /**
   * One line above the transcript saying whether the relay is reachable and
   * which model is live. Silent failures were the hardest part of debugging
   * this on a phone, so the panel says out loud what it is doing.
   */
  private setStatus(text: string, warn = false): void {
    if (!this.statusEl) return;
    this.statusEl.setText(text);
    this.statusEl.toggleClass("is-warn", warn);
    debug("status:", text);
  }

  async onClose(): Promise<void> {
    this.abortController?.abort();
  }

  private chip(bar: HTMLElement, onClick: (evt: MouseEvent) => void): HTMLButtonElement {
    const button = bar.createEl("button", { cls: "pi-harness-chip" });
    button.createSpan({ cls: "pi-harness-chip-label", text: "…" });
    button.createSpan({ cls: "pi-harness-chip-caret", text: "▾" });
    button.addEventListener("click", onClick);
    return button;
  }

  // ------------- context -------------

  private activeFile(): TFile | null {
    const direct = this.app.workspace.getActiveFile();
    if (direct) return direct;
    const remembered = this.rememberedMarkdownView()?.file;
    if (remembered) return remembered;
    if (!this.lastNotePath) return null;
    const file = this.app.vault.getAbstractFileByPath(this.lastNotePath);
    return file instanceof TFile ? file : null;
  }

  /** The note's editor even when another leaf (this panel) has focus. */
  private activeEditor() {
    const focused = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (focused) return focused.editor;
    return this.rememberedMarkdownView()?.editor ?? null;
  }

  /**
   * The markdown leaf the user was last in, if Obsidian still has it open.
   * Membership is checked because a closed file's leaf object lingers.
   */
  private rememberedMarkdownView(): MarkdownView | null {
    const leaf = this.lastNoteLeaf;
    if (!leaf || !(leaf.view instanceof MarkdownView)) return null;
    const stillOpen = this.app.workspace
      .getLeavesOfType("markdown")
      .some((candidate: WorkspaceLeaf) => candidate === leaf);
    return stillOpen ? leaf.view : null;
  }

  /** What the agent gets told about the user's screen, right now. */
  private async collectContext(): Promise<NoteContext> {
    const file = this.activeFile();
    const { includePath, includeSelection, includeBody } = this.plugin.settings;
    if (!file || !includePath) {
      return { path: null, selection: null, body: null, includePath: false, includeSelection: false };
    }
    const selection = this.activeEditor()?.getSelection() ?? "";
    const body = includeBody ? await this.app.vault.cachedRead(file).catch(() => null) : null;
    return {
      path: file.path,
      selection: selection.trim() ? selection : null,
      body,
      includePath: true,
      includeSelection,
    };
  }

  refreshChips(): void {
    if (!this.modelButton) return;
    const info = status();
    const model = info?.label || this.plugin.settings.model || "pi 默认模型";
    this.modelLabelEl.setText(model.length > 20 ? `${model.slice(0, 20)}…` : model);
    this.effortLabelEl.setText(info?.thinkingLevel ?? this.plugin.settings.thinkingLevel ?? "默认");
  }

  // ------------- model / thinking -------------

  private async openModelMenu(evt: MouseEvent): Promise<void> {
    let models: PiModelInfo[];
    try {
      models = await availableModels(this.plugin.relaySettings(), true);
    } catch (error) {
      new Notice(`读取 pi 模型列表失败：${describe(error)}`);
      return;
    }
    const current = status();
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("模型").setIsLabel(true));
    for (const model of models.slice(0, MODEL_MENU_LIMIT)) {
      const title = model.name && model.name !== model.id ? `${model.name} — ${model.id}` : `${model.provider}/${model.id}`;
      menu.addItem((item) =>
        item
          .setTitle(title)
          .setChecked(current?.modelId === model.id && current?.provider === model.provider)
          .onClick(() => void this.applyModel(model)),
      );
    }
    menu.showAtMouseEvent(evt);
  }

  private async applyModel(model: PiModelInfo): Promise<void> {
    try {
      await setModel(this.plugin.relaySettings(), model.provider, model.id);
      // Remember it as the session's model too: after the phone sleeps the
      // socket dies and the relay restarts pi, which would otherwise come
      // back on pi's default model.
      this.plugin.settings.model = model.id;
      await this.plugin.saveSettings();
      this.refreshChips();
      new Notice(`已切到 ${model.name || model.id}`);
    } catch (error) {
      new Notice(`切换模型失败：${describe(error)}`);
    }
  }

  private openEffortMenu(evt: MouseEvent): void {
    const current = status()?.thinkingLevel ?? this.plugin.settings.thinkingLevel;
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("思考强度").setIsLabel(true));
    for (const level of THINKING_LEVELS) {
      menu.addItem((item) =>
        item
          .setTitle(level)
          .setChecked(level === current)
          .onClick(() => void this.applyEffort(level)),
      );
    }
    menu.showAtMouseEvent(evt);
  }

  private async applyEffort(level: string): Promise<void> {
    this.plugin.settings.thinkingLevel = level;
    await this.plugin.saveSettings();
    try {
      await setThinkingLevel(this.plugin.relaySettings(), level);
    } catch {
      // Still the default for the next session even if the live switch failed.
    }
    this.refreshChips();
  }

  // ------------- sending -------------

  private autoResize(): void {
    this.inputEl.style.height = "auto";
    this.inputEl.style.height = `${Math.min(this.inputEl.scrollHeight, 150)}px`;
  }

  private setStreaming(streaming: boolean): void {
    this.streaming = streaming;
    this.sendButton.toggle(!streaming);
    this.stopButton.toggle(streaming);
    this.modelButton.disabled = streaming;
    this.effortButton.disabled = streaming;
    // The textarea deliberately stays enabled: disabling it closes the soft
    // keyboard mid-answer, which is worse than letting the user type on.
  }

  private async send(): Promise<void> {
    if (this.streaming) {
      new Notice("PI 还在回答，等它说完再发（或点停止）");
      return;
    }
    const text = this.inputEl.value.trim();
    if (!text) return;

    this.inputEl.value = "";
    this.autoResize();
    debug("send", { chars: text.length });

    const bubble = this.renderUser(text);
    this.setStreaming(true);
    this.abortController = new AbortController();
    this.scrollToEnd();
    let answer: Answer | null = null;

    try {
      const context = await this.collectContext();
      debug("context", {
        path: context.path,
        selection: Boolean(context.selection),
        body: Boolean(context.body),
        activeFile: this.app.workspace.getActiveFile()?.path ?? null,
        remembered: this.lastNotePath,
      });
      this.attachContext(bubble, context);
      // The answer container must come after the user's bubble: it is created
      // only once the bubble is on screen.
      answer = this.beginAnswer();
      const prompt = buildPrompt(text, context);
      let failed = false;
      for await (const event of runTurn(prompt, this.plugin.relaySettings(), this.abortController.signal)) {
        if (event.kind === "error") failed = true;
        this.applyEvent(answer, event);
      }
      // Leaving the error text from the turn in place beats claiming "connected".
      if (!failed) this.setStatus(`已连接 · ${status()?.label ?? "pi"}`);
    } catch (error) {
      // Anything thrown here would otherwise be an unhandled rejection and
      // the panel would simply look dead.
      debug("send failed", String(error));
      this.renderError(`发送失败：${describe(error)}`);
      this.setStatus(`发送失败：${describe(error)}`, true);
    } finally {
      if (answer) this.finishAnswer(answer);
      this.setStreaming(false);
      this.abortController = null;
      this.refreshChips();
    }
  }

  private applyEvent(answer: Answer, event: PiEvent): void {
    switch (event.kind) {
      case "text":
        answer.segment += event.text;
        answer.full += event.text;
        this.scheduleRender(answer);
        break;
      case "thinking":
        answer.thinking += event.text;
        this.renderThinking(answer);
        break;
      case "tool-start":
        this.addToolCard(answer, event.id, event.name, event.args);
        break;
      case "tool-end":
        this.fillToolCard(answer, event.id, event.output, event.isError);
        break;
      case "error":
        debug("turn error", event.message);
        this.renderError(event.message);
        this.setStatus(event.message, true);
        break;
      case "settled":
        break;
    }
  }

  private beginAnswer(): Answer {
    const root = this.listEl.createDiv({ cls: "pi-harness-answer" });
    const thinkingDetails = root.createEl("details", { cls: "pi-harness-thinking" });
    thinkingDetails.createEl("summary", { text: "思考过程" });
    const thinkingEl = thinkingDetails.createDiv({ cls: "pi-harness-thinking-body" });
    thinkingDetails.hide();
    const textEl = root.createDiv({ cls: "pi-harness-markdown" });
    const toolsEl = root.createDiv({ cls: "pi-harness-tools" });
    const actionsEl = root.createDiv({ cls: "pi-harness-actions" });
    this.scrollToEnd();
    return {
      root,
      textEl,
      segment: "",
      full: "",
      thinkingDetails,
      thinkingEl,
      thinking: "",
      toolsEl,
      cards: new Map(),
      renderTimer: null,
      actionsEl,
    };
  }

  /** Text after a tool card belongs to a new element so ordering survives. */
  private startTextSegment(answer: Answer): void {
    answer.segment = "";
    answer.textEl = answer.root.createDiv({ cls: "pi-harness-markdown" });
    answer.root.insertBefore(answer.textEl, answer.toolsEl);
  }

  private scheduleRender(answer: Answer): void {
    if (answer.renderTimer !== null) return;
    answer.renderTimer = window.setTimeout(() => {
      answer.renderTimer = null;
      void this.renderSegment(answer);
    }, RENDER_THROTTLE_MS);
  }

  private async renderSegment(answer: Answer): Promise<void> {
    // MarkdownRenderer.render() appends; without emptying, every throttled
    // re-render during streaming stacks another copy of the growing answer.
    answer.textEl.empty();
    await MarkdownRenderer.render(this.app, answer.segment, answer.textEl, this.activeNotePath(), this);
    this.scrollToEnd();
  }

  private activeNotePath(): string {
    return this.activeFile()?.path ?? this.lastNotePath ?? "";
  }

  private renderThinking(answer: Answer): void {
    answer.thinkingEl.setText(answer.thinking);
    answer.thinkingDetails.show();
  }

  private addToolCard(answer: Answer, id: string, name: string, args: unknown): void {
    if (answer.renderTimer !== null) {
      window.clearTimeout(answer.renderTimer);
      answer.renderTimer = null;
      void this.renderSegment(answer);
    }
    const card = answer.toolsEl.createEl("details", { cls: "pi-harness-tool" });
    const summary = card.createEl("summary", { cls: "pi-harness-tool-summary" });
    summary.createSpan({ cls: "pi-harness-tool-name", text: name });
    const detail = toolSummary(name, args);
    if (detail) summary.createSpan({ cls: "pi-harness-tool-detail", text: detail });

    const path = toolFilePath(args);
    if (path) {
      const open = card.createEl("button", { cls: "pi-harness-tool-open", text: "打开" });
      open.addEventListener("click", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        void this.openVaultPath(path);
      });
    }
    card.createEl("pre", { cls: "pi-harness-pre", text: JSON.stringify(args ?? {}, null, 2) });
    card.createEl("pre", { cls: "pi-harness-pre pi-harness-tool-output", text: "运行中…" });
    answer.cards.set(id, card);
    this.startTextSegment(answer);
    this.scrollToEnd();
  }

  private fillToolCard(answer: Answer, id: string, output: string, isError: boolean): void {
    const card = answer.cards.get(id);
    if (!card) return;
    card.querySelector<HTMLElement>(".pi-harness-tool-output")?.setText(output);
    card.toggleClass("is-error", isError);
    this.scrollToEnd();
  }

  private finishAnswer(answer: Answer): void {
    if (answer.renderTimer !== null) {
      window.clearTimeout(answer.renderTimer);
      answer.renderTimer = null;
    }
    void this.renderSegment(answer);
    if (!answer.segment.trim()) answer.textEl.detach();

    if (answer.full.trim()) {
      const insert = answer.actionsEl.createEl("button", { cls: "pi-harness-action", text: "写入当前笔记" });
      insert.addEventListener("click", () => this.insertIntoNote(answer.full));
      const copy = answer.actionsEl.createEl("button", { cls: "pi-harness-action", text: "复制" });
      copy.addEventListener("click", () => {
        void navigator.clipboard.writeText(answer.full).then(
          () => new Notice("已复制"),
          () => new Notice("复制失败"),
        );
      });
    }
    this.scrollToEnd();
  }

  private renderUser(text: string): HTMLElement {
    const bubble = this.listEl.createDiv({ cls: "pi-harness-user" });
    bubble.createDiv({ cls: "pi-harness-user-text", text });
    this.scrollToEnd();
    return bubble;
  }

  /** Records what was attached under the user's own message. */
  private attachContext(bubble: HTMLElement, context: NoteContext): void {
    if (!context.includePath || !context.path) return;
    bubble.createDiv({
      cls: "pi-harness-user-context",
      text: `📄 ${context.path}${context.selection?.trim() ? "（含选中）" : ""}`,
    });
  }

  private renderError(text: string): void {
    this.listEl.createDiv({ cls: "pi-harness-error" }).setText(text);
    this.scrollToEnd();
  }

  /** Answer → note: replaces the selection when there is one, else appends at the cursor. */
  private insertIntoNote(markdown: string): void {
    const editor = this.activeEditor();
    if (!editor) {
      new Notice("先把光标放到一篇笔记里");
      return;
    }
    const selected = editor.getSelection();
    editor.replaceSelection(selected ? markdown : `\n${markdown}\n`);
    new Notice(selected ? "已替换选中内容" : "已插入到当前笔记");
  }

  private async openVaultPath(path: string): Promise<void> {
    const normalized = path.replace(/^\.\//, "");
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
    else new Notice(`库里找不到 ${normalized}`);
  }

  private scrollToEnd(): void {
    this.listEl.scrollTop = this.listEl.scrollHeight;
  }

  // ------------- session -------------

  private async newSession(): Promise<void> {
    if (this.streaming) return;
    await this.plugin.rotateSession();
    this.listEl.empty();
    this.historyLoaded = true;
    this.listEl.createDiv({ cls: "pi-harness-note", text: "已新建 pi 会话。" });
  }

  /** pi holds the conversation; on open we mirror it instead of persisting our own. */
  private async loadHistoryIntoView(): Promise<void> {
    if (this.historyLoaded) return;
    this.historyLoaded = true;
    try {
      await refreshStatus({ ...this.plugin.relaySettings(), thinkingLevel: this.plugin.settings.thinkingLevel });
      this.refreshChips();
      this.setStatus(`已连接 · ${status()?.label ?? "pi"}`);
      const history = await loadHistory(this.plugin.relaySettings());
      debug("history loaded", history.length);
      for (const message of history) {
        if (message.role === "user") {
          this.listEl
            .createDiv({ cls: "pi-harness-user" })
            .createDiv({ cls: "pi-harness-user-text", text: message.text });
          continue;
        }
        const root = this.listEl.createDiv({ cls: "pi-harness-answer" });
        for (const tool of message.tools) {
          const card = root.createEl("details", { cls: "pi-harness-tool" });
          card.createEl("summary", { text: `${tool.name} ${tool.summary}`.trim() });
        }
        if (message.text) {
          const el = root.createDiv({ cls: "pi-harness-markdown" });
          await MarkdownRenderer.render(this.app, message.text, el, this.activeNotePath(), this);
        }
      }
      this.scrollToEnd();
    } catch (error) {
      debug("history load failed", String(error));
      this.setStatus(`连不上 relay：${describe(error)}`, true);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
