import { PiEventMapper, toolFilePath, toolSummary } from "@/core/loop";
import type { PiRecord } from "@/core/relay";

const textDelta = (delta: string): PiRecord =>
  ({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } }) as PiRecord;
const thinkingDelta = (delta: string): PiRecord =>
  ({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta } }) as PiRecord;
const toolStart = (id: string, name: string, args: unknown): PiRecord =>
  ({ type: "tool_execution_start", toolCallId: id, toolName: name, args }) as PiRecord;
const toolEnd = (id: string, text: string, isError = false): PiRecord =>
  ({
    type: "tool_execution_end",
    toolCallId: id,
    isError,
    result: { content: [{ type: "text", text }] },
  }) as PiRecord;

describe("PiEventMapper", () => {
  test("separates answer text from thinking", () => {
    const mapper = new PiEventMapper();
    expect(mapper.push(textDelta("答"))).toEqual([{ kind: "text", text: "答" }]);
    expect(mapper.push(thinkingDelta("想"))).toEqual([{ kind: "thinking", text: "想" }]);
  });

  test("reports a tool's lifecycle with the originating name", () => {
    const mapper = new PiEventMapper();
    expect(mapper.push(toolStart("c1", "read", { path: "a.md" }))).toEqual([
      { kind: "tool-start", id: "c1", name: "read", args: { path: "a.md" } },
    ]);
    expect(mapper.push(toolEnd("c1", "file body"))).toEqual([
      { kind: "tool-end", id: "c1", name: "read", isError: false, output: "file body" },
    ]);
  });

  test("marks failed tools", () => {
    const mapper = new PiEventMapper();
    mapper.push(toolStart("c1", "bash", {}));
    expect(mapper.push(toolEnd("c1", "boom", true))[0]).toMatchObject({ kind: "tool-end", isError: true });
  });

  test("reports settlement with the abort flag", () => {
    const mapper = new PiEventMapper();
    expect(mapper.push({ type: "agent_settled", aborted: true } as PiRecord)).toEqual([
      { kind: "settled", aborted: true },
    ]);
  });

  test("turns failed commands and relay failures into errors", () => {
    const mapper = new PiEventMapper();
    expect(mapper.push({ type: "response", command: "prompt", success: false, error: "no model" } as PiRecord)).toEqual([
      { kind: "error", message: "no model" },
    ]);
    expect(mapper.push({ type: "relay", event: "disconnected" } as PiRecord)[0].kind).toBe("error");
    expect(mapper.push({ type: "relay", event: "bad_cwd", requested: "/etc" } as PiRecord)[0]).toMatchObject({
      message: expect.stringContaining("/etc"),
    });
  });

  test("ignores records the panel has nothing to show for", () => {
    const mapper = new PiEventMapper();
    expect(mapper.push({ type: "agent_start" } as PiRecord)).toEqual([]);
    expect(mapper.push({ type: "queue_update" } as PiRecord)).toEqual([]);
    expect(mapper.push({ type: "response", success: true, command: "get_state" } as PiRecord)).toEqual([]);
  });

  test("notes images in a tool result instead of dropping them silently", () => {
    const mapper = new PiEventMapper();
    mapper.push(toolStart("c1", "screenshot", {}));
    const [event] = mapper.push({
      type: "tool_execution_end",
      toolCallId: "c1",
      result: { content: [{ type: "image" }, { type: "text", text: "ok" }] },
    } as PiRecord);
    expect(event).toMatchObject({ kind: "tool-end", output: "ok\n[1 image(s)]" });
  });
});

describe("tool helpers", () => {
  test("summarises the interesting argument", () => {
    expect(toolSummary("bash", { command: "ls -la" })).toBe("ls -la");
    expect(toolSummary("read", { path: "20-运维/x.md" })).toBe("20-运维/x.md");
    expect(toolSummary("custom", {})).toBe("");
    expect(toolSummary("custom", { a: 1 })).toBe('{"a":1}');
  });

  test("finds a vault path to offer for opening", () => {
    expect(toolFilePath({ file_path: "x.md" })).toBe("x.md");
    expect(toolFilePath({ path: "https://example.com" })).toBeNull();
    expect(toolFilePath({ command: "ls" })).toBeNull();
  });
});
