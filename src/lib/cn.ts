// 兼容 re-export:历史上 `cn` helper 住在这里,新 shadcn 标准位置是 `./utils`。
// 保留本文件让既有 `from "../lib/cn"` import 路径继续工作,内部统一指向 utils。
// 未来新增代码请直接 `import { cn } from "@/lib/utils"`(或相对路径),不要再加 cn.ts。
export { cn } from "./utils";
