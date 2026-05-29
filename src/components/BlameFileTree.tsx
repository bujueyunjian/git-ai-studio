// 扁平 file path 列表 → 折叠式树。
//
// # 渲染策略(评审 B #4)
// - 默认只展开"当前选中文件的祖先链",兄弟目录折叠
// - 顶部 fuzzy filter:命中时只渲染命中节点 + 祖先链,其它折叠
// - 不引入 react-window;1 万文件全展开 DOM > 1 万是 worst case,用户不会真去做

import { ChevronDown, ChevronRight, File as FileIcon, Folder } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { buildTree, fuzzyMatch, type TreeNode } from "./BlameFileTree.helpers";

export interface BlameFileTreeProps {
  files: string[];
  selected: string | null;
  onSelect: (file: string) => void;
}

export function BlameFileTree({ files, selected, onSelect }: BlameFileTreeProps) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState("");
  const tree = useMemo(() => buildTree(files), [files]);

  // 命中集 + 祖先链
  const visible = useMemo(() => {
    if (!filter.trim()) return null; // null = 全树,按选中链展开
    const hits = new Set<string>();
    for (const f of files) {
      if (fuzzyMatch(f, filter)) {
        hits.add(f);
        const segs = f.split("/");
        let p = "";
        for (let i = 0; i < segs.length - 1; i++) {
          p = p ? `${p}/${segs[i]}` : segs[i];
          hits.add(p);
        }
      }
    }
    return hits;
  }, [filter, files]);

  // 选中链(默认展开)
  const selectedAncestors = useMemo(() => {
    if (!selected) return new Set<string>();
    const set = new Set<string>();
    const segs = selected.split("/");
    let p = "";
    for (let i = 0; i < segs.length - 1; i++) {
      p = p ? `${p}/${segs[i]}` : segs[i];
      set.add(p);
    }
    return set;
  }, [selected]);

  return (
    <div className="flex h-full flex-col">
      <div className="p-2">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("blame.fileSearchPlaceholder")}
          className="w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-xs shadow-xs focus:border-primary focus:outline-hidden focus:ring-1 focus:ring-ring dark:border-border dark:bg-card"
        />
        <div className="mt-1 text-[10px] text-slate-400">
          {files.length === 0
            ? t("blame.fileListEmpty")
            : t("blame.fileListHintTemplate", { n: files.length })}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-1 pb-2">
        {tree.children && tree.children.length > 0 ? (
          <ul className="text-xs">
            {tree.children.map((c) => (
              <TreeItem
                key={c.fullPath}
                node={c}
                depth={0}
                selected={selected}
                onSelect={onSelect}
                visible={visible}
                selectedAncestors={selectedAncestors}
              />
            ))}
          </ul>
        ) : (
          <div className="px-2 py-4 text-center text-xs text-slate-400">
            {t("blame.fileListEmpty")}
          </div>
        )}
      </div>
    </div>
  );
}

function TreeItem({
  node,
  depth,
  selected,
  onSelect,
  visible,
  selectedAncestors,
}: {
  node: TreeNode;
  depth: number;
  selected: string | null;
  onSelect: (file: string) => void;
  visible: Set<string> | null;
  selectedAncestors: Set<string>;
}) {
  // 提到 early return 之前(react-hooks/rules-of-hooks)
  const [openLocal, setOpenLocal] = useState<boolean | null>(null);

  const isDir = !!node.children;
  const inHit = visible === null || visible.has(node.fullPath);
  if (!inHit) return null;

  const expandedByDefault =
    visible !== null /* 过滤态下命中全展开 */ || selectedAncestors.has(node.fullPath);
  const isOpen = openLocal === null ? expandedByDefault : openLocal;

  if (isDir) {
    return (
      <li>
        <button
          type="button"
          onClick={() => setOpenLocal(!isOpen)}
          className="flex w-full items-center gap-1 rounded-sm px-1 py-0.5 text-left hover:bg-accent"
          style={{ paddingLeft: depth * 12 + 4 }}
        >
          {isOpen ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-slate-400" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-slate-400" />
          )}
          <Folder className="h-3 w-3 shrink-0 text-amber-500" />
          <span className="truncate">{node.name}</span>
        </button>
        {isOpen && node.children && (
          <ul>
            {node.children.map((c) => (
              <TreeItem
                key={c.fullPath}
                node={c}
                depth={depth + 1}
                selected={selected}
                onSelect={onSelect}
                visible={visible}
                selectedAncestors={selectedAncestors}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }
  const isSelected = selected === node.fullPath;
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(node.fullPath)}
        aria-current={isSelected ? "true" : undefined}
        className={`flex w-full items-center gap-1 rounded px-1 py-0.5 text-left ${
          isSelected
            ? "bg-primary/10 text-primary dark:bg-primary/10 dark:text-primary"
            : "hover:bg-accent"
        }`}
        style={{ paddingLeft: depth * 12 + 16 }}
      >
        <FileIcon className="h-3 w-3 shrink-0 text-slate-400" />
        <span className="truncate" title={node.fullPath}>
          {node.name}
        </span>
      </button>
    </li>
  );
}
