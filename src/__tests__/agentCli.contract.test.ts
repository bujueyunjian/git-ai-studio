import { describe, expect, it } from "vitest";

import type { AgentCli, InstalledVersion, NpmStatus } from "../lib/types";

describe("Agent CLI install contract", () => {
  it("AgentCli 仅 ClaudeCode | Codex(对齐后端 agent_cli::AgentCli serde 名)", () => {
    const all: AgentCli[] = ["ClaudeCode", "Codex"];
    for (const a of all) expect(typeof a).toBe("string");
    expect(all).toHaveLength(2);
  });

  it("NpmStatus 形状对齐后端 commands::agent_cli::NpmStatus", () => {
    const missing: NpmStatus = { available: false, version: null, path: null };
    const present: NpmStatus = { available: true, version: "11.6.2", path: "/x/npm.cmd" };
    expect(missing.available).toBe(false);
    expect(present.version).toBe("11.6.2");
  });

  it("detect_agent_cli 复用 InstalledVersion(与 git-ai get_installed_version 同型)", () => {
    const installed: InstalledVersion = {
      installed: true,
      version: "2.1.165",
      binary_path: "/x/claude",
    };
    const none: InstalledVersion = { installed: false, version: null, binary_path: null };
    expect(installed.installed).toBe(true);
    expect(none.installed).toBe(false);
  });
});
