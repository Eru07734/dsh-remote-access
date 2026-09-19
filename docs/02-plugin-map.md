# 插件地图：这套东西由哪三层构成，新功能该放哪一层

这份文档回答一个在改这套东西时**必然遇到**的问题：*我想加的功能，应该写成宿主插件、客户端插件，还是改 App？*
读完你会知道三层的边界在哪、插件之间靠什么耦合、代码是怎么进到 DSH 里的，以及每条路的代价。

读者需要的最少背景：**DSH（DeepSeek Harness）** 是要暴露的 agent 运行时；本仓库的 4 个插件跑在
**宿主机**（运行 `dsh web` 的那台机器）的 DSH 进程里。术语表见根 [`README.md`](../README.md) §4。

---

## 1. 三层，各有各的边界

| 层 | 是什么 | 怎么进去 |
|---|---|---|
| **宿主插件（host plugin）** | `plugins/` 下的包，跑在 DSH 宿主进程里 | profile 补丁里的绝对路径行（见 [`config/README.md`](../config/README.md)） |
| **浏览器半边（browser half）** | 上游那 55 个 `dsh-*` 包里的 `lib/client.js`，跑在 WebView / 浏览器里 | 由 `dsh-client-modules` 组合成一个请求 |
| **App（DSHPad）** | Android WebView 壳 | 只能改 [`app/DSHPad`](../app/DSHPad/README.md) 里的 Java |

**范围说明**：本文只描述本仓库的 **4 个**宿主插件；每个包自己那一页在 `plugins/<包名>/README.md`。（「两台机器的 DSH 互通」/ TCP 网桥在独立仓库 [dsh-net-bridge](https://github.com/Eru07734/dsh-net-bridge)。）

---

## 2. 依赖有三层，其中两层是空的

### 2.1 npm 依赖：零 —— 而且**不可能**有

这个项目族的宿主插件 `dependencies` 与 `peerDependencies` **全为空**；全仓库的 `import` 语句只有
`node:*` 内建与相对路径，**没有一条外部 import**。

这不是自律，是**结构性约束**：插件挂在 `C:\dsh-plugins\<name>\index.js`，位于 DSH 安装树**之外**，
Node 解析不到 `@deepseek-ai/*` 这样的裸标识符。所以想用 DSH 的能力，**只能靠 `inject` + 运行时接缝，不能 import**。

> 推论：任何"我想直接调一下 DSH 内部某个函数"的念头，在这里都行不通。要么走接缝，
> 要么把代码抄进来（自家插件里就有这么做的先例，注释里写明了理由）。

### 2.2 插件之间：零

源码里搜不到任何一条插件与插件之间的 `import`，也搜不到任何一处以"别的插件已安装"为前提的逻辑。
**4 个插件两两独立，可以单独装、单独删。**

### 2.3 Cordis `inject`：真正的运行时依赖

插件不是靠 import 拿服务的，而是靠声明 `inject`，由 DSH 的插件容器把服务注进来：

| 依赖的服务 | 谁 | 数量 |
|---|---|---|
| `webServer` | api-attribution, lan-owns-host, lan-url, mobile-ui | **4** |
| `connection` | lan-url | 1 |

`webServer` 是耦合最重的接缝（本仓库 4/4）。理由都一样：**要让浏览器里发生点什么，最省的路是在活动 HTTP server 上加东西。**

### 2.4 ⚠️ 事件接缝不受 `inject` 保护

`inject` 只声明**服务**依赖。事件接缝是另一回事：监听一个没人派发的事件不会报错，只会**静默地永不触发**。

| 插件 | 监听 | 事件属于 | `inject` 声明了吗 |
|---|---|---|---|
| lan-owns-host | `webserver/index-inject` | `dsh-host-webserver` | ✅ 有 `webServer` |
| mobile-ui | `webserver/index-inject` | 同上 | ✅ |

本仓库这两个事件消费者都声明了对应的服务，所以是安全的。但这条约束是**约定，不是机制**：
事件系统没有"是否有人会派发这个名字"的查询接口，`apply()` 里也没法断言。写新插件时若去监听别的包的
waterfall（`user-questions/*`、`approval/*` 这一类），只能自己记住 —— 或者把这条依赖写进文档让人知道。

---

## 3. 4 个插件逐个

| 包 | 版本 | 通道 | `inject` | 挂的接缝 | 浏览器半边 | 测试 |
|---|---|---|---|---|---|---|
| `dsh-api-attribution` | 0.1.0 | plain | `webServer` | `prependListener('request')` → 写 `api-calls.log` | — | — |
| `dsh-lan-owns-host` | 0.1.0 | plain | `webServer` | `on('webserver/index-inject')` → 注入标记 | — | — |
| `dsh-lan-url` | 0.1.0 | plain | `connection`, `webServer` | `ctx.connection.authenticatedUrl()` → 写 `web-urls.txt` | — | — |
| `dsh-mobile-ui` | 0.1.0 | plain | `webServer` | `on('webserver/index-inject')` → 注入 `<style>` | — | — |

**本仓库没有一个包带浏览器半边**（`lib/client.js`）。所有浏览器侧的效果都不是靠"写客户端插件"做的 —— 见 §5.2。

---

## 4. 代码是怎么进去的：一条通道 + 2 个分片

### 4.1 通道由 `package.json` 决定（不是看有没有 `cordis.patch.yml`）

[`config/install.ps1`](../config/install.ps1) 的判定是 **`package.json` 里有没有 `dsh.bundle.patch`**：

| 通道 | 数量 | 谁 | 怎么进来 |
|---|---|---|---|
| **bundle** | 0 | — | `dsh plugin --profile web add "file:…"`，包自带 `cordis.patch.yml` **自我注册**，进 `node_modules`，**只在进程启动时组合** |
| **plain** | 4 | api-attribution, lan-owns-host, lan-url, mobile-ui | profile 补丁里的**绝对路径 `- insert:`**，`patchReload: live`，写进文件即热重组 |

本仓库 4 个包**全走 plain**。两条通道的差别见 [`config/README.md`](../config/README.md)。

### 4.2 补丁分片的合成顺序

编号是推荐的应用顺序，直接追加到 `~/.dsh/profiles/<profile>/cordis.patch.yml` 末尾。
**本仓库带 1 个**，所以顺序其实不敏感：

| 分片 | 干了什么 |
|---|---|
| `01-lan-access` | `webserver` 绑 `0.0.0.0`；`connection` 的 `trustedHosts` 每次组合重推；4 条 insert（lan-owns-host、lan-url、api-attribution、mobile-ui） |

### 4.3 profile 补丁层是 `patchReload: live` 的

写进补丁文件即热重组，**不需要重启进程**；但**插件源码**的改动仍然要重启才生效。
这个差别在开发时非常关键：[`tools/restart-harness.ps1`](../tools/restart-harness.ps1) 就是为它写的。

---

## 5. 三个结构性事实

### 5.1 全部是纯宿主半边

4 个包都没有 `lib/client.js`。**所有浏览器侧的效果都不是"写客户端插件"做的。**

### 5.2 影响浏览器的两条旁路

| 旁路 | 机制 | 谁在用 |
|---|---|---|
| **注入** | `on('webserver/index-inject')` 往 index 的结构化注入表里塞行（CSS / 标记） | lan-owns-host, mobile-ui |
| **挂监听** | 在活动 server 上加一条 `request` / `upgrade` 监听 | api-attribution |

上游的 `dsh-client-modules` 也是用第一条旁的**同一个接缝**，把 55 个浏览器半边注入页面的 ——
也就是说，**这条旁路与"写一个客户端插件"在服务端是同一件事**，只是少了前端那一半。

### 5.3 为什么是 `prependListener` 而不是 `ctx.webServer.register()`

本仓库唯一挂到活动 HTTP server 上的插件 `api-attribution` 用的是
`server.prependListener('request', …)`（`server` 就是 `ctx.webServer.server`，一个未在类型里暴露的公开属性），
而没有用有类型的 `ctx.webServer.register()`。理由写在它自己的注释里，**是有意的**：

> `prependListener`：在任何 handler 之前记录，这样即使某个路由抛异常，也留下了痕迹。

两者的差别是**顺序**：`register()` 加的是自己的一条路由（"这条路径本来就没人管"时才可靠），
`prependListener` 保证监听器排在所有既有 handler 之前。

而**要"认领"一个请求（自己写响应）就必须同步占位** —— Node 触发 `'request'` 时不会 await 各 listener，
它们按顺序同步调用，谁先写出响应谁赢；先 `return` 再等 Promise 去 `writeHead`，后面的 handler 会立刻抢答。
`register()` 的路由 handler 是异步的，所以拿它去抢一条已有 fallback 的路径是抢不到的。

---

## 6. 判定表：新功能放哪一层

| 你想做的事 | 该放哪 | 依据 |
|---|---|---|
| 改页面**长什么样**（样式 / 布局） | 宿主插件 + `index-inject` | `dsh-mobile-ui` |
| 改页面**能做什么**，且上游有客户端插件可改 | 上游 `dsh-client-ui-*`（要动 npm 安装树） | 无先例，本仓库没做过 |
| 加一条**只读数据出口**给外部设备 | 宿主插件 + `webServer.server` 上的同步监听（见 §5.3） | `dsh-api-attribution` |
| **观察**已有事件（不改变行为） | 宿主插件 `ctx.on(...)`，**waterfall 要 `prepend: true`** | 见 §2.4；本仓库目前没有这样的包 |
| 需要 **WebView 平台能力**（文件选择器、下载） | App（`app/DSHPad`） | 上游插件根本够不到这类能力；`MainActivity` 的 `onShowFileChooser` 就是这么补的 |
| 需要文件**进 / 出**页面 | 先看上游有没有接缝；没有就得 App 侧或上游加 | 同上 |

---

## 7. 已知缺口与风险

| 缺口 | 影响 | 现状 |
|---|---|---|
| 事件接缝不受 `inject` 保护（§2.4） | 相关包缺失时静默失效 | 约定，见 §2.4 |
| 本仓库**没有任何浏览器半边** | 想在页面上加"另存为"这类按钮，只能靠 `index-inject` 注入脚本（脆弱）或推动上游 | 见 [`app/DSHPad/README.md`](../app/DSHPad/README.md) 的文件选择器一节 |
| 个人标识符遍布全仓库（`<user>` / Tailscale 地址 / tailnet 名） | 公开仓库会暴露个人基础设施信息；**都不是密钥** | 见根 [`README.md`](../README.md) §8 |
| `local.properties` 曾被 Git 跟踪 | 含个人 SDK 绝对路径，且属于逐机文件 | 已改为忽略（见 `.gitignore`） |

---

## 附：这套结论是怎么得到的

不靠记忆，靠扫。下面两条命令分别做"包普查"和"真实依赖面普查"：

```powershell
# 包普查：谁有宿主半边、谁有浏览器半边、谁是 bundle
$base = "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai"
Get-ChildItem $base -Directory | ForEach-Object {
  [pscustomobject]@{
    Name   = $_.Name
    Host   = Test-Path (Join-Path $_.FullName 'lib\index.js')
    Client = Test-Path (Join-Path $_.FullName 'lib\client.js')
    Bundle = Test-Path (Join-Path $_.FullName 'cordis.patch.yml')
  }
} | Format-Table -AutoSize

# 本族的真实依赖面：只看 import 与 inject，不看注释
Get-ChildItem plugins -Recurse -File -Include *.js |
  Select-String "^import .* from '(?!node:|\.)"     # 期望零命中
Get-ChildItem plugins -Recurse -File -Include *.js |
  Select-String 'inject\s*=\s*\[' , 'ctx\.on\(\s*[''"]'
```

普查结果：上游 **239 个包**，其中 237 个有宿主半边、**55 个有浏览器半边**（正好等于 `/plugins/??`
那个大请求里的 55 个）、6 个是 bundle；本仓库 **4 个包，全部是纯宿主半边**。

**注意**：上面的 `plugins` 只覆盖本仓库。
