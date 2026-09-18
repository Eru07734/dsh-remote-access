# dsh-api-attribution

**记录"哪台设备在什么时候调了什么"** —— 写一行日志，不改任何行为。

想知道手机、平板、另一台电脑分别干了什么的人读这一页。DSH 本身不做这件事。

## 它补的缺口：消息没有设备归属

harness 里没有任何地方把一条消息归属到它来自哪台设备：

- 模型只拿到 `role` + 内容；
- `MessageSource.kind` 记的是**生产者类别**（`user` / `model` / `tool` / `plugin`），从来不是设备；
- `clientId` 只活在 `dsh-api-gateway` 的传输状态里 —— 在 `dsh-session`、API 控制器和持久化层里都不存在；
- webserver 自己**不记录任何请求**。

## 它做什么

在活动 HTTP server 上挂一个监听器（`ctx.webServer.server` 是公开属性，所以不用改第一方代码），
把**值得记的请求**追加成一行：

```
<ISO 时间>  <kind>  <METHOD> <path>  host=<authority>  ua=<User-Agent>
```

写进 `$DSH_HOME/api-calls.log`（`DSH_HOME` 不存在时是 `~/.dsh/api-calls.log`）。

| 项 | 值 |
|---|---|
| 通道 | plain（绝对路径挂载） |
| `inject` | `['webServer']` |
| 接缝 | `server.prependListener('request', …)` + `server.on('upgrade', …)` |
| 记什么 | `/api*`（每一条消息、工具调用、流式 RPC 都走这里）与 `GET /`（某台设备打开了 GUI）；WebSocket 升级记为 `kind=upgrade` |
| 不记什么 | 静态资源、插件包、manifest —— 一次页面加载就能写几十行，会把信号埋掉 |

`host` 字段是设备**实际连上的那个 authority**，据此能把 loopback 客户端（`127.0.0.1:3080`）
和局域网客户端（`<home-lan-ip>:3080`）分开；`ua` 用来区分手机与桌面。UA 超过 300 字符会被截断并加 `…`。

**为什么用 `prependListener`**：要在任何 handler 之前记录，这样即使某个路由抛异常也留下了痕迹。
配合 `ctx.effect` 注册的 disposer，重复激活不会把同一条请求记两遍。

## 要知道的边界

- **这是监控**：每一台到达 GUI 的设备都会被记录，包括它的 User-Agent。
- 日志是**只追加的纯文本，没有轮转**。长了就自己删；删掉那条 insert 即停止记录。
- **模型拿不到这些行**。它们落在文件里 —— 归属是人事后（或让 agent 按需）去读的东西。

## 单独装 / 单独关

- 装：`config/install.ps1 -Apply` 会一起装；只想装这一个，就把 `config/fragments/01-lan-access.patch.yml` 里那条 `id: api-attribution` 的 insert 追加进 profile 补丁。
- 关：删掉那条 insert，然后删掉 `api-calls.log`。

## 怎么验证

```powershell
Get-Content "$env:USERPROFILE\.dsh\api-calls.log" -Tail 5
```

然后用手机打开一次 GUI 并发一条消息，再看一眼：应当出现 `GET /` 一行与若干 `/api/...` 行，
`host=` 是手机连的那个地址，`ua=` 能认出是手机浏览器。
