/**
 * Panel-level check: the real view, the real WebSocket client, the real relay
 * and a real pi turn — only Obsidian itself is mocked. Skipped unless asked:
 *
 *   PI_RELAY_E2E=1 npx jest tests/panel.test.ts
 *
 * This is the layer the unit tests cannot reach: DOM wiring, the composer,
 * streaming render, and the context the panel promises to attach.
 */
import { readFileSync } from "node:fs";

import { TFile, WorkspaceLeaf } from "obsidian";

import PiHarnessPlugin from "@/main";
import { piRelay } from "@/core/session";
import { DEFAULT_SETTINGS } from "@/ui/SettingsTab";
import { PiHarnessView } from "@/ui/ChatView";

const enabled = process.env.PI_RELAY_E2E === "1";
const tokenPath = process.env.PI_RELAY_TOKEN_FILE ?? `${process.env.HOME}/pi-relay/token`;
const NOTE_PATH = "10-项目/企业园区/建诚A002/AGENTS.md";

interface ViewInternals {
  inputEl: HTMLTextAreaElement;
  listEl: HTMLElement;
  statusEl: HTMLElement;
  send(): Promise<void>;
  streaming: boolean;
}

(enabled ? describe : describe.skip)("pi-harness panel", () => {
  const debugLines: string[] = [];
  const replaced: string[] = [];

  const activeFile = new TFile();
  activeFile.path = NOTE_PATH;
  activeFile.name = "AGENTS.md";

  const editor = {
    getSelection: () => "选中的一句话",
    replaceSelection: (text: string) => replaced.push(text),
  };

  const app = {
    vault: {
      cachedRead: async () => "note body",
      getAbstractFileByPath: () => null,
      adapter: {
        append: async (_path: string, line: string) => {
          debugLines.push(line);
        },
      },
    },
    workspace: {
      getActiveFile: () => activeFile,
      getActiveViewOfType: () => ({ editor }),
      on: () => ({}),
      getLeavesOfType: () => [] as unknown[],
      getLeaf: () => ({ setViewState: async () => undefined, openFile: async () => undefined }),
      revealLeaf: async () => undefined,
    },
  };

  let view: PiHarnessView;
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

    view = new PiHarnessView(new WorkspaceLeaf(), plugin);
    (view as unknown as { app: unknown }).app = app;
    await view.onOpen();
    internals = view as unknown as ViewInternals;
    // onOpen kicks the connect off in the background; give it a moment.
    await new Promise((r) => setTimeout(r, 3000));
  }, 120_000);

  afterAll(() => piRelay().disconnect());

  async function waitFor(check: () => boolean, ms = 90_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`timed out waiting; status = ${internals.statusEl.textContent}`);
  }

  test("opens a connected panel and renders a streamed answer", async () => {
    await waitFor(() => (internals.statusEl.textContent ?? "").includes("已连接"));

    internals.inputEl.value = "只回复四个字：面板已通";
    await internals.send();

    expect(internals.listEl.textContent).toContain("面板已通");
    expect(internals.statusEl.textContent).toContain("已连接");
    expect(debugLines.join("")).toContain("send");
  }, 180_000);

  test("attaches the active note and can write the answer back", async () => {
    internals.inputEl.value = "只回复我刚才给你的 active note 路径，不要其他内容";
    await internals.send();

    // The answer names the note the composer attached …
    expect(internals.listEl.textContent).toContain("建诚A002");
    // … and the user's own bubble records what was attached.
    expect(internals.listEl.textContent).toContain(NOTE_PATH);

    const writeBack = internals.listEl.querySelectorAll(".pi-harness-action");
    expect(writeBack.length).toBeGreaterThan(0);
    (writeBack[writeBack.length - 2] as HTMLButtonElement).click();
    expect(replaced[0]).toContain("建诚A002");
  }, 180_000);
});
