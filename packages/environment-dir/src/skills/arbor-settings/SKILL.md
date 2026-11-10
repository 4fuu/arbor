# 修改设置

修改设置：身份、通用规则、阈值和窗口限制。

设置是 `/env/settings.json`，和环境里其他项一样是一个有修订的项。模型可以修改关于自己的
一切：身份、通用规则、judge 模式、阈值、模型分层。两样不能修改：秘密的值，以及框架内置
的技能。

## 结构

```json
{
  "identity": "你是部署在内部集群上的运维 agent。",
  "generalRules": ["已完成的结论都写入笔记。", "发送不是必须的。"],
  "modelTiers": { "fast": "claude-sonnet-4-5", "deep": "claude-opus-4-5" },
  "defaultTier": "fast",
  "window": { "idleSeconds": 300, "contextTokens": 200000, "reserveTokens": 4000, "handoffFloor": 0.6 },
  "snapshot": { "minIntervalMs": 600000 },
  "workspaces": { "retentionMs": 604800000 },
  "judge": { "modes": { "route": "on", "notice": "shadow" }, "maxCandidates": 8 },
  "secrets": ["BOT_TOKEN"]
}
```

- `identity`：`<identity>` 一节，为空时不渲染，没有默认句。
- `generalRules`：`<agent>` 一节的通用规则，一行一条；不写时使用框架的默认规则。
- `modelTiers`、`defaultTier`：每一层映射到后端能跑的一个模型。
- `window`：空闲秒数、上下文预算、预留 token 和交接下限。`handoffFloor` 是占上下文的比例，
  默认 0.6；低于它且没有未完成的工作时，带 handoff 的 end 会被拒绝，窗口保持空闲。
- `snapshot.minIntervalMs`：系统提示和记忆快照最多多久重建一次。
- `workspaces.retentionMs`：窗口链最后一个窗口结束后，它的工作区检出再保留多久由主机回收；不设就不回收。
- `workspaces.shared`：ovnfs 工作区的共享文件夹，所有窗口都在里面读写，按约定只读；不放多个项目和仓库时留空。
- `workspaces.ovnfs.state` / `workspaces.ovnfs.mount`：ovnfs 守护进程的状态目录和检出挂载目录，默认在主机数据目录下。
- `judge.modes`：每个决策是 `on`、`off` 还是 `shadow`。
- `secrets`：允许使用的秘密的名字，只写名字，不写值。

## 自测

1. `read /env/settings.json` 查看当前值。
2. 在本窗口工作区里修改：`cp /env/settings.json .`，再 `edit`。
3. 用 `env.list` 确认改动落在哪一项上，用 `env.history("set:settings")` 查看修改过什么。

## 安装

`reload({ install: ["./settings.json"] })`。

身份和通用规则不是变更增量：它们属于系统提示，从下一个快照 epoch 起生效。运行中的窗口
拿到的还是这一次 epoch 冻结的那一版。

## 修订冲突

草稿是基于某个修订复制的。如果这期间其他窗口修改过设置，这次调用会被拒绝，拒绝里列出中
间的修订。重新复制最新版，合并后再调用一次。

## 回退

安装旧的那一版就是重新安装它；修订历史用 `env.history("set:settings")` 查看。
