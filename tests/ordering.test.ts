/**
 * DOM-order regression tests. These mock the transport, so they run everywhere
 * and pin down the shape of the transcript: what the user typed comes first,
 * the answer container after it.
 */
import { MarkdownView, TFile, WorkspaceLeaf } from "obsidian";

import type { PiEvent } from "@/core/loop";
import { PiHarnessView } from "@/ui/ChatView";
import { DEFAULT_SETTINGS } from "@/ui/SettingsTab";
import PiHarnessPlugin from "@/main";

/**
 * Transport mock: a queue the test pushes into while a turn is running, so a
 * turn can be driven slowly enough to exercise streaming re-renders.
 * (`mockQueue` is named that way because jest hoists this factory.)
 */
const mockQueue: PiEvent[] = [];
const mockPrompts: string[] = [];
const mockWaiters: (() => void)[] = [];

function pushEvent(...items: PiEvent[]): void {
  mockQueue.push(...items);
  for (const wake of mockWaiters.splice(0)) wake();
}

function resetTransport(): void {
  mockQueue.length = 0;
  mockPrompts.length = 0;
}

jest.mock("@/core/loop", () => ({
  runTurn: (prompt: string) => {
    mockPrompts.push(prompt);
    return (async function* () {
      for (;;) {
        if (mockQueue.length === 0) {
          await new Promise<void>((resolve) => mockWaiters.push(resolve));
          continue;
        }
        const event = mockQueue.shift()!;
        yield event;
        if (event.kind === "settled") return;
      }
    })();
  },
  loadHistory: async () => [],
  toolSummary: () => "",
  toolFilePath: () => null,
}));

jest.mock("@/core/session", () => ({
  connect: async () => undefined,
  refreshStatus: async () => undefined,
  status: () => ({ label: "test-model" }),
  availableModels: async () => [],
  setModel: async () => undefined,
  setThinkingLevel: async () => undefined,
  isConnected: () => false,
  piRelay: () => ({ disconnect: () => undefined, send: () => undefined, request: async () => ({}) }),
}));

interface Internals {
  inputEl: HTMLTextAreaElement;
  listEl: HTMLElement;
  statusEl: HTMLElement;
  sendButton: HTMLButtonElement;
  stopButton: HTMLButtonElement;
  send(): Promise<void>;
}

function buildApp(note: TFile | null) {
  const leaf = new WorkspaceLeaf();
  const view = new MarkdownView(leaf);
  view.file = note;
  (leaf as unknown as { view: MarkdownView }).view = view;
  return {
    vault: {
      cachedRead: async () => "",
      getAbstractFileByPath: () => note,
      adapter: { append: async () => undefined },
    },
    workspace: {
      getActiveFile: () => null,
      getActiveViewOfType: () => null,
      on: () => ({}),
      getLeavesOfType: (type: string) => (type === "markdown" ? [leaf] : []),
      getMostRecentLeaf: () => leaf,
      getLeaf: () => ({ setViewState: async () => undefined, openFile: async () => undefined }),
      revealLeaf: async () => undefined,
    },
  };
}

async function openPanel(note: TFile | null): Promise<Internals> {
  const app = buildApp(note);
  const plugin = new PiHarnessPlugin(app as never, { version: "test" } as never);
  await plugin.onload();
  plugin.settings = { ...DEFAULT_SETTINGS, debug: false };
  const view = new PiHarnessView(new WorkspaceLeaf(), plugin);
  (view as unknown as { app: unknown }).app = app;
  await view.onOpen();
  return view as unknown as Internals;
}

const noteFile = new TFile();
noteFile.path = "20-运维/经验/x.md";

const tick = (): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, 20));

/** Android soft keyboards deliver the return key as a line break, no keydown. */
function fireBeforeInput(el: HTMLTextAreaElement, inputType: string): void {
  const event = new Event("beforeinput", { bubbles: true, cancelable: true }) as Event & {
    inputType?: string;
    isComposing?: boolean;
  };
  event.inputType = inputType;
  event.isComposing = false;
  el.dispatchEvent(event);
}

function pressEnter(el: HTMLTextAreaElement, shiftKey = false): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey, bubbles: true, cancelable: true }));
}

describe("transcript ordering", () => {
  beforeEach(() => resetTransport());

  test("user message is appended before the answer container", async () => {
    pushEvent({ kind: "text", text: "答" }, { kind: "settled", aborted: false });
    const view = await openPanel(noteFile);

    view.inputEl.value = "问";
    await view.send();

    const kinds = Array.from(view.listEl.children).map((el) => el.className);
    expect(kinds).toEqual(["pi-harness-user", "pi-harness-answer"]);
    expect(view.listEl.textContent).toContain("问");
    expect(view.listEl.textContent).toContain("答");
  });

  test("a second turn continues downward", async () => {
    pushEvent({ kind: "text", text: "答一" }, { kind: "settled", aborted: false });
    const view = await openPanel(noteFile);
    view.inputEl.value = "问一";
    await view.send();

    resetTransport();
    pushEvent({ kind: "text", text: "答二" }, { kind: "settled", aborted: false });
    view.inputEl.value = "问二";
    await view.send();

    const kinds = Array.from(view.listEl.children).map((el) => el.className);
    expect(kinds).toEqual([
      "pi-harness-user",
      "pi-harness-answer",
      "pi-harness-user",
      "pi-harness-answer",
    ]);
    const text = view.listEl.textContent ?? "";
    expect(text.indexOf("问二")).toBeLessThan(text.indexOf("答二"));
  });

  test("controls stay visible: the buttons carry their own glyphs", async () => {
    const view = await openPanel(noteFile);

    // Plain text, not setIcon(): an unavailable icon id draws an empty svg.
    expect((view.sendButton.textContent ?? "").trim()).toBe("↑");
    expect((view.stopButton.textContent ?? "").trim()).toBe("■");
    expect(view.sendButton.style.display).not.toBe("none");
    expect(view.stopButton.style.display).toBe("none");
  });

  test("the toolbar carries no note chip", async () => {
    const view = await openPanel(noteFile);
    const bar = view.listEl.parentElement?.querySelector(".pi-harness-bar");
    const labels = Array.from(bar?.querySelectorAll(".pi-harness-chip-label") ?? []).map((el) => el.textContent);

    // Model + thinking only: the note context is settings-driven now.
    expect(labels).toHaveLength(2);
    expect(labels.join()).not.toContain("x.md");
  });

  test("Enter sends; Shift+Enter keeps the newline behaviour", async () => {
    pushEvent({ kind: "text", text: "答" }, { kind: "settled", aborted: false });
    const view = await openPanel(noteFile);

    view.inputEl.value = "问";
    pressEnter(view.inputEl);
    await tick();
    expect(view.listEl.querySelectorAll(".pi-harness-user")).toHaveLength(1);

    view.inputEl.value = "第二问";
    pressEnter(view.inputEl, true);
    await tick();
    expect(view.listEl.querySelectorAll(".pi-harness-user")).toHaveLength(1);
    expect(view.inputEl.value).toBe("第二问");

    // The textarea keeps working after a turn, so the keyboard stays open.
    expect(view.inputEl.disabled).toBe(false);
  });

  test("the soft keyboard's return key sends as well", async () => {
    pushEvent({ kind: "text", text: "答" }, { kind: "settled", aborted: false });
    const view = await openPanel(noteFile);

    view.inputEl.value = "问";
    fireBeforeInput(view.inputEl, "insertLineBreak");
    await tick();
    expect(view.listEl.querySelectorAll(".pi-harness-user")).toHaveLength(1);
    expect(view.inputEl.value).toBe("");
  });

  test("a composing IME does not send half a sentence", async () => {
    pushEvent({ kind: "text", text: "答" }, { kind: "settled", aborted: false });
    const view = await openPanel(noteFile);

    view.inputEl.value = "问";
    view.inputEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }),
    );
    await tick();
    expect(view.listEl.querySelectorAll(".pi-harness-user")).toHaveLength(0);
    expect(view.inputEl.value).toBe("问");
  });

  test("Enter while PI is answering does not start a second turn", async () => {
    const view = await openPanel(noteFile);
    // Hold the view in the streaming state directly: the transport mock would
    // otherwise keep the turn open until it is told to settle.
    (view as unknown as { streaming: boolean }).streaming = true;
    view.inputEl.value = "插队";
    pressEnter(view.inputEl);
    await tick();
    expect(view.inputEl.value).toBe("插队");
    expect(view.listEl.querySelectorAll(".pi-harness-user")).toHaveLength(0);
  });

  test("streaming renders the answer once, not once per delta", async () => {
    const view = await openPanel(noteFile);
    view.inputEl.value = "问";

    // Drive a turn slowly enough that the streaming throttle re-renders
    // mid-answer; the mock's MarkdownRenderer appends, exactly like Obsidian's.
    const running = view.send();
    await tick();
    pushEvent({ kind: "text", text: "第一段" });
    await new Promise((r) => window.setTimeout(r, 320));
    pushEvent({ kind: "text", text: "第二段" });
    await new Promise((r) => window.setTimeout(r, 320));
    pushEvent({ kind: "settled", aborted: false });
    await running;

    const text = view.listEl.textContent ?? "";
    expect(text).toContain("第一段第二段");
    expect(text.indexOf("第一段")).toBe(text.lastIndexOf("第一段"));
  });

  test("the note context is attached to the user's own bubble", async () => {
    pushEvent({ kind: "text", text: "ok" }, { kind: "settled", aborted: false });
    const view = await openPanel(noteFile);

    view.inputEl.value = "问";
    await view.send();

    const bubble = view.listEl.querySelector(".pi-harness-user");
    expect(bubble?.querySelector(".pi-harness-user-context")?.textContent).toContain("x.md");
    expect(mockPrompts[0]).toContain("20-运维/经验/x.md");
  });

  test("a failing turn still leaves the bubble above the error", async () => {
    pushEvent({ kind: "error", message: "boom" }, { kind: "settled", aborted: false });
    const view = await openPanel(noteFile);

    view.inputEl.value = "问";
    await view.send();

    const kinds = Array.from(view.listEl.children).map((el) => el.className);
    expect(kinds[0]).toBe("pi-harness-user");
    expect(kinds).toContain("pi-harness-error");
    expect(view.statusEl.textContent).toContain("boom");
  });
});
