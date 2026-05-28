import { describe, expect, it } from "vitest";

import type { AppSettingsPatch, HooksMode, HooksStatus, NotificationsConfig } from "../lib/types";

describe("Hooks contract", () => {
  it("HooksMode 仅 official | none 两态(对齐后端 hooks::model::HooksMode)", () => {
    const modes: HooksMode[] = ["official", "none"];
    for (const m of modes) {
      expect(typeof m).toBe("string");
    }
  });

  it("HooksStatus 仅含 mode 字段", () => {
    const s: HooksStatus = { mode: "official" };
    expect(s.mode).toBe("official");
  });

  it("AppSettingsPatch 支持 daemon 异常告警与低 AI 提醒总开关", () => {
    const patch: AppSettingsPatch = {
      daemon_unhealthy_alert: true,
      low_ai_share_enabled: true,
    };
    expect(patch.daemon_unhealthy_alert).toBe(true);
    expect(patch.low_ai_share_enabled).toBe(true);
  });

  it("AppSettingsPatch 支持低 AI 占比提醒对象和频率字段", () => {
    const patch: AppSettingsPatch = {
      low_ai_share_target_emails: ["alice@example.com"],
      low_ai_share_remind_interval_minutes: 15,
      low_ai_share_dismiss_minutes: 1440,
    };
    expect(patch.low_ai_share_target_emails).toEqual(["alice@example.com"]);
    expect(patch.low_ai_share_remind_interval_minutes).toBe(15);
    expect(patch.low_ai_share_dismiss_minutes).toBe(1440);
  });

  it("NotificationsConfig 字段精简后 daemon_unhealthy_alert 默认 false", () => {
    const n: NotificationsConfig = {
      cc_switch_auto_repair: false,
      low_ai_share: {
        enabled: false,
        threshold_percent: null,
        target_emails: [],
        remind_interval_minutes: null,
        dismiss_minutes: null,
        realtime_enabled: null,
      },
      daemon_unhealthy_alert: false,
    };
    expect(n.daemon_unhealthy_alert).toBe(false);
  });
});
