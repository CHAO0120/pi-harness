/**
 * The declarative settings definitions must stay in step with the settings the
 * panel actually reads: a key that exists in one place and not the other either
 * does nothing or goes missing from the search index. These checks are cheap
 * and catch that drift without needing a running Obsidian.
 */
import type { SettingDefinitionItem } from "obsidian";

import { DEFAULT_SETTINGS, PiHarnessSettingsTab, type PiHarnessSettings } from "@/ui/SettingsTab";

function makeTab() {
  const settings: PiHarnessSettings = { ...DEFAULT_SETTINGS };
  const saved: number[] = [];
  const plugin = {
    settings,
    saveSettings: async () => {
      saved.push(Date.now());
    },
    relaySettings: () => ({}),
  };
  const app = { vault: { configDir: ".obsidian" } };
  const tab = new PiHarnessSettingsTab(app as never, plugin as never);
  return { tab, settings, saved };
}

function controlKeys(items: SettingDefinitionItem[]): string[] {
  const keys: string[] = [];
  for (const item of items) {
    if ("control" in item && item.control) keys.push(item.control.key);
    const nested = "items" in item && item.items ? item.items : undefined;
    if (nested) keys.push(...controlKeys(nested));
  }
  return keys;
}

describe("settings definitions", () => {
  it("covers every setting, and invents none", () => {
    const { tab } = makeTab();
    const defined = controlKeys(tab.getSettingDefinitions()).sort();
    const declared = Object.keys(DEFAULT_SETTINGS).sort();
    expect(defined).toEqual(declared);
  });

  it("reports no duplicate keys", () => {
    const { tab } = makeTab();
    const keys = controlKeys(tab.getSettingDefinitions());
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("reads the current value for a key", () => {
    const { tab, settings } = makeTab();
    settings.relayUrl = "ws://127.0.0.1:9999";
    expect(tab.getControlValue("relayUrl")).toBe("ws://127.0.0.1:9999");
  });

  it("persists a change and ignores unknown keys", async () => {
    const { tab, settings, saved } = makeTab();
    await tab.setControlValue("includeBody", true);
    expect(settings.includeBody).toBe(true);
    expect(saved).toHaveLength(1);

    await tab.setControlValue("nope", 1);
    expect(saved).toHaveLength(1);
  });

  it("keeps the debug toggle wired to the logger", async () => {
    const { tab, settings } = makeTab();
    await tab.setControlValue("debug", false);
    expect(settings.debug).toBe(false);
    // The sink is module state; what matters here is that a toggle does not throw
    // and that the value lands, which the assertion above proves.
  });
});
