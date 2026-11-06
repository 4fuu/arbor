/**
 * The prompt section and the model-facing text the plain-directory workspace
 * contributes (docs/workspaces.md#persistent-directories).
 *
 * Every fixed string this implementation writes lives here, in Chinese, one
 * entry per string: the prompt section that carries the method, the module
 * functions' descriptions and their results and refusals. The host merges this
 * table over its own when this implementation is the active workspace, so a
 * host that runs ovnfs never shows this method - the ovnfs workspace carries
 * its own, different text (packages/workspace-ovnfs/src/text.ts).
 *
 * Identifiers stay as they are: `workspace.keep`, `workspace.keeps`,
 * `workspace.path`, `keep`.
 */

import type { Block, BlockKindSpec, PromptSection, TextTable } from "@4fu/arbor-interfaces";

/** The plain-directory workspace's own fixed strings. */
export const directoryText: TextTable = {
  // ---- the prompt section the implementation contributes -----------------
  "workspace.method.directory": "你的工作区是本主机上的一个目录，随窗口创建；续窗口在原处继续用它，克隆的仓库、装好的依赖和未完成的工作都留着。",
  "workspace.method.persistent": "要留下跨窗口的内容，就用 workspace.keep(\"<名称>\") 建一个常驻目录：它在本主机的 {root}/keep/<名称>，不随窗口结束、回收和主机重启删除，后来的窗口用同一个名称找到它。",
  "workspace.method.persistent.plain": "常驻目录也可以用 bash 直接建：mkdir -p {root}/keep/<名称>；模块函数只是给出路径，并把它记进记录。",
  "workspace.method.persistent.shared": "常驻目录按约定共享：按名称写入它该放的内容，不要覆盖别人的东西。",
  "workspace.method.persistent.find": "用 workspace.keeps() 列出所有常驻目录，用 read、write、edit 和 bash 按路径直接用它；续窗口的首次输入会列出本窗口链建过的常驻目录。",
  "workspace.method.readonly": "按约定，别的窗口的目录只读，不要修改；要协作就靠仓库自己的流程（push、review、CI），框架不替你合并文件。",
  "workspace.method.means": "read、write、edit 和 bash 都在这个目录里工作，bash 也在这里跑后台作业。",

  // ---- the module functions this implementation adds --------------------
  "function.workspace.keep": "建一个常驻目录并返回它的路径：名称已存在时返回原来那个；里面的内容不随窗口结束、回收和主机重启删除。",
  "function.workspace.keeps": "列出所有常驻目录：名称和路径，按名称排序。",
  "function.workspace.path": "按窗口引用查询它的工作区目录：该目录属于其他窗口，只读，不要修改。",

  // ---- results ----------------------------------------------------------
  "result.workspace.keep": "常驻目录 {name}：{path}。它不随窗口结束、回收和主机重启删除，后来的窗口用同一个名称找到它。",
  "result.workspace.keeps": "常驻目录：{lines}",
  "result.workspace.keeps.empty": "还没有常驻目录；用 workspace.keep 建一个。",
  "result.workspace.keeps.line": "{name} {path}",
  "result.workspace.path": "{path}（窗口 {window} 的工作区，属于其他窗口：只读，不要修改）",

  // ---- refusals ---------------------------------------------------------
  "refused.workspace.keep.name": "常驻目录名 {name} 不符合约定：用小写字母或数字开头，只用小写字母、数字、.、_ 和 -，最长 64 个字符。",
  "refused.workspace.path": "窗口 {window} 没有工作区。",

  // ---- next actions -----------------------------------------------------
  "next.workspace.keep.name": "换一个名称，例如 build-cache 或 shared-notes。",
  "next.workspace.path": "该窗口没有操作过文件；用 windows.list 查看当前的窗口。",

  // ---- the continuation's first input -----------------------------------
  "continuation.keeps": "上个窗口链建过的常驻目录：{keeps}。它们不随窗口结束、回收和主机重启删除，按路径直接读写。",
};

/** The method's points, one text-table key per line, in order. */
const METHOD_LINES = [
  "workspace.method.directory",
  "workspace.method.persistent",
  "workspace.method.persistent.plain",
  "workspace.method.persistent.shared",
  "workspace.method.persistent.find",
  "workspace.method.readonly",
  "workspace.method.means",
] as const;

/** The one block kind the section renders: its lines, no tag, not data. */
export const DIRECTORY_METHOD_BLOCK: BlockKindSpec = {
  kind: "directory_method",
  data: false,
  fields: [{ name: "root", type: "string", required: true }],
  lines: [...METHOD_LINES],
};

/**
 * The plain-directory workspace's prompt section, with the root its
 * directories live under filled into the lines that name it - the same way the
 * ovnfs section fills in the shared folder.
 */
export function directorySection(root: string): PromptSection {
  const block: Block = { kind: "directory_method", fields: { root } };
  return {
    tag: "workspace",
    blocks: [DIRECTORY_METHOD_BLOCK],
    text: directoryText,
    content: (): readonly Block[] => [block],
  };
}
