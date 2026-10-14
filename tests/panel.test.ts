/**
 * Panel-level check: the real view, the real WebSocket client, the real relay
 * and a real pi turn — only Obsidian itself is mocked. Skipped unless asked:
 *
 *   PI_RELAY_E2E=1 npx jest tests/panel.test.ts
 *
 * The workspace mock deliberately reports *no* active file and *no* active
 * markdown view, because that is the state once the user taps into a sidebar
 * panel. The panel must still know which note they came from.
 */
import { readFileSync } from "node:fs";

import { MarkdownView, TFile, WorkspaceLeaf } from "obsidian";

import { piRelay } from "@/core/session";
import PiHarnessPlugin from "@/main";
import { PiHarnessView } from "@/ui/ChatView";
import { DEFAULT_SETTINGS } from "@/ui/SettingsTab";

const enabled = process.env.PI_RELAY_E2E === "1";
const tokenPath = process.env.PI_RELAY_TOKEN_FILE ?? `${process.env.HOME}/pi-relay/token`;
const NOTE_PATH = "10-项目/企业园区/建诚A002/AGENTS.md";

interface ViewInternals {
  inputEl: HTMLTextAreaElement;
  listEl: HTMLElement;
  statusEl: HTMLElement;
  send(): Promise<void>;
}

(enabled ? describe : describe.skip)("pi-harness panel", () => {
  const debugLines: string[] = [];
  const replaced: string[] = [];
  const handlers: Record<string, (arg?: never) => void> = {};

  const noteFile = new TFile();
  noteFile.path = NOTE_PATH;
  noteFile.name = "AGENTS.md";

  const noteLeaf = new WorkspaceLeaf();
  const noteView = new MarkdownView(noteLeaf);
  (noteView as unknown as { editor: unknown }).editor = {
    getSelection: () => "选中的一句话",
    replaceSelection: (text: string) => {
      replaced.push(text);
    },
  };
  (noteLeaf as unknown as { view: MarkdownView }).view = noteView;

  const app = {
    vault: {
      cachedRead: async () => "note body",
      getAbstractFileByPath: (path: string) => (path === NOTE_PATH ? noteFile : null),
      adapter: {
        append: async (_path: string, line: string) => {
          debugLines.push(line);
        },
      },
    },
    workspace: {
      // Nothing is active: the panel itself holds focus.
      getActiveFile: () => null,
      getActiveViewOfType: () => null,
      on: (name: string, cb: (arg?: never) => void) => {
        handlers[name] = cb;
        return {};
      },
      getLeavesOfType: (type: string) => (type === "markdown" ? [noteLeaf] : []),
      getLeaf: () => ({ setViewState: async () => undefined, openFile: async () => undefined }),
      revealLeaf: async () => undefined,
      getMostRecentLeaf: () => noteLeaf,
    },
  };

  let internals: ViewInternals;

  beforeAll(async () => {
    const plugin = new PiHarnessPlugin(app as never, { version: "test" } as never);
    await plugin.onload();
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      token: readFileSync(tokenPath, "utf8").trim(),
      sessionId: `panel-${Date.now().toString(36)}`,
      sessionName: "panel-test",
    };

    const view = new PiHarnessView(new WorkspaceLeaf(), plugin);
    (view as unknown as { app: unknown }).app = app;
    await view.onOpen();
    internals = view as unknown as ViewInternals;

    // The user read a note, then tapped into the panel: the events fire, the
    // "active" lookups keep returning nothing.
    handlers["file-open"]?.(noteFile as never);
    handlers["active-leaf-change"]?.(noteLeaf as never);
  }, 120_000);

  afterAll(() => piRelay().disconnect());

  async function waitFor(check: () => boolean, ms = 90_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (check()) return;
      await new Promise((r) => window.setTimeout(r, 250));
    }
    throw new Error(`timed out; status = ${internals.statusEl.textContent}`);
  }

  test("knows the note the user came from, and streams an answer about it", async () => {
    await waitFor(() => (internals.statusEl.textContent ?? "").includes("已连接"));
    expect(internals.statusEl.textContent).toContain("已连接");

    internals.inputEl.value = "只回复我刚才给你的 active note 路径，不要其他内容";
    await internals.send();

    // Context reached pi: it echoes the path it was told.
    expect(internals.listEl.textContent).toContain("建诚A002");
    // And the bubble shows what was attached, note + selection.
    expect(internals.listEl.textContent).toContain(NOTE_PATH);
    expect(debugLines.join("")).toContain('"remembered":"10-项目/企业园区/建诚A002/AGENTS.md"');
  }, 180_000);

  test("writes the answer back into that note", async () => {
    const actions = internals.listEl.querySelectorAll(".pi-harness-action");
    expect(actions.length).toBeGreaterThan(0);
    (actions[actions.length - 2] as HTMLButtonElement).click();

    expect(replaced.join("")).toContain("建诚A002");
  }, 60_000);
});
