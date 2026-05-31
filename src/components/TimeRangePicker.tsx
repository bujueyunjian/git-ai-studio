// P11-A 时间筛选:9 个预设 + 自定义日期范围。
// 预设镜像 src-tauri/src/commands/history.rs::TimeRange,「自定义」走 Custom 变体。
//
// # 决策
// - 用 `<select>` 而非 9 个并排按钮:节省宽度,移动端友好(配合下次自适应)
// - "自定义" 选中后展开两个 `<input type="date">` + 应用按钮(原生 picker,不引日历库)
// - 跨度上限走 TIME_RANGE_CUSTOM_MAX_DAYS 校验
// - end < start 时禁用应用按钮

import { CalendarRange } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { TimeRange } from "../lib/types";

const CUSTOM_SENTINEL = "__custom__" as const;

/** 自定义区间跨度上限(天)。超过则禁用应用并提示。 */
const TIME_RANGE_CUSTOM_MAX_DAYS = 366;

/** 9 个时间预设:kind 镜像 history.rs::TimeRange,labelKey 运行时经 t() 取本地化文案。 */
const TIME_RANGE_PRESETS: ReadonlyArray<{ kind: string; labelKey: string }> = [
  { kind: "today", labelKey: "timeRange.presets.today" },
  { kind: "yesterday", labelKey: "timeRange.presets.yesterday" },
  { kind: "this_week", labelKey: "timeRange.presets.thisWeek" },
  { kind: "last_week", labelKey: "timeRange.presets.lastWeek" },
  { kind: "this_month", labelKey: "timeRange.presets.thisMonth" },
  { kind: "last_month", labelKey: "timeRange.presets.lastMonth" },
  { kind: "last_7_days", labelKey: "timeRange.presets.last7Days" },
  { kind: "last_30_days", labelKey: "timeRange.presets.last30Days" },
  { kind: "last_90_days", labelKey: "timeRange.presets.last90Days" },
];

/** 把 TimeRange 还原为下拉选中态(给当前 range 找最匹配的预设 kind)。 */
function rangeToSelectKey(r: TimeRange): string {
  if (r.kind === "custom") return CUSTOM_SENTINEL;
  if (r.kind === "last_n_days") {
    if (r.days === 7) return "last_7_days";
    if (r.days === 30) return "last_30_days";
    if (r.days === 90) return "last_90_days";
    // 落到这里说明上层传入了非 {7,30,90} 的 N —— 当前 9 个预设里没有对应 option,UI 会
    // 显示成"自定义",二义性。出现该警告时优先排查 last_n_days 的 days 来源是否被改过。
    console.warn(`[TimeRangePicker] last_n_days days=${r.days} 不在 {7,30,90},UI 将显示为自定义`);
    return CUSTOM_SENTINEL;
  }
  return r.kind;
}

/** 选中态 string → TimeRange 实际负载。Custom 走单独路径。 */
function selectKeyToRange(key: string): TimeRange | null {
  switch (key) {
    case "today":
      return { kind: "today" };
    case "yesterday":
      return { kind: "yesterday" };
    case "this_week":
      return { kind: "this_week" };
    case "last_week":
      return { kind: "last_week" };
    case "this_month":
      return { kind: "this_month" };
    case "last_month":
      return { kind: "last_month" };
    case "last_7_days":
      return { kind: "last_n_days", days: 7 };
    case "last_30_days":
      return { kind: "last_n_days", days: 30 };
    case "last_90_days":
      return { kind: "last_n_days", days: 90 };
    default:
      return null; // CUSTOM_SENTINEL — 由 Custom 输入区独立提交
  }
}

/** 把 YYYY-MM-DD 字符串(input[type=date] 值)解析为本地时区 unix_ms。 */
function dateInputToUnixMs(input: string, endOfDay: boolean): number | null {
  if (!input) return null;
  // input value 已是 YYYY-MM-DD;new Date('YYYY-MM-DD') 在 ES 中解析为 UTC 00:00,
  // 这里手工按本地 TZ 组装避免漂移。
  const [y, m, d] = input.split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  const dt = endOfDay ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d, 0, 0, 0, 0);
  return dt.getTime();
}

function unixMsToDateInput(ms: number): string {
  const dt = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

export function TimeRangePicker({
  value,
  onChange,
}: {
  value: TimeRange;
  onChange: (next: TimeRange) => void;
}) {
  const { t } = useTranslation();
  // # customModeOpen:UI 是否处于"自定义"展开态
  //
  // 历史 bug:select 点 "自定义" 时 selectKeyToRange 返回 null → 不调 onChange → value 没变 →
  // 受控 select 视觉立刻弹回原选项,日期输入框也不渲染。修复就是引入这个本地 state,
  // 它只在用户点击 dropdown 时被切换:
  //   - 选 CUSTOM_SENTINEL → setCustomModeOpen(true) 但不调 onChange(等用户填日期点应用)
  //   - 选任何预设      → setCustomModeOpen(false) 并调 onChange
  //
  // 与 value 关系:value.kind==='custom' 时 isCustom 也为真(即便 customModeOpen=false 也展开)。
  const [customModeOpen, setCustomModeOpen] = useState<boolean>(value.kind === "custom");
  const isCustom = customModeOpen || value.kind === "custom";
  // # selectKey:select 受控值
  //
  // customModeOpen 优先级最高 —— 否则用户点了"自定义"但 select 立刻弹回上一次预设(原 bug)。
  const selectKey = customModeOpen ? CUSTOM_SENTINEL : rangeToSelectKey(value);

  const initialCustom = useMemo(() => {
    if (value.kind === "custom") {
      return {
        start: unixMsToDateInput(value.start_unix_ms),
        end: unixMsToDateInput(value.end_unix_ms),
      };
    }
    // 默认填近 30 天作为 custom 模式起步
    const today = new Date();
    const thirtyDaysAgo = new Date(today);
    thirtyDaysAgo.setDate(today.getDate() - 30);
    return {
      start: unixMsToDateInput(thirtyDaysAgo.getTime()),
      end: unixMsToDateInput(today.getTime()),
    };
  }, [value]);

  const [customStart, setCustomStart] = useState(initialCustom.start);
  const [customEnd, setCustomEnd] = useState(initialCustom.end);

  // # 同步外部 value(custom 分支)→ 本地输入框
  //
  // useState 只在 mount 时抓拍 initialCustom,后续 value 变化不会再灌进 customStart/End。
  // 用户在外部场景(URL hash 同步 / 父组件 reset)把 value 切到一个新的 custom 范围时,
  // 输入框需要跟上,否则会出现"value 是 4/1-4/10 但输入框还是 5/1-5/10"的状态分裂。
  //
  // 只在 value.kind==='custom' 时同步,避免覆盖用户在自定义 UI 里的草稿(草稿不丢)。
  useEffect(() => {
    if (value.kind === "custom") {
      setCustomStart(unixMsToDateInput(value.start_unix_ms));
      setCustomEnd(unixMsToDateInput(value.end_unix_ms));
    }
  }, [value]);

  const customError = useMemo(() => {
    const startMs = dateInputToUnixMs(customStart, false);
    const endMs = dateInputToUnixMs(customEnd, true);
    if (startMs === null || endMs === null) return null; // 还没填完
    if (endMs < startMs) return t("timeRange.customInvalidRange");
    const spanDays = Math.ceil((endMs - startMs) / 86_400_000);
    if (spanDays > TIME_RANGE_CUSTOM_MAX_DAYS) {
      return t("timeRange.customTooWideTemplate", { max: TIME_RANGE_CUSTOM_MAX_DAYS });
    }
    return null;
  }, [customStart, customEnd, t]);

  const applyCustom = () => {
    const startMs = dateInputToUnixMs(customStart, false);
    const endMs = dateInputToUnixMs(customEnd, true);
    if (startMs === null || endMs === null || customError) return;
    onChange({ kind: "custom", start_unix_ms: startMs, end_unix_ms: endMs });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
        <CalendarRange className="h-3 w-3" />
        {t("timeRange.pickerLabel")}:
      </label>
      <select
        aria-label={t("timeRange.pickerLabel")}
        value={selectKey}
        onChange={(e) => {
          if (e.target.value === CUSTOM_SENTINEL) {
            // 切到自定义模式:展开输入框,不触发外部 onChange(等用户填日期点应用)
            setCustomModeOpen(true);
            return;
          }
          // 选回任一预设:关闭自定义模式,触发 onChange
          setCustomModeOpen(false);
          const next = selectKeyToRange(e.target.value);
          if (next) onChange(next);
        }}
        className="rounded-md border border-border bg-card px-2 py-1 text-xs shadow-xs"
      >
        {TIME_RANGE_PRESETS.map((p) => (
          <option key={p.kind} value={p.kind}>
            {t(p.labelKey as never)}
          </option>
        ))}
        <option value={CUSTOM_SENTINEL}>{t("timeRange.customLabel")}</option>
      </select>
      {isCustom && (
        <div className="flex flex-wrap items-center gap-1.5">
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            {t("timeRange.customStartLabel")}
            <input
              type="date"
              value={customStart}
              onChange={(e) => setCustomStart(e.target.value)}
              className="rounded-sm border border-border bg-card px-1.5 py-0.5 text-xs"
            />
          </label>
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            {t("timeRange.customEndLabel")}
            <input
              type="date"
              value={customEnd}
              onChange={(e) => setCustomEnd(e.target.value)}
              className="rounded-sm border border-border bg-card px-1.5 py-0.5 text-xs"
            />
          </label>
          <button
            type="button"
            onClick={applyCustom}
            disabled={customError !== null || !customStart || !customEnd}
            className="rounded-md bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("timeRange.customApply")}
          </button>
          {customError && <span className="text-[11px] text-danger">{customError}</span>}
        </div>
      )}
    </div>
  );
}
