import { buildPrompt, describeContext, type NoteContext } from "@/core/context";

const base: NoteContext = {
  path: "20-运维/经验/x.md",
  selection: null,
  body: null,
  includePath: true,
  includeSelection: true,
};

describe("buildPrompt", () => {
  test("attaches the active note path", () => {
    const prompt = buildPrompt("总结一下", base);
    expect(prompt).toContain("[Obsidian context]");
    expect(prompt).toContain("active note (vault-relative path): 20-运维/经验/x.md");
    expect(prompt).toContain("[User request]\n总结一下");
  });

  test("inlines the selection when there is one", () => {
    const prompt = buildPrompt("解释这段", { ...base, selection: "  目标：口径统一  " });
    expect(prompt).toContain("selected text in that note:");
    expect(prompt).toContain("目标：口径统一");
  });

  test("keeps the selection out when the toggle is off", () => {
    const prompt = buildPrompt("解释这段", { ...base, selection: "秘密", includeSelection: false });
    expect(prompt).not.toContain("秘密");
  });

  test("includes the body only when provided", () => {
    expect(buildPrompt("q", base)).not.toContain("full note content");
    expect(buildPrompt("q", { ...base, body: "# 标题\n正文" })).toContain("full note content:\n# 标题\n正文");
  });

  test("sends the bare request when there is no note or context is off", () => {
    expect(buildPrompt("你好", { ...base, path: null })).toBe("你好");
    expect(buildPrompt("你好", { ...base, includePath: false })).toBe("你好");
  });

  test("truncates a very long note so a single message cannot blow up the turn", () => {
    const prompt = buildPrompt("q", { ...base, body: "字".repeat(20_000) });
    expect(prompt).toContain("truncated");
    expect(prompt.length).toBeLessThan(20_000);
  });
});

describe("describeContext", () => {
  test("names the note, and the selection when present", () => {
    expect(describeContext(base)).toBe("x.md");
    expect(describeContext({ ...base, selection: "选中的话" })).toBe("x.md + 选中");
  });

  test("says so when nothing is attached", () => {
    expect(describeContext({ ...base, path: null })).toBe("未识别笔记");
    expect(describeContext({ ...base, includePath: false })).toBe("未识别笔记");
  });
});
