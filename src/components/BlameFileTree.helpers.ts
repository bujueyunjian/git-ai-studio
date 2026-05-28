// 抽出 BlameFileTree 的纯函数:buildTree / fuzzyMatch。
// 拆独立文件原因:react-refresh/only-export-components 要求组件文件不导出非组件值。

export interface TreeNode {
  name: string;
  fullPath: string;
  /** 仅目录有 children;文件是叶子(undefined)。 */
  children?: TreeNode[];
}

export function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: "", fullPath: "", children: [] };
  const dirMap = new Map<string, TreeNode>();
  dirMap.set("", root);
  for (const p of paths) {
    const segs = p.split("/");
    let parentPath = "";
    for (let i = 0; i < segs.length; i++) {
      const isFile = i === segs.length - 1;
      const seg = segs[i];
      const fullPath = parentPath ? `${parentPath}/${seg}` : seg;
      let node = dirMap.get(fullPath);
      if (!node) {
        node = { name: seg, fullPath };
        if (!isFile) node.children = [];
        dirMap.set(fullPath, node);
        const parent = dirMap.get(parentPath);
        if (parent && parent.children) parent.children.push(node);
      }
      parentPath = fullPath;
    }
  }
  const sortNode = (n: TreeNode) => {
    if (!n.children) return;
    n.children.sort((a, b) => {
      const aDir = !!a.children;
      const bDir = !!b.children;
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const c of n.children) sortNode(c);
  };
  sortNode(root);
  return root;
}

/** 模糊匹配:输入字串的所有字符按序出现在 fullPath 里(case-insensitive)。 */
export function fuzzyMatch(haystack: string, needle: string): boolean {
  if (!needle) return true;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  let i = 0;
  for (const c of n) {
    i = h.indexOf(c, i);
    if (i < 0) return false;
    i++;
  }
  return true;
}
