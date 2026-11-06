/**
 * The ovnfs workspace's own prompt text (docs/workspaces.md).
 *
 * Every fixed string this implementation writes lives here, in Chinese, one
 * entry per string: the prompt section that carries the method, the module
 * functions' descriptions and their results and refusals. The host merges this
 * table over its own when this implementation is the active workspace, so a
 * host that fell back to the plain directory never shows the ovnfs method - the
 * directory workspace carries its own, different text
 * (packages/workspace-dir/src/directory-workspace.ts).
 *
 * Identifiers stay as they are: `workspace.checkout`, `arbor/<ref>`, `ovnfs`.
 */

import type { TextTable } from "@4fu/arbor-interfaces";

/** The prompt section's method: one short line per point, `{source}` filled in. */
export const ovnfsText: TextTable = {
  // ---- the prompt section the implementation contributes -----------------
  "workspace.method.shared": "共享文件夹 {source}：所有窗口都在这里读写，它可以放多个项目和多个 git 仓库。",
  "workspace.method.readonly": "共享文件夹按约定只读：不要直接改它，改动请开检出，直接写会写到别人的文件。",
  "workspace.method.open": "要改某个项目就给它开一个检出：workspace.checkout(\"<简称>\", \"<项目子目录>\")，检出名以本窗口引用开头，如 c41-app。",
  "workspace.method.work": "在检出里读写和跑命令；一次要改两个项目就开两个检出，它们各自独立、互不看见。",
  "workspace.method.apply": "改完用 workspace.apply(\"<检出名>\") 合回共享文件夹；有冲突就先解决冲突标记，再 apply 一次；合完用 workspace.rm 删掉检出。",
  "workspace.method.frozen": "检出在打开时冻结：别的窗口之后合回的变化这里看不到，要读共享文件夹或新开一个检出。",
  "workspace.method.git": "git 仓库要在项目子目录（不是父目录）开检出，这样它才有私有 git 目录：在检出里提交，再用 apply --branch arbor/<本窗口引用> 把提交取回；绝不在共享文件夹里提交。",
  "workspace.method.classes": "检出里 node_modules 等缓存路径是实时的只读镜像，.env 等保密文件是本地的，都不进检出的快照，也不会被合回。",
  "workspace.method.cli": "模块函数只是方便，ovnfs 命令行同样好用；完整用法（命令、--json、冲突标记、explain、grep/glob、嵌套仓库）见内置技能：read /env/skills/ovnfs/SKILL.md。",

  // ---- the module functions this implementation adds --------------------
  "function.workspace.checkout": "给一个项目子目录开一个检出，检出名以本窗口引用开头；返回检出的路径，之后在里面改文件。",
  "function.workspace.list": "列出本窗口或指定窗口链的检出：名字、路径、是否有未合回的改动。",
  "function.workspace.diff": "查看一个检出自打开以来改动了哪些文件。",
  "function.workspace.apply": "把一个检出的改动合回共享文件夹；git 仓库加 branch=\"arbor/<引用>\" 取回提交；有冲突时解决标记后再合一次。",
  "function.workspace.rm": "删除一个已经合回的检出，收回它占用的空间。",
  "function.workspace.path": "按窗口查询它的检出路径；这些检出属于其他窗口，只读，不要修改。",

  // ---- results ----------------------------------------------------------
  "result.workspace.checkout": "已打开检出 {name}：{path}。在它里面改文件，改完用 workspace.apply 合回。",
  "result.workspace.list": "检出（{window}）：{lines}",
  "result.workspace.list.empty": "窗口 {window} 没有检出。",
  "result.workspace.list.line": "{name}{dirty} {path}",
  "result.workspace.diff": "检出 {name} 相对打开时的改动：{changes}",
  "result.workspace.diff.empty": "检出 {name} 没有改动。",
  "result.workspace.apply": "已合回 {name}：应用 {applied} 个，合并 {merged} 个。用 workspace.rm 删掉检出。",
  "result.workspace.apply.branch": "已把 {name} 的提交取回为分支 {branch}（{commit}）。",
  "result.workspace.conflict": "检出 {name} 有冲突：{conflicts}。解决文件里的冲突标记，然后用 workspace.apply 再合一次。",
  "result.workspace.rm": "已删除检出 {name}。",
  "result.workspace.path": "窗口 {window} 的检出：{lines}",
  "result.workspace.path.empty": "窗口 {window} 没有检出。",

  // ---- refusals ---------------------------------------------------------
  "refused.workspace.name": "检出名 {name} 不符合约定：要以本窗口引用开头。",
  "refused.workspace.cli": "ovnfs：{message}",
  "refused.workspace.path": "窗口 {window} 没有检出。",

  // ---- next actions -----------------------------------------------------
  "next.workspace.name": "用「本窗口引用-简称」命名，例如 c41-app。",
  "next.workspace.cli": "核对项目子目录和检出名；完整用法见 /env/skills/ovnfs/SKILL.md。",
  "next.workspace.path": "该窗口没有开过检出；用 windows.list 查看当前窗口。",
};
