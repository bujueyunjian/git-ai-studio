import { useEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import i18n, { getCurrentLanguage } from "../i18n";

import { drawPet } from "../lib/petRenderer";
import {
  DEFAULT_PET_THEME_ID,
  PET_COMMAND_EVENT,
  PET_READY_EVENT,
  PET_STATE_EVENT,
  resolveTheme,
  visualForState,
} from "../lib/petState";
import type { PetStateKind, PetStatePayload, PetVisual } from "../lib/petState";

const INITIAL_STATE: PetStatePayload = {
  kind: "unknown",
  aiSharePercent: null,
  themeId: DEFAULT_PET_THEME_ID,
  opacity: 1,
  alertIntervalSec: 30,
  sizePx: 180,
  lang: getCurrentLanguage(),
};

/** 静态态(无脉冲 / 抖动 / 提醒)降到 ≈8fps 省 CPU。 */
const STATIC_FRAME_MS = 120;
/** 单次提醒脉冲的衰减时长(ms):attention 从 1 线性降到 0。 */
const ATTENTION_DECAY_MS = 1200;

/** 状态 → i18n key 映射(kind 是 snake_case 枚举值,i18n key 用项目惯例 camelCase)。 */
const STATE_LABEL_KEY: Record<PetStateKind, string> = {
  ok: "pet.states.ok",
  attributing: "pet.states.attributing",
  attribution_failed: "pet.states.attributionFailed",
  daemon_unhealthy: "pet.states.daemonUnhealthy",
  hook_missing: "pet.states.hookMissing",
  low_ai_share: "pet.states.lowAiShare",
  sleeping: "pet.states.sleeping",
  unknown: "pet.states.unknown",
};

/** 右键菜单项。action 回传主窗执行(open-main / cycle-theme / hide)。 */
const MENU_ITEMS: Array<{ action: "open-main" | "cycle-theme" | "hide"; labelKey: string }> = [
  { action: "open-main", labelKey: "pet.menu.openMain" },
  { action: "cycle-theme", labelKey: "pet.menu.cycleTheme" },
  { action: "hide", labelKey: "pet.menu.hide" },
];

/** 把交互意图回传主窗执行(单向数据流:pet 不直接改 state / 不操作主窗)。 */
function sendCommand(action: "open-main" | "cycle-theme" | "hide" | "open-diagnostic"): void {
  void emit(PET_COMMAND_EVENT, { action });
}

/**
 * pet 窗口根组件:listen 主窗 emit 的 PetState,Canvas 渲染角色图 + 双色信息环;支持拖拽、
 * hover 气泡、双击打开主窗、右键菜单。异常态弹常驻气泡 + 按间隔重复抖动提醒。
 * 纯渲染 + 转发交互意图 —— 不查数据、不直接改 state(ADR-011)。
 */
export function InkPetWindow() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // 渲染走 ref(rAF 高频读,不触发 React 重渲染);气泡走 state(低频,需要新鲜值)。
  const stateRef = useRef<PetStatePayload>(INITIAL_STATE);
  const [bubbleState, setBubbleState] = useState<PetStatePayload>(INITIAL_STATE);
  const [hovering, setHovering] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // 主题图片预加载缓存(主题切换时重建)。
  const imagesRef = useRef<Partial<Record<PetVisual, HTMLImageElement>>>({});
  // 提醒脉冲计时:本次脉冲起点 + 上一帧 kind(用于检测刚切入异常态)。
  const pulseStartRef = useRef<number>(-Infinity);
  const lastKindRef = useRef<PetStateKind>("unknown");
  const attentionRef = useRef(0);
  // 上次 mousedown 时间戳:手动判定双击(startDragging 会吞掉浏览器合成的 dblclick)。
  const lastDownRef = useRef(0);

  // pet 窗口背景必须透明(它加载与主窗同一 index.html / App.css,默认 body 有底色)。
  useEffect(() => {
    const prevBody = document.body.style.background;
    const prevHtml = document.documentElement.style.background;
    document.body.style.background = "transparent";
    document.documentElement.style.background = "transparent";
    return () => {
      document.body.style.background = prevBody;
      document.documentElement.style.background = prevHtml;
    };
  }, []);

  // 监听主窗推来的状态。pet 是独立 webview / 独立 i18n 实例,语言以主窗 payload 为准:
  // 与本窗当前语言不一致就 changeLanguage(下方 languageChanged 订阅会触发重渲染),
  // 否则右键菜单 / 气泡会停在 pet 窗启动时自行检测到的语言,和主窗切换后对不上。
  useEffect(() => {
    const unlistenP = listen<PetStatePayload>(PET_STATE_EVENT, (e) => {
      stateRef.current = e.payload;
      setBubbleState(e.payload);
      if (e.payload.lang !== getCurrentLanguage()) {
        void i18n.changeLanguage(e.payload.lang);
      }
    });
    return () => {
      unlistenP.then((un) => un()).catch(() => {});
    };
  }, []);

  // i18n.t() 非响应式:语言切换后需主动触发重渲染,菜单 / 气泡才会换文案(镜像 App.tsx)。
  const [, setLangTick] = useState(0);
  useEffect(() => {
    const handler = () => setLangTick((n) => n + 1);
    i18n.on("languageChanged", handler);
    return () => i18n.off("languageChanged", handler);
  }, []);

  // 挂载完成后通知主窗补发一次当前状态(否则要等主窗下一次心跳才同步)。
  useEffect(() => {
    void emit(PET_READY_EVENT);
  }, []);

  // 主题切换:预加载该主题的 4 张姿态图。
  useEffect(() => {
    const theme = resolveTheme(bubbleState.themeId);
    const map: Partial<Record<PetVisual, HTMLImageElement>> = {};
    (Object.keys(theme.images) as PetVisual[]).forEach((v) => {
      const img = new Image();
      img.src = theme.images[v];
      map[v] = img;
    });
    imagesRef.current = map;
  }, [bubbleState.themeId]);

  // 尺寸档位:调整窗口边长(画布 h-full/w-full 自适应跟随)。
  useEffect(() => {
    void getCurrentWindow()
      .setSize(new LogicalSize(bubbleState.sizePx, bubbleState.sizePx))
      .catch(() => {});
  }, [bubbleState.sizePx]);

  // Canvas 动画循环(挂载一次)。隐藏窗口时浏览器自动暂停 rAF,无需手动处理。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let lastDraw = -Infinity;
    const render = (t: number) => {
      raf = requestAnimationFrame(render);
      const s = stateRef.current;
      const visual = visualForState(s.kind, s.aiSharePercent);
      const dynamic = visual.pulse || visual.shake || visual.urgent;
      if (!dynamic && t - lastDraw < STATIC_FRAME_MS) return;
      lastDraw = t;

      // 提醒节拍:刚切入异常态、或到达重复间隔时,启动一次 attention 脉冲(1 → 0 衰减)。
      if (visual.urgent) {
        const intervalMs = s.alertIntervalSec > 0 ? s.alertIntervalSec * 1000 : Infinity;
        const justEntered = lastKindRef.current !== s.kind;
        const dueRepeat = t - pulseStartRef.current >= intervalMs;
        if (justEntered || dueRepeat) pulseStartRef.current = t;
        attentionRef.current = Math.max(0, 1 - (t - pulseStartRef.current) / ATTENTION_DECAY_MS);
      } else {
        attentionRef.current = 0;
        pulseStartRef.current = -Infinity;
      }
      lastKindRef.current = s.kind;

      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      const pxW = Math.round(cssW * dpr);
      const pxH = Math.round(cssH * dpr);
      if (canvas.width !== pxW || canvas.height !== pxH) {
        canvas.width = pxW;
        canvas.height = pxH;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const theme = resolveTheme(s.themeId);
      drawPet(ctx, {
        width: cssW,
        height: cssH,
        image: imagesRef.current[visual.visual] ?? null,
        visual,
        gauge: theme.gauge,
        aiSharePercent: s.aiSharePercent,
        timeMs: t,
        attention: attentionRef.current,
      });
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, []);

  // 无边框窗口靠在角色本体上按下来拖动整窗(菜单打开时不拖)。
  //
  // 双击检测靠两次 mousedown 间隔手动判定:canvas 一按下就 `startDragging()` 进入 OS 拖窗循环,
  // 会吞掉浏览器合成的 `dblclick` 事件(原 `onDoubleClick` 永不触发,表现为"双击没反应")。
  // 间隔内的第二次按下 → 当双击处理(urgent 态直达诊断,否则打开主窗),且本次不拖窗。
  const onPointerDown = (e: React.MouseEvent) => {
    if (menuOpen) return;
    const now = e.timeStamp;
    if (now - lastDownRef.current < 350) {
      lastDownRef.current = 0;
      const s = stateRef.current;
      const isUrgent = visualForState(s.kind, s.aiSharePercent).urgent;
      sendCommand(isUrgent ? "open-diagnostic" : "open-main");
      return; // 双击不触发拖窗
    }
    lastDownRef.current = now;
    void getCurrentWindow().startDragging();
  };

  // 异常态(urgent)气泡常驻;其余仅 hover 显示。
  const urgent = visualForState(bubbleState.kind, bubbleState.aiSharePercent).urgent;
  const showBubble = !menuOpen && (urgent || hovering);

  return (
    <div
      className="relative flex h-screen w-screen items-center justify-center bg-transparent"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => {
        setHovering(false);
        setMenuOpen(false);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuOpen(true);
      }}
    >
      {showBubble && (
        // 不换行、不截断:提示文案有限且短,字号收到 10px 后最长一条也能在窗口内放下;
        // hover / urgent 时整条完整显示(showBubble 已含 hover)。
        <div
          className={`pointer-events-none absolute left-1/2 top-1 z-10 max-w-[260px] -translate-x-1/2 whitespace-nowrap rounded-md px-2 py-1 text-center text-[10px] font-medium leading-snug shadow ${
            urgent ? "bg-red-600/90 text-white" : "bg-black/75 text-white"
          }`}
        >
          {i18n.t(STATE_LABEL_KEY[bubbleState.kind] as never)}
          {bubbleState.aiSharePercent !== null && ` · AI ${bubbleState.aiSharePercent}%`}
          {urgent && (
            <span className="mt-0.5 block text-[10px] font-normal opacity-90">
              {i18n.t("pet.bubble.urgentHint")}
            </span>
          )}
        </div>
      )}

      {menuOpen && (
        // w-max + whitespace-nowrap:菜单按内容自然宽度单行排布,不被 `left-1/2` 挤成半窗宽而折行
        // (与上方气泡同款处理);窗口最窄 140px 也能容下最长一项「显示主窗口」。
        <div className="absolute left-1/2 top-1 z-20 w-max -translate-x-1/2 overflow-hidden rounded-md border border-black/10 bg-white text-xs shadow-lg dark:border-white/10 dark:bg-neutral-800">
          {MENU_ITEMS.map((item) => (
            <button
              key={item.action}
              type="button"
              className="block w-full whitespace-nowrap px-3 py-1.5 text-left text-neutral-700 hover:bg-black/5 dark:text-neutral-200 dark:hover:bg-white/10"
              onClick={() => {
                sendCommand(item.action);
                setMenuOpen(false);
              }}
            >
              {i18n.t(item.labelKey as never)}
            </button>
          ))}
        </div>
      )}

      <canvas
        ref={canvasRef}
        onMouseDown={onPointerDown}
        style={{ opacity: bubbleState.opacity }}
        className="h-full w-full cursor-grab active:cursor-grabbing"
      />
    </div>
  );
}
