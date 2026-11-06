/**
 * The prompt section the plain-directory workspace contributes
 * (docs/workspaces.md).
 *
 * Its own, different text from the ovnfs workspace's, so a host that fell back
 * to the plain directory never shows the ovnfs method. It renders in a
 * `<workspace>` tag as a standing instruction, one short line per point, each a
 * fixed string in this package's own text table.
 */

import type { Block, BlockKindSpec, PromptSection, TextTable } from "@4fu/arbor-interfaces";

/** The plain-directory workspace's own fixed strings. */
export const directoryText: TextTable = {
  "workspace.method.directory": "你的工作区是本主机上的一个目录，随窗口创建；续窗口在原处继续用它，克隆的仓库、装好的依赖和未完成的工作都留着。",
  "workspace.method.readonly": "按约定，别的窗口的目录只读，不要修改；要协作就靠仓库自己的流程（push、review、CI），框架不替你合并文件。",
  "workspace.method.means": "read、write、edit 和 bash 都在这个目录里工作，bash 也在这里跑后台作业。",
};

/** The one block kind the section renders: its lines, no tag, not data. */
export const DIRECTORY_METHOD_BLOCK: BlockKindSpec = {
  kind: "directory_method",
  data: false,
  fields: [],
  lines: ["workspace.method.directory", "workspace.method.readonly", "workspace.method.means"],
};

/** The plain-directory workspace's prompt section. */
export function directorySection(): PromptSection {
  const block: Block = { kind: "directory_method", fields: {} };
  return {
    tag: "workspace",
    blocks: [DIRECTORY_METHOD_BLOCK],
    text: directoryText,
    content: (): readonly Block[] => [block],
  };
}
