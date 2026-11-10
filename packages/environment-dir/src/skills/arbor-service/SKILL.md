# 接一个常驻服务

接一个常驻服务：窗口结束后仍需运行的应用。

服务是一个窗口结束后还不结束的应用：webhook 接收、爬虫、机器人、worker。命令工具的后
台作业随窗口链结束，所以常驻的必须是服务。

框架负责：崩溃后按退避重启、主机重启后重新启动、它自己的目录、日志、按名字注入秘密。
你负责：写应用、安装依赖、写 `svc.json`、决定什么时候停止或移除。

## 结构

服务是一个目录，里面有 `svc.json` 和应用文件：

```json
{
  "command": "node",
  "args": ["bot.js"],
  "ports": [8080],
  "healthCheck": { "path": "/healthz", "port": 8080, "intervalMs": 500, "timeoutMs": 10000 },
  "secrets": ["BOT_TOKEN"],
  "restart": { "maxRetries": 5, "backoffMs": 2000 }
}
```

- `command`、`args`：怎么启动，在这个目录里运行。
- `ports`：它监听的端口，窗口和其他服务可以从主机访问。
- `healthCheck`：reload 等它通过才安装。按 `intervalMs` 轮询
  `http://127.0.0.1:<port><path>`，`timeoutMs` 内没有 2xx 就算失败。
- `secrets`：秘密的名字，只写名字；值由主机按名字注入。
- `restart`：崩溃后最多重试几次，每次之间等待多久。

安装后是 `/env/services/<name>/`，目录归服务所有，没有窗口能结束它或回收它。

## 自测

1. 在本窗口工作区里写好应用和 `svc.json`。
2. 先直接运行：Unix 上用 `bash node bot.js`，Windows 上用 `pwsh -Command "node bot.js"`；确认它启动、监听端口、`/healthz` 有响应。
3. 用 `curl` 或命令工具请求一次健康检查路径，确认返回 2xx。
4. 故意让它退出一次，查看重启和日志是否符合预期。

## 安装

`reload({ install: ["./<name>"] })`。

reload 把草稿目录复制一份归服务所有，启动它，等健康检查通过，然后才安装。健康检查不
通过时调用被拒绝，什么都不改变，日志留在服务日志里。

## 失败是输入

崩溃、重启成环、健康检查不通过，都会成为一条目标为 `svc:<name>` 的记录事件，和任何外部
输入一样被派发。主机不替你修复。

## 回退

升级是再一次 `reload({ install: ["./<name>"] })`；回退是安装旧的那一版，修订历史用
`env.history("svc:<name>")` 查看。`reload({ remove: ["service:<name>"] })` 停止并移除它。
