import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("initial interface language", () => {
  it.each([
    ["zh-CN", null, "zh-CN"],
    ["zh-TW", null, "zh-CN"],
    ["zh-Hant", null, "zh-CN"],
    ["en-US", null, "en"],
    ["fr-FR", null, "en"],
    ["C", null, "en"],
    ["", null, "en"],
    ["zh-CN", "en", "en"],
    ["en-US", "zh-CN", "zh-CN"],
    ["de-DE", "invalid", "en"],
  ])("system %s, saved %s selects %s", async (language, stored, expected) => {
    vi.resetModules();
    vi.stubGlobal("navigator", { language, languages: [language] });
    vi.stubGlobal("localStorage", { getItem: () => stored });
    const { default: i18n } = await import("../i18n");
    expect(i18n.language).toBe(expected);
    expect(i18n.t("common.cancel")).not.toBe("common.cancel");
  });
});
