/**
 * Live-model bookkeeping. These payloads are copied verbatim from a real relay
 * session: getting them wrong is what left the composer chip showing a model
 * that was no longer in use.
 */
import { noteRecord, noteThinkingLevel, status } from "@/core/session";

describe("noteRecord", () => {
  test("set_model replies with the model object itself", () => {
    noteRecord({
      id: "c",
      type: "response",
      command: "set_model",
      success: true,
      data: {
        id: "deepseek-flash",
        name: "DeepSeek V4.1-Flash (便宜)",
        reasoning: true,
        api: "openai-completions",
        provider: "deepseek",
        baseUrl: "https://api.deepseek.com",
      },
    });

    expect(status()?.modelId).toBe("deepseek-flash");
    expect(status()?.provider).toBe("deepseek");
    expect(status()?.label).toBe("DeepSeek V4.1-Flash (便宜)");
  });

  test("get_state nests the model and carries the thinking level", () => {
    noteRecord({
      type: "response",
      command: "get_state",
      success: true,
      data: {
        model: { id: "auto", name: "Auto (时段低价)", api: "pi-virtual", provider: "router" },
        thinkingLevel: "low",
        isStreaming: false,
      },
    });

    expect(status()?.modelId).toBe("auto");
    expect(status()?.label).toBe("Auto (时段低价)");
    expect(status()?.thinkingLevel).toBe("low");
  });

  test("set_thinking_level answers with success and no payload", () => {
    noteThinkingLevel("xhigh");
    expect(status()?.thinkingLevel).toBe("xhigh");
  });

  test("thinking_level_changed events are mirrored too", () => {
    noteRecord({ type: "thinking_level_changed", level: "minimal" });
    expect(status()?.thinkingLevel).toBe("minimal");
  });

  test("an assistant message names the model that actually answered", () => {
    noteRecord({
      type: "message_start",
      message: { role: "assistant", model: "deepseek-reasoner", provider: "deepseek" },
    });

    expect(status()?.label).toBe("deepseek-reasoner");
  });

  test("failed responses change nothing", () => {
    const before = status();
    noteRecord({ type: "response", command: "set_model", success: false, error: "nope" });
    expect(status()).toEqual(before);
  });
});
