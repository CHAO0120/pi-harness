/**
 * Live check against a running pi-relay + pi. Skipped unless asked:
 *
 *   PI_RELAY_E2E=1 npx jest tests/e2e.test.ts
 *
 * The second case is the one that matters for this plugin's reason to exist:
 * it proves pi actually receives the active-note context, i.e. that asking
 * about "this note" can resolve to a real file.
 */
import { readFileSync } from "node:fs";

import { buildPrompt } from "@/core/context";
import { runTurn } from "@/core/loop";
import { piRelay, type RelaySettings } from "@/core/session";

const enabled = process.env.PI_RELAY_E2E === "1";
const tokenPath = process.env.PI_RELAY_TOKEN_FILE ?? `${process.env.HOME}/pi-relay/token`;

(enabled ? describe : describe.skip)("pi-harness end to end", () => {
  const settings: RelaySettings = {
    url: process.env.PI_RELAY_URL ?? "ws://127.0.0.1:8346",
    token: readFileSync(tokenPath, "utf8").trim(),
    cwd: process.env.PI_RELAY_CWD ?? "/storage/emulated/0/Obsidian Vault",
    sessionId: `harness-e2e-${Date.now().toString(36)}`,
    sessionName: "harness-e2e",
  };

  afterAll(() => piRelay().disconnect());

  async function say(prompt: string): Promise<string> {
    const controller = new AbortController();
    let text = "";
    const errors: string[] = [];
    for await (const event of runTurn(prompt, settings, controller.signal)) {
      if (event.kind === "text") text += event.text;
      if (event.kind === "error") errors.push(event.message);
    }
    expect(errors).toEqual([]);
    return text;
  }

  test("answers a plain question", async () => {
    const text = await say("只回复四个字：面板已通");
    expect(text).toContain("面板已通");
  }, 180_000);

  test("sees the active note the composer attached", async () => {
    const prompt = buildPrompt("只回复我刚才给你的 active note 路径，不要其他内容", {
      path: "10-项目/企业园区/建诚A002/AGENTS.md",
      selection: null,
      body: null,
      includePath: true,
      includeSelection: true,
    });
    const text = await say(prompt);
    expect(text).toContain("建诚A002");
  }, 180_000);
});
