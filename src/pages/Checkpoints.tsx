// Checkpoints 页(P8):working dir 视角的 AI / 人类编辑 checkpoint 列表 + mock 调试入口。
//
// # 权威口径
// - jsonl 单文件:.git/ai/working_logs/<HEAD_SHA>/checkpoints.jsonl
// - schema 真源:git-ai/src/authorship/working_log.rs:8-167
// - CheckpointKind PascalCase("AiAgent"/"Human"/"AiTab"/"KnownHuman")
//
// # 范围
// - 仅主 worktree(isolated worktree 路径不同,P10 看)
// - 仅 HEAD(用户切 commit 不支持,P10 看)
// - mock_checkpoint 三 preset 全暴露(human / mock_ai / mock_known_human)
//
// # eager import(评审 C F22)
// 无重依赖,与 Notes / Dashboard 一致。

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertTriangle, FolderOpen, Loader2, Package, Plug, Wrench } from "lucide-react";
import { useEffect, useState } from "react";

import { CheckpointCard } from "../components/CheckpointCard";
import { EmptyState } from "../components/EmptyState";
import { MockCheckpointDialog } from "../components/MockCheckpointDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/DropdownMenuLite";
import { isMockRunning, listCheckpoints } from "../lib/api";
import { CHECKPOINTS_DEGRADED, CHECKPOINTS_EMPTY_LIST, CHECKPOINTS_HEADER } from "../lib/copy";
import type { CheckpointsResult, MockPreset } from "../lib/types";
import { useRouter } from "../router";

const STALE_TIME_MS = 30_000;

export default function CheckpointsPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [mockOpen, setMockOpen] = useState(false);
  const [mockPreset, setMockPreset] = useState<MockPreset>("mock_ai");
  const [now, setNow] = useState(() => Date.now());

  // 相对时间每 60s 刷一次
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const listQ = useQuery<CheckpointsResult>({
    queryKey: ["list_checkpoints"],
    queryFn: () => listCheckpoints(null),
    staleTime: STALE_TIME_MS,
  });

  const runningQ = useQuery<string | null>({
    queryKey: ["is_mock_running"],
    queryFn: isMockRunning,
    refetchInterval: 2_000,
  });

  if (listQ.data?.status === "degraded") {
    const reason = listQ.data.reason.kind;
    const copy = CHECKPOINTS_DEGRADED[reason];
    const ctaTarget: Record<typeof reason, "repo" | "install" | "hooks" | undefined> = {
      repo_missing: "repo",
      no_head: undefined,
      git_ai_missing: "install",
      working_logs_dir_missing: "hooks",
    };
    const target = ctaTarget[reason];
    return (
      <EmptyState
        Icon={
          reason === "repo_missing"
            ? FolderOpen
            : reason === "git_ai_missing"
              ? Package
              : reason === "working_logs_dir_missing"
                ? Plug
                : Activity
        }
        title={copy.title}
        description={copy.description}
        ctaLabel={copy.cta}
        onCta={target ? () => router.navigate(target) : undefined}
        tone="amber"
      />
    );
  }

  if (listQ.isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-500">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        正在读取 .git/ai/working_logs/&lt;HEAD&gt;/checkpoints.jsonl…
      </div>
    );
  }
  if (listQ.isError) {
    return (
      <div className="p-6">
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
          <AlertTriangle className="mr-2 inline h-4 w-4" />
          解析失败:{(listQ.error as Error).message}
        </div>
      </div>
    );
  }

  if (listQ.data?.status !== "ok") return null;
  const payload = listQ.data.payload;

  const onOpenMock = (preset: MockPreset) => {
    setMockPreset(preset);
    setMockOpen(true);
  };
  const onMockDone = () => {
    qc.invalidateQueries({ queryKey: ["list_checkpoints"] });
    qc.invalidateQueries({ queryKey: ["commit_stats"] });
    qc.invalidateQueries({ queryKey: ["get_history"] });
  };
  const onOpenBlame = (file: string) => router.navigate("blame", file);

  const isRunning = runningQ.data != null;

  return (
    <>
      <div className="space-y-4 p-6">
        <Header
          headSha={payload.head_sha}
          count={payload.checkpoints.length}
          onMockSelect={onOpenMock}
          mockDisabled={isRunning}
        />

        {payload.checkpoints.length === 0 ? (
          <EmptyList onGoHooks={() => router.navigate("hooks")} />
        ) : (
          <ul className="space-y-3">
            {payload.checkpoints.map((cp, i) => (
              <li key={`${cp.timestamp}-${i}`}>
                <CheckpointCard
                  checkpoint={cp}
                  isHead={true}
                  now={now}
                  defaultOpen={i === 0}
                  onOpenBlame={onOpenBlame}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <MockCheckpointDialog
        open={mockOpen}
        preset={mockPreset}
        onOpenChange={setMockOpen}
        onDone={onMockDone}
      />
    </>
  );
}

function Header({
  headSha,
  count,
  onMockSelect,
  mockDisabled,
}: {
  headSha: string;
  count: number;
  onMockSelect: (preset: MockPreset) => void;
  mockDisabled: boolean;
}) {
  return (
    <header className="sticky top-0 z-10 -mx-6 border-b border-slate-200 bg-white/95 px-6 py-3 backdrop-blur-sm dark:border-border dark:bg-background/95">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <h1 className="text-xl font-semibold">{CHECKPOINTS_HEADER.page_title}</h1>
          <p className="mt-0.5 text-xs text-slate-500">{CHECKPOINTS_HEADER.subtitle}</p>
          <div className="mt-2 flex items-center gap-3 text-[11px] text-slate-500">
            <code className="rounded-sm bg-slate-100 px-2 py-0.5 font-mono dark:bg-slate-800">
              {CHECKPOINTS_HEADER.head_sha_label} {headSha.slice(0, 12)}
            </code>
            <span>{CHECKPOINTS_HEADER.count_template(count)}</span>
          </div>
          <p className="mt-2 text-[11px] text-slate-400">{CHECKPOINTS_HEADER.pre_commit_note}</p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={mockDisabled}
              className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-800 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200"
            >
              <Wrench className="h-3.5 w-3.5" />
              {CHECKPOINTS_HEADER.debug_dropdown}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuLabel>mock_checkpoint(写盘)</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => onMockSelect("mock_ai")}>mock_ai</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onMockSelect("mock_known_human")}>
              mock_known_human
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onMockSelect("human")}>human</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

function EmptyList({ onGoHooks }: { onGoHooks: () => void }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-8 text-center dark:border-border dark:bg-card/40">
      <Activity className="mx-auto h-8 w-8 text-slate-400" />
      <div className="mt-3 text-base font-medium">{CHECKPOINTS_EMPTY_LIST.title}</div>
      <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
        {CHECKPOINTS_EMPTY_LIST.description}
      </p>
      <button
        type="button"
        onClick={onGoHooks}
        className="mt-4 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        {CHECKPOINTS_EMPTY_LIST.cta_hooks}
      </button>
    </div>
  );
}
