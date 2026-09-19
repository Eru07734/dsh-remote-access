# 把 DSH 暴露给局域网设备：第三方插件审计、选型与已落地方案

把 **DSH（DeepSeek Harness）** 从 `127.0.0.1` 开放到局域网，等于把一台能在宿主机上直接执行命令的机器的完整控制权交出去；npm 上有五个现成插件在做这件事，而它们各自的做法、代价与风险差别很大。这份文档逐行审计了这五个包（读的是 `npm pack` 下来的 tarball 内容，不是各家的 README 自述），给出选型结论，然后记录我们自己最终落地的方案、支撑它的全部实测证据，以及三项延伸工作：跨网络的 Tailscale 实测、与宿主机代理的共存、手机端"设置"界面的布局修复。

**谁该读，读完能做什么。** 想在自己机器上复现"从别的设备访问 DSH"的开发者，以及需要评估这套暴露面到底有多大的运维或安全评审者。读完你能自己判断某个包该不该装、内置配置层要改哪几行、每项改动的可验证判据是什么——包括每一个数字是怎么量出来的。

**术语约定**（首次出现给出英文原词，之后直接用）：

| 术语 | 含义 |
|---|---|
| DSH（DeepSeek Harness） | 本文要暴露的那个 agent 运行时 |
| 宿主机（host machine） | 运行 `dsh web`、也就是被访问的那台机器 |
| 远端设备（remote device） | 手机 / 平板 / 另一台电脑等发起访问的一方 |
| 宿主插件（host plugin） | 跑在 DSH 宿主进程里的插件 |
| 浏览器半边（browser half） | 跑在浏览器 / WebView 里的客户端插件 |
| profile 补丁（profile patch） | `~/.dsh/profiles/<profile>/cordis.patch.yml`：DSH 在 bundle 层之后叠加的自定义装配层；`patchReload: live` 表示写进去即热重组 |
| 分片（fragment） | `config/fragments/*.patch.yml`，可直接追加进 profile 补丁的条目 |
| 联接（junction） | Windows 目录联接，让 `C:\dsh-plugins\<name>` 指回仓库里的插件源码 |

文中 `<user>`、`<host-tailnet-ip>`、`<home-lan-ip>`、`<tailnet>`、`<phone>`、`<pad>`、`<email>`、`<public-ip>`、`<stale-link-local>` 等写法都是脱敏占位符，代表个人基础设施坐标，不是可照抄的字面值。

---

## 1. 审计的对象、方法与背景

### 1.1 目标环境与审计方法

- 审计对象：npm 上实际会被安装的 tarball（不是 README 自述）。
- 目标机器环境：DSH `0.1.5-rc.2`，`$DSH_HOME=C:\Users\<user>\.dsh`，profile `web`（`patchReload: live`）。
- 审计方式：`npm pack` 取包 → 解包 → 逐文件读码 + 与第一方原文件对照。
- 原始材料：本仓库 `third-party-audit/` 下的五个 tarball 与解包源码（逐字保真，未做任何改动）。

### 1.2 被审计的五个包

| 包 | 版本 | 体积 | 是否 fork 第一方代码 |
|---|---|---|---|
| `dsh-web-lan-access` (AcidGr) | 1.3.2 | 10 KB | 否（只用官方 `tapIndex`） |
| `dsh-lan-access` (Leon0555) | 0.1.3 | 6.8 KB | 否 |
| `@studyzy/dsh-web-remote-access` | 1.0.1 | 20 KB | 是（startup + webserver） |
| `@pananfly/dsh-lan-access` | 0.1.1 | 18 KB | 是（startup + webserver） |
| `dsh-public-access` (JNan-QQ) | 1.3.0 | 10 KB | 是（startup），另 monkey-patch connection |

### 1.3 为什么"把 DSH 暴露到局域网"必须先审计

三件背景事实决定了后面怎么选，也决定了这五个包的风险各不相同：

1. **上游有意挡住"监听所有接口"。** `dsh web --host 0.0.0.0` 会被拒绝，理由写得很直白：这会 "expose remote code execution to the network"。但 webserver 行的 schema 接受这个值，profile 补丁层是官方留出的口子——所以真正要做的事需要一次有意识的取舍，而不是加个参数。
2. **暴露出去的是完整 RCE（远程代码执行）。** 宿主机上的 DSH 以 danger-full-access 运行、会话审批提示已禁用，agent 能直接跑 `pwsh`；而局域网里走的是明文 HTTP，token 与 cookie 可被嗅探（细节与残余风险见 §6.4）。
3. **"监听所有接口"不是唯一的一道门。** `/api` 请求还要过一道 Host/Origin 栅栏（用于反 DNS rebinding）；页面上哪些操作被当作"loopback 特权"则由一个 `isLoopback` 判定决定，而该判定只存在于**浏览器半边（browser half）**——也就是发到浏览器里运行的那部分客户端代码里，服务端没有对应的闸门（§7.7）。第三方插件的差别，几乎全部落在它们如何处理这三件事上：绑定、栅栏、`isLoopback`。

审计的动机很直接：这五个包处理的是同一批前提——明文 HTTP 下 `crypto.randomUUID` 缺失、栅栏收不到后起的接口、`isLoopback` 让设置不落盘——而这些前提在 `0.1.5-rc.2` 上要么已不成立（§1.4），要么只需要内置配置层就能处理（§1.5）。所以"装还是不装、装哪个"只能靠读 tarball 里的实际代码来回答。

### 1.4 先决事实一：`crypto.randomUUID` polyfill 在 0.1.5-rc.2 上已经不需要

五个包里有四个都把「局域网明文 HTTP 不是安全上下文 → `crypto.randomUUID` 不存在 → 浏览器端 RPC 全炸」当作存在理由，并注入 polyfill。核对宿主机上安装的第一方代码：

- `@deepseek-ai/dsh-util-crypto/lib/index.js` 的注释写明：
  > `crypto.randomUUID` is a secure-context Web API — a page or worker served over plain HTTP on a LAN address has no such method — while `crypto.getRandomValues` is unrestricted everywhere
- `dsh-client-connection/lib/client.js`、`dsh-api-gateway/lib/client.js` 都用这个 helper 自造 UUID（`globalThis.crypto.getRandomValues(...)`），**不调用** `crypto.randomUUID`。
- 整个有效依赖树里唯一一处 `crypto.randomUUID(` 在 `dsh-client-ui-sidebar-documentpreview/lib/client.js:3354`，而它是**带守卫**的：
  ```js
  function getUuid() {
      if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
      const buf = new Uint8Array(32);
      crypto.getRandomValues(buf);
      return bytesToString(buf);
  }
  ```

结论：这些 polyfill 针对的是旧版 DSH，在 `0.1.5-rc.2` 上**多余**（无害，但说明插件的前提已过时）。它们提到的「RPC 全炸」在这个版本上不会发生。

### 1.5 先决事实二：绑定 `0.0.0.0` 时，局域网可信栅栏是上游自动派生的

`dsh-web-app/lib/index.js:83-89`：

```js
function resolveLanTrust(bindHost, extra) {
    const lanAddresses = bindHost === ALL_INTERFACES_HOST
        ? Object.values(networkInterfaces()).flat().filter(i => i && i.family === "IPv4" && !i.internal).map(i => i.address)
        : [];
    return { lanAddresses, trustedHosts: [...lanAddresses, ...extra] };
}
```

它读的是**实际绑定**（`ctx.webServer.host`，`index.js:173`），所以只要 webserver 行绑定 `0.0.0.0`，`<home-lan-ip>` 就已自动进白名单，`/api` 的 Host 栅栏会放行。**局域网访问不需要插件。**

插件额外做的，只是「接口在启动后才起来 / 非 `0.0.0.0` 绑定 / 想连 Tailscale 名字」这些边角的补强。

宿主机上 `lanAddresses` 实测顺序（`os.networkInterfaces()`）：`<stale-link-local>`(Tailscale), `192.168.10.1`(VMnet1), `192.168.126.1`(VMnet8), `<home-lan-ip>`(WLAN)。
→ `dsh web` 打印的 `(LAN: ...)` 会用 `lanAddresses[0]`，即 **`<stale-link-local>`，别的设备打不开**；要手敲 `http://<home-lan-ip>:3080/?token=...`。

---

## 2. 五个第三方包的逐包审计

### 2.1 `dsh-web-lan-access` 1.3.2 — 推荐

**做了什么**

- `cordis.patch.yml`：覆盖 `webserver` 行（正确重述了全部 4 个键），另覆盖 `connection` 行的 `trustedHosts`，把栅栏**重新推导**为「当前所有非 internal IPv4」并 merge `webRuntime` 已算出的值 —— 修的是「接口后起/VPN」这个上游一次采样覆盖不到的边角。
- `lib/index.js`（57 行）：注册 `webServer.tapIndex`，往 `<head>` 开头注入一段脚本：
  - `ownsHost: true`（并保留普通 fetch）→ 让 LAN 页面拿到 loopback 级待遇；
  - `randomUUID` 兜底（用真 `crypto.getRandomValues`，不是 `Math.random`）。

**风险点**

1. **无任何新增鉴权** —— 安全完全依赖 DSH 自己的 launch token（启动令牌）+ 签名 cookie。这跟内置方案的信任模型相同：**谁能拿到那条带 token 的 URL，谁就拿到这台机器的 RCE**。
2. `ownsHost: true` 对**任何**来源页面生效，等于把 `isLoopback` 这道门拆了（上游 `dsh-client-connection/lib/client.js` 的 `isLoopback: transport?.ownsHost === true || isLoopbackHostname(...)`）。收益是设置能落盘；代价是特权接口的「仅 loopback」钉死失效。
3. 栅栏放宽到所有非 internal IPv4（含 VMware/Tailscale 字面量）。
4. 兼容性字段只声明到 `0.1.5-rc.1`，宿主机上是 `0.1.5-rc.2`（`dsh: ">=0.1.0"` 那个字段很宽，但不等于验证过）。

**代码卫生**：无 `postinstall`，无 `child_process`，无网络外发，不读凭据文件，`ctx.effect` 正确释放 tap，MIT + 有测试脚本（测试未打进包）。

### 2.2 `dsh-lan-access` 0.1.3 — 最小但要修一处

**做了什么**

- patch：覆盖 `webserver` 为 `host: 0.0.0.0` + `port: !!js ctx.webStartup.port ?? 3080`，插入一个 `inject: [webServer]` 的行。
- `lib/index.js`（88 行）：`tapIndex` 注入 `randomUUID` polyfill（`getRandomValues` 版）+ 移动端 CSS（`@media (max-width:820px)` 紧凑排版，对手机/平板确实有用）。

**问题**

1. **patch 漏写 `compression` 三个键** —— DSH 的补丁语义是「替换整行 config」。宿主机上 `dsh-host-webserver` 的 schema 默认是
   `compression: z.union([z.const("none"), z.const("gzip")]).default("none")`，
   而 web-app 层给的是 `compression: gzip`。被它一覆盖 → **静默退化为不压缩**。
2. 不设 `ownsHost` → LAN 浏览器里**设置不落盘**（`dsh-client-ui-settings/lib/client.js`：`persistence = ctx.remote.$host.isLoopback ? "host" : "memory"`）。
3. 注入的 CSS 选择器绑死内部 `data-*` 属性（`data-slot` / `data-chat-flow` / `data-composer-card`），上游一改版就失效（失效只是样式不生效，无功能风险）。
4. polyfill 同上多余。

**代码卫生**：干净，88 行可通读，无依赖、无脚本、无外发。

### 2.3 `@studyzy/dsh-web-remote-access` 1.0.1 — 要口令就选它，但接受两笔代价

**做了什么**

- `--web_token` 门：在没有 `--web_token` 也没有 `$DSH_WEB_TOKEN` 时**自动 `randomBytes(32).toString('base64url')`**，所以「全接口绑定必然在门后」，不存在裸奔路径（`lib/startup.js:164-174`）。
- fork 了 webserver，把门放在**路由匹配之前**，覆盖 SPA 兜底、`/api` 桥、以及 WebSocket 升级（`lib/webserver.js:188`、`238`）；cookie 是 `HttpOnly; SameSite=Lax`，token 比较是恒定时间（`createHash` 后 `timingSafeEqual`，`lib/webserver.js:26-32`）。
- `lib/polyfill.js` 注入 `randomUUID` 兜底；自己的 `url.js` 打印带 `?web_token=` 的 URL。

**代价 1：fork 漂移。** patch 里 `web-startup` 和 `webserver` 两行被 `disabled: true`，换成本包自带副本。上游今后对这两处（尤其是栅栏、cookie、路由）的安全修复**不会被继承**，只能等作者跟版。

**代价 2：`/api` 主动提权。** `lib/webserver.js:300-322`：

```js
authorizeApiAsLoopback(req, pathname) {
    if (!this.config.webToken || !pathname.startsWith('/api/')) return;
    const authority = `127.0.0.1:${String(this.listenedPort)}`;
    req.headers.host = authority;
    if (req.headers.origin !== undefined) req.headers.origin = `http://${authority}`;
}
```

注释里它自己说明了理由：上游把配置平面（`settings` / `credentials` / `agentPreset` / `host.*` / `llm.discoverModels`）钉死在 loopback「until a real authentication layer exists」，而它认为自己的 token 门**就是**那层认证，于是把已通过 token 的请求伪装成 loopback。

技术实现是干净的（恒定时间比较、门在路由之前、cookie 属性正确），但这就是「**token = 完整控制权**」，且它拆的正是上游刻意保留的栅栏。局域网里有别人/不可信设备时才值得付这个代价；付的时候建议叠加防火墙只放行你自己的设备。

**代码卫生**：无外发、无 `child_process`、不读凭据文件、无 `postinstall`；有测试脚本与 LICENSE。

### 2.4 `@pananfly/dsh-lan-access` 0.1.1 — 不建议安装

**做了什么**：`web-startup` + `webserver` 两行都 disable，插自己的 fork；支持 `127.0.0.1 | 0.0.0.0 | :: | 自定义 IP`；带连通性自检（posture）。

**为什么不建议**

1. **运行时正则改写前端 JS。** `dist/host/webserver.js:290-294, 500-560`：它把 route handler 跑进一个假 `res` 里缓冲响应，然后用 3 套正则把服务出去的 `dsh-client-connection` bundle 里的
   `isLoopback: transport?.ownsHost === true || ...` **替换成 `isLoopback: true,`**。
   这不是扩展点，是改上游源码文本；而且它作用于**所有** `javascript` 响应体（不只 connection 那一个）。格式一变就靠 `logger.warn` 提示「upstream format may have changed」，属于静默降级。
2. **自动改宿主机防火墙。** `dist/host/webserver.js:35-212, 684`：`netsh advfirewall firewall add rule name="dsh-lan-access (3080)" ...`（Windows）/ `firewall-cmd --add-port`（Linux），需要提权，改的是**操作系统状态**，不是 DSH 配置。
3. **把请求体上限抬到 300 MB**：patch 里 `connection.config.maxRequestBodyBytes: 314572800`（还顺手写死 `cookieMaxAgeDays: 30`）。
4. 依赖 `@deepseek-ai/dsh-cmdline@0.0.1-rc.1`（rc 版本）。

功能确实最全（自定义 IP、posture 自检），但代价是接管你的前端产物与系统防火墙。

### 2.5 `dsh-public-access` 1.3.0 — 不建议安装

**问题清单**

1. **默认口令 `admin/admin`。** `src/auth.js:9-14` 与 `start.sh` 都显式 `DSH_AUTH_USER:-admin` / `DSH_AUTH_PASS:-admin`。绑 `0.0.0.0` + 默认口令 = 门口大开。
2. **monkey-patch 第一方服务，并绕过栅栏。** `src/reverse-proxy-fix.js:79-106`：
   ```js
   conn.requestRejection = (req) => {
       if (validateSession(req.headers.cookie)) return undefined   // 会话有效 → 直接放行
       return origRequestRejection(req)
   }
   ```
   会话 cookie 有效时同时跳过 **Host/Origin 栅栏**与原生 cookie 检查，等于把栅栏交给了一个自己实现的登录层。
3. **登录比较不是恒定时间**：`src/auth.js:46` 是普通字符串 `===`（同文件 36 行才用了 `timingSafeEqual`）。
4. **会话密钥由口令派生且盐有固定默认值**：`getSessionSecret() = sha256(salt+password) + ':' + salt`，`salt` 默认常量 `dsh-reverse-proxy-salt`。
5. **`randomUUID` polyfill 用 `Math.random()`**（`reverse-proxy-fix.js:126`），比其它几家的 `getRandomValues` 实现差。
6. **`start.sh` 启动时 `curl -s ifconfig.me`**（1473 字节脚本内），把公网 IP 送给第三方站点；脚本里 `hostname -I` 还是 Linux 专有。

---

## 3. 选型结论

### 3.1 优先级与适用场景

按你的场景（同一局域网内的手机/平板/另一台电脑操作宿主机）分档：

| 优先级 | 方案 | 适用 |
|---|---|---|
| 1 | **只用内置配置层**：`webserver` 行 `host: 0.0.0.0`（+ 可选注入一句 `ownsHost` 换设置落盘） | 零第三方代码，`0.0.0.0` 本身就自动派生 LAN 可信主机（§1.5） |
| 2 | **`dsh-web-lan-access` 1.3.2** | 想用现成包、无 fork、无鉴权降级；代码 ~100 行可通读 |
| 3 | **`@studyzy/dsh-web-remote-access` 1.0.1** | 局域网里有别人/不可信设备、要真口令；接受 fork 漂移 + `/api` 提权 |
| ✗ | `@pananfly/dsh-lan-access` | 改系统防火墙 + 正则改前端 JS + 300MB 上限 |
| ✗ | `dsh-public-access` | 默认 admin/admin + 栅栏旁路 |

### 3.2 若选现成包：安装与卸载

```powershell
dsh plugin --profile web add dsh-web-lan-access        # 或 @studyzy/dsh-web-remote-access
# 装完重启，bundle 层需要重新组合：
dsh web --no-open
dsh plugin --profile web remove dsh-web-lan-access     # 卸载
```

### 3.3 无论走哪条路都成立的残余风险

**暴露的都是完整 RCE**：宿主机上的 DSH 是 danger-full-access 且审批提示已禁用，agent 能直接跑 `pwsh`。明文 HTTP 下 token 与 cookie 在局域网里可见。建议只在自己控制的网段开机，或用防火墙把 3080 限定到特定设备。

---

## 4. 已落地方案：内置配置层 + 自写宿主插件

**选定方案**：内置配置层 + 一个我们自己写的 15 行本地插件（用于注入 `ownsHost`），外加一个把访问 URL 导出到文件的小插件（`dsh-lan-url`）。**未安装任何第三方包。**

### 4.1 改动清单

| 文件 | 改动 |
|---|---|
| `C:\Users\<user>\.dsh\profiles\web\cordis.patch.yml` | 追加 `webserver` 行 config 覆盖（`host: '0.0.0.0'`，并重述 port/compression 三个键）+ 一个 `insert` 行 |
| `C:\dsh-plugins\dsh-lan-owns-host\package.json` | 新建（`"type": "module"`，私有包） |
| `C:\dsh-plugins\dsh-lan-owns-host\index.js` | 新建：向 `webserver/index-inject` 推一行 `{kind:'script', placement:'head'}`，设置 `__DSH_TRANSPORT__.ownsHost` |
| `C:\dsh-plugins\dsh-lan-url\package.json` + `index.js` | 新建：调用第一方公开 API `ctx.connection.authenticatedUrl()`（`dsh-web-app` 打印 `dsh web:` 那一行用的同一个调用），把带 token 的 URL 逐接口写到 `$DSH_HOME/web-urls.txt` |
| `C:\Users\<user>\.dsh\web-urls.txt` | 运行期生成；**含活凭证** |

> 路径约定：`C:\dsh-plugins\<name>` 由 `config/install.ps1` 建**目录联接（junction）**指回本仓库 `plugins/<name>` 的源码，所以 profile 补丁里可以写死绝对路径，而源码真身只有一份。

`ownsHost` 只解决一件事：LAN 页面的 `isLoopback` 为 false 时，`dsh-client-ui-settings` 把设置持久化从 `"host"` 降级为 `"memory"`，`dsh-client-ui-settings-general` 也不挂载设置文档编辑器。它本身不额外授权——能打开页面已经意味着持有 launch token 并通过了 Host 栅栏。

profile `web` 是 `patchReload: live`，写入补丁文件即热重组（无需重启进程，会话不中断）。注意：补丁条目热重组即刻生效，但**插件源码**的改动仍然要重启 `dsh web` 才生效。

---

## 5. 落地验证证据

### 5.1 组合与加载

改前先验证组合（补丁语义 / `!!js` / 路径转换）。审计用的补丁随仓库附带，可直接复跑：

```
dsh web --patch third-party-audit\lan-expose.patch.yml --dump-config
[exit code: 0]     # 无 patch 警告；webserver 行 host: 0.0.0.0；插入行被转成
                   # name: file:///C:/dsh-plugins/dsh-lan-owns-host/index.js
```

模块本身：`import('file:///C:/dsh-plugins/dsh-lan-owns-host/index.js')` → `exports: OWNS_HOST_SCRIPT,apply,inject,name`。

### 5.2 热重载后的行为矩阵

| 检查 | 结果 | 含义 |
|---|---|---|
| `Get-NetTCPConnection -LocalPort 3080` | `0.0.0.0:3080` (PID 33960) | 已在进程内重绑定；**由于热重载是全有或全无，这也反证了插件行成功加载** |
| `GET http://<home-lan-ip>:3080/manifest.webmanifest` | `200` | LAN 接口确实可达 |
| `GET http://<home-lan-ip>:3080/` | `401` | 是「缺 token」，不是「被栅栏拒」 |
| `POST /api`、`/api/`、`/api/remote.mux`，Host=`<home-lan-ip>:3080` | `401` | 栅栏放行，仍需 token/cookie |
| 同上，Host=`evil.example.com` | `403` | 反 DNS rebinding 仍生效 |
| `POST /api`，Origin=`http://evil.example.com` | `403` | 跨站防御仍生效 |
| `GET http://127.0.0.1:3080/manifest.webmanifest` | `200` | loopback 页面照常 |
| `GET /?token=wrong`（LAN 与 loopback） | `401` / `401` | token 交换通道在 LAN authority 上可达，行为与 loopback 一致 |

### 5.3 入站防火墙

WLAN 的 `NetworkCategory` 是 **Public**，系统里已有两条 Enabled 的 Allow 规则
（`Node.js JavaScript Runtime`，Program = `C:\program files\nodejs\node.exe`，Protocol TCP/UDP，LocalPort **Any**，RemoteAddress Any，Profile Public），与 DSH 进程实际路径 `C:\Program Files\nodejs\node.exe` 一致 → **无需修改系统防火墙**。

### 5.4 端到端验证（真 token 走完整流程）

token 是纯随机的进程内值（`dsh-client-connection/lib/index.js:240-244`：模块级 `WeakMap` keyed by root + `randomBytes(SECRET_BYTES)`，**不落盘、不从密钥派生**），只能由服务本身给出。`dsh-lan-url` 行落地后从 `web-urls.txt` 取到 token，随后实测：

| 步骤 | 结果 |
|---|---|
| `GET http://<home-lan-ip>:3080/?token=<T>`（curl cookie jar） | **303** → `http://<home-lan-ip>:3080/`，并写入签名 cookie |
| 带 cookie `GET http://<home-lan-ip>:3080/` | **200**，27833 字节（LAN authority 上完整取到 SPA） |
| 该 HTML 中 `ownsHost` 出现次数 | **1**，且内容为 `<script>globalThis.__DSH_TRANSPORT__=Object.assign({},globalThis.__DSH_TRANSPORT__,{ownsHost:true});</script>`，位于 `<head>` 内、入口 bundle 之前 → `dsh-lan-owns-host` 行确认生效 |
| 带 cookie `POST /api` | **404**（不再是 401）→ cookie 已通过 RPC 桥的鉴权，404 只是该 method/path 无端点 |

验证用的临时 cookie jar 与下载的 HTML 已删除。

---

## 6. 日常使用与回滚

### 6.1 打开方式

在远端设备上打开（手机、平板或另一台电脑；token 由 `dsh-lan-url` 行维护在 `C:\Users\<user>\.dsh\web-urls.txt`，每行一个接口）：

```
http://<home-lan-ip>:3080/?token=<token>
```

本次进程的 token（重启会重新生成，旧 URL 随即失效）：

```
http://<home-lan-ip>:3080/?token=<本文件打包时已抹除；真实 token 见运行中的 $DSH_HOME/web-urls.txt>
```

> 打包说明：原文此处写着一个真实 token。它不是长期凭据（每个 `dsh web` 进程随机生成、
> 不落盘、进程重启即失效），但仍属于凭据，这份脱敏副本里已经抹除。

### 6.2 三个注意点

- 启动时打印的 `(LAN: ...)` 取 `lanAddresses[0]`，宿主机上是 `<stale-link-local>`（Tailscale 链路本地），**别的设备打不开**；`web-urls.txt` 里已把全部候选列全。
- `web-urls.txt` 是一份**活凭证**（equivalent to the printed URL）。不需要时删掉文件；不想让它被写，就删掉补丁里的 `- insert:` / `lan-url` 那条。token 本身也会随会话记录留在 `~/.dsh/sessions/` 里。
- token 在**同一进程内跨热重载保持有效**（WeakMap keyed by root context），但 `dsh web` 一重启就换新。

### 6.3 回滚

删除 `cordis.patch.yml` 里 `# ── LAN access ──` 之后的三个条目（`- id: webserver` 与两个 `- insert:`），热重载即回到 loopback-only；`C:\dsh-plugins\dsh-lan-owns-host\`、`C:\dsh-plugins\dsh-lan-url\` 可留着（不再被引用）或整个删掉；顺手删 `C:\Users\<user>\.dsh\web-urls.txt`。
（本仓库的 `config/fragments/01-lan-access.patch.yml` 是按同一形状写的分片，`config/uninstall.ps1` 按条目 id 摘除追加内容并先备份。）

### 6.4 残余风险（未变）

- **拿到那条带 token 的 URL = 拿到这台机器的完整控制权**：agent 以 danger-full-access 运行、本会话审批提示已禁用，能直接跑 `pwsh`；明文 HTTP 下 token/cookie 可被嗅探。
- 绑定 `0.0.0.0` 也意味着在 VMware host-only 网卡（`192.168.126.1`、`192.168.10.1`）上监听，实测同样可达。栅栏按 IP 字面量放行（上游设计如此）；要收紧就用防火墙把 3080 限定到特定源地址。
- `ownsHost` 只对「已经通过 token 与 Host 栅栏的页面」生效，不改变谁能进得来。

---

## 7. 设备归属日志：能不能知道消息来自哪台设备

### 7.1 结论：默认看不到

模型每轮只拿到 `role` + 正文；`MessageSource.kind` 只有 `user` / `model` / `tool` / `plugin`（生产者**类别**，不是身份，`dsh-llm/lib/types/message.d.ts`）；`clientId` 只存在于 `dsh-api-gateway` 的传输层状态里，在 `dsh-session`、API 控制器、持久化层**一次都不出现**；`dsh-host-webserver` 完全没有请求日志。所以消息事后无法归属到设备。

### 7.2 改动与记录格式

| 文件 | 改动 |
|---|---|
| `C:\dsh-plugins\dsh-api-attribution\package.json` + `index.js` | 新建：给 `ctx.webServer.server`（公开属性，未改任何第一方代码）`prependListener('request')` + `on('upgrade')`，把符合条件的请求追加到 `$DSH_HOME/api-calls.log` |
| `C:\Users\<user>\.dsh\profiles\web\cordis.patch.yml` | 第三个 `- insert:` 行：`api-attribution` |
| `C:\Users\<user>\.dsh\api-calls.log` | 运行期生成，纯文本追加、不轮转 |

记录格式（一行一个请求）：

```
2026-09-14T13:56:58.691Z  http     POST /api  host=127.0.0.1:3080  ua=DSH-AUDIT-PROBE/1.0 (loopback post)
2026-09-14T13:56:58.731Z  http     GET /api/remote.mux  host=<home-lan-ip>:3080  ua=DSH-AUDIT-PROBE/1.0 (lan get)
```

`host` 是设备**实际连进来的 authority** —— 这就是 loopback（`127.0.0.1:3080`）与局域网（`<home-lan-ip>:3080`）的分界；`ua` 区分手机/桌面。

**只记 `/api*` 和 `GET /`**：一次页面加载会拉几十个 bundle 与资源，全记会把信号埋掉。

### 7.3 验证证据

| 检查 | 结果 |
|---|---|
| `POST /api`（loopback，UA=PROBE） | 记录 1 行，`host=127.0.0.1:3080` |
| `GET /api/remote.mux`（LAN authority，UA=PROBE） | 记录 1 行，`host=<home-lan-ip>:3080` ← 归属生效 |
| `GET /manifest.webmanifest`（对照组，UA=PROBE） | **未记录**（资源被跳过） |
| 同一请求是否重复行 | 无重复（`ctx.effect` 的 disposer 在重激活时摘掉监听器） |

纯函数离线验证：`isInteresting` 对 `/`、`/api`、`/api/remote.mux` 为 true，对 `/plugins/*/client.js`、`/manifest.webmanifest` 为 false。

### 7.4 边界（重要）

- **这些行不会自动进入模型上下文。** 插件写的是文件；要知道某条消息来自哪台设备，需要有人去读那个日志（或直接问 agent）。
- 这是**监控**：所有能连到 GUI 的设备都会被记录，含 User-Agent。
- 日志是纯文本、**不轮转、不脱敏**；不需要时删掉文件，删掉 `api-attribution` 那条 insert 即停止记录。

### 7.5 回滚增量

在 §6.3 的基础上，再删掉 `- insert: / api-attribution` 那条，并删 `C:\Users\<user>\.dsh\api-calls.log`。

### 7.6 首次真实命中：手机（Android Edge）

日志里第一条真实 `session/prompt`：

```
2026-09-14T13:57:51.787Z  http  POST /api/session/prompt  host=<home-lan-ip>:3080
  ua=Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36 EdgA/152.0.0.0
```

- `host=<home-lan-ip>:3080` → 从 WLAN 接口进来，不是 loopback；`EdgA` = Android 版 Edge。
- 13:57:35 同一设备先有一次 `upgrade GET /api/remote.mux` 加整批 bootstrap 读（`agentPresets/list`、`llm/listProviders`、`session/list`、`commands/list`、`settings/describe`、`credentials/describe`…），随后 13:57:51 才是这条 prompt。
- 没有 `GET /` 行：该设备的 HTML 是在日志插件生效（13:56:58）**之前**加载的，重连不会重新取 HTML。
- 按 authority 统计：`<home-lan-ip>:3080` 17 行，`127.0.0.1:3080` 1 行（审计者的探测）。

### 7.7 更正/确认：这个版本没有"配置平面仅限 loopback"的服务端闸门

此前引用第三方插件注释说"harness 把 settings/credentials/agentPreset 钉死在 loopback"。在 **0.1.5-rc.2** 上核对：有效依赖树里搜不到 `PRIVILEGED_METHODS` 或 "authentication layer" 之类的钉死，`isLoopback` 只出现在**浏览器侧**（`dsh-api-gateway/lib/types/client/index.js:73-76`：`hostFacts = { home, isLoopback: this.connection.isLoopback }`，且注释写 "isLoopback is fixed for the page lifetime"）。

实测（同一 cookie 流程，只调只读端点，`{type,rpcId,method,payload:{args:{}}}`）：

| 端点 | LAN `<home-lan-ip>:3080` | loopback `127.0.0.1:3080` |
|---|---|---|
| `agentPresets/list` | `ok=true`，820 B | `ok=true`，820 B |
| `settings/describe` | `ok=true`，**30625 B** | `ok=true`，30625 B |
| `credentials/describe` | `gateway/arguments-invalid`（args 不全） | 同一错误、同 268 B |
| `session/list` | 同上，256 B | 同上，256 B |

**两边逐字节一致**：局域网客户端持有效 cookie 后，API 可达范围与 loopback 完全相同，包括配置平面。所以 `ownsHost` 之所以有效（§4.1），正是因为 loopback 判定只存在于浏览器里。同时这说明 §6.4 的风险要按字面理解：**拿到那条 URL 的人 = 你本人，权限上没有任何区分。**

---

## 8. 跨网络访问：走 Tailscale 的实测记录

### 8.1 现状实测

| 项 | 值 |
|---|---|
| 宿主机 tailnet 地址 | `<host-tailnet-ip>`（`admin.<tailnet>.ts.net`），账号 `<email>`（Google SSO） |
| 手机 | `<phone>` / **`<phone-tailnet-ip>`** / android / online |
| 公网 IPv4 | `<public-ip>`（STUN 观测），路由器 UPnP 可用 |
| NAT | `MappingVariesByDestIP: false`（端点无关映射 → 打洞容易） |
| IPv6 | 无全局 v6（只有 Tailscale ULA `fd7a:…`） |
| DERP | 最近香港 40.8ms；次近 142ms+ |
| `ShieldsUp` | false |

### 8.2 两道"以为是坎"的东西，实际只有一道

**❌ 更正：Windows 防火墙不是坎。** 一度据"`node.exe` 放行规则只覆盖 Public，而 Tailscale 网卡是 Private"判断入站 3080 会被丢。查了规则作用域后推翻：

```
Tailscale-In | Action=Allow | Profile=Domain,Private | Protocol=Any | LocalPort=Any
             | Program=Any | LocalAddress=<host-tailnet-ip> | RemoteAddress=Any
```

它按**本地目标地址**放行 Tailscale IP 上的一切入站（任意程序/端口），所以 Private 轮廓那点不影响。**教训：判防火墙要看规则的 LocalAddress/Program 作用域，不能只看 Profile。**

**✅ 真正的坎：DSH 的 `/api` Host 栅栏。** `dsh-web-app` 的 `trustedHosts` 只在**启动时采样一次**，而 Tailscale 的 100.x 是之后才上接口的 → 实测：

| Host | 修前 | 修后 |
|---|---|---|
| `<host-tailnet-ip>:3080` | **403** | **401**（放行，仅缺 token） |
| `admin.<tailnet>.ts.net:3080` | — | **401** |
| `127.0.0.1:3080` | 401 | 401 |
| `evil.example.com:3080` | 403 | **403**（防护仍在） |

修法：在 `~/.dsh/profiles/web/cordis.patch.yml` 覆盖 `connection` 行的 `trustedHosts`，用 `!!js` 在每次 compose/boot 时重新枚举非 internal IPv4，并显式加上 MagicDNS 名。这样 Tailscale / VPN / 后起的接口都会被收进来，不再是"启动时快照"。

### 8.3 端到端验证（走 tailnet IP）

| 步骤 | 结果 |
|---|---|
| `GET http://<host-tailnet-ip>:3080/?token=<T>` | **303** → `/`，下发 cookie |
| 带 cookie `GET /` | **200**，27833 字节 |
| 带 cookie `POST /api` | **404**（已鉴权通过） |
| `GET http://admin.<tailnet>.ts.net:3080/?token=<T>` | **303** |
| 归属日志 | 出现 `host=<host-tailnet-ip>:3080` 与 `host=admin.<tailnet>.ts.net:3080` 行 |

### 8.4 重要：token 会随重组/重启重新生成

本次热重载后 token 从 `DDbm…` 变成 `4HDF…`，**旧 URL 立即失效**。以 `C:\Users\<user>\.dsh\web-urls.txt` 为准（该文件已自动包含 tailnet 地址行，因为 `lan-url` 插件在 connection 行重载时重新枚举了接口）。

### 8.5 手机端登录卡点的结论

手机卡在"登录/加入 tailnet"这一步，根因是 **Tailscale 用 Google SSO**（`<email>`）而国内安卓缺 Google 服务；现已成功加入（Redmi K60E 在线），说明该步已解决。若之后换机或掉登录，可走：Headscale 自建（官方 Android 客户端支持 `Use an alternate server` + `Use an auth key`，无需 Google，见 [headscale 文档](https://raw.githubusercontent.com/juanfont/headscale/main/docs/usage/connect/android.md)）、EasyTier（无账号）、ZeroTier（邮箱注册）、蒲公英（国内账号）。注意 [tailscale#16001](https://github.com/tailscale/tailscale/issues/16001) 报告过"自定义服务器 + 预授权 key"在 Android 上的登录问题，投入前先验证。

### 8.6 两台真实设备首次接入：平板成功，手机卡在绕德中继

tailnet 三台设备：`admin`（宿主机 / 服务端）、`<phone>`（手机 `<phone-tailnet-ip>`）、`<pad>`（平板 `<pad-tailnet-ip>`）。

**平板：端到端成功。** `Get-NetTCPConnection` 的远端地址与归属日志时间戳完全吻合：

| 远端 | 设备 | TCP 建连时间 | 日志证据 |
|---|---|---|---|
| `<pad-tailnet-ip>` | Xiaomi Pad 5 | 09:48:27 / 09:48:28 | 01:48:14 与 01:48:27 两次 `upgrade /api/remote.mux`；01:48:28–32 完整 bootstrap（`agentPresets/list`、`skills/list`、`session/modelCatalog`、`settings/describe`、`credentials/describe`、`dynamicCordisRunner/*`、`present.host`、`$events/result`），共 49 条 tailnet 请求 |
| `<phone-tailnet-ip>` | Redmi K60E | 09:48:52 | 建连后仍在缓慢加载 |

**设备区分方法（归属日志的实用副产品）**：手机 UA 含 `Mobile`，Android 平板不含 —— 同一浏览器（Edge）也能一眼分开。

**手机为什么像"没连上"**：链路是 `relay nue`（纽伦堡），`CurAddr` 空、`Endpoints` 空、`direct connection not established`，`tailscale ping` 1.25–2.13 s；净速率约 **33 KB/s**（20 秒 669 KB）。对比平板是 `direct 10.2.195.130:55077` + 回退 `hkg`，ping **7 ms**。

**结论**：token / Host 栅栏 / 防火墙 / 服务端全部正确（手机早期那次 `GET /` 有 302+200 的交换对，且账户计数器显示已推送 13.5 MB 资源）。剩下的唯一瓶颈是**手机当前网络的 UDP 打洞失败并被甩到海外中继**——国内运营商 QoS 的典型症状。可选对策：自建国内 DERP（宿主机有公网 IPv4 `<public-ip>` + UPnP，或国内小 VPS）、手机侧重启 Tailscale/换网重试、或换 EasyTier；在家里直接用 `http://<home-lan-ip>:3080/` 则完全不走 VPN。

### 8.7 已解决：切网后打洞成功，手机走 tailnet 直连

用户切换 WiFi 重试后，**两台设备都变成直连**，无需任何配置改动：

| 设备 | 直连地址 | relay | ping |
|---|---|---|---|
| Redmi K60E（手机） | `10.129.197.147:26551` | `hkg`（仅兜底） | **4 ms** |
| Xiaomi Pad 5（平板） | `10.3.148.230:55077` | `hkg`（仅兜底） | 7 ms |

手机在 tailnet 上完成了首个完整会话，证据链完整：

```
02:12:41–46  bootstrap（skills/list、llm/listProviders、credentials/describe、
             subagents/list、commands/list、agentPresets/list、present.host）
02:12:4x     upgrade GET /api/remote.mux      ← 实时通道
02:13:00.606 POST /api/session/prompt  host=<host-tailnet-ip>:3080
             ua=…Android 10…Mobile…EdgA/152.0.0.0
```

即：**用户那条「切wifi重试了」本身就是从手机经虚拟局域网发出的**（`Get-NetTCPConnection` 同时显示 `<phone-tailnet-ip>` 持有两条已建立连接）。

**定论**：整条链路（0.0.0.0 绑定 → Host/Origin 栅栏放行 tailnet 与 MagicDNS → token 交换 → 30 天 cookie → WebSocket 流）全部可用；此前"没连上"纯粹是**手机所在网络的 UDP 打洞失败导致绕德中继**，换网即恢复。以后若再变慢，第一步应是 `tailscale ping <设备>` 看是否显示 `via DERP(...)`；是则重启客户端或换网，而不是改服务端配置。

**遗留权限现实（未变）**：两台 Android 设备与 token 持有者在 DSH 侧权限完全相同（见 §7.7）；归属日志只做事后识别，DSH 没有按设备授权。要真正的设备白名单只能用 Tailscale ACL。

---

## 9. 让 tailnet 设备用上宿主机的代理（Clash Verge）

### 9.1 现状

- 宿主机上跑 **Clash Verge Rev**：`verge-mihomo.exe`（PID 9456）监听 **`7897`**，绑定 **`::`（所有接口）** —— 即 Clash 的 mixed port，同时提供 HTTP 与 SOCKS5。
- 实测（经 tailnet 地址）：

| 路径 | 结果 |
|---|---|
| 直连 `https://api.ipify.org`（不经代理） | 失败（本地直连不通） |
| `http://<host-tailnet-ip>:7897` | 出口 **`<public-egress-ip>`** ✓ |
| `socks5h://<host-tailnet-ip>:7897` | 出口 **`<public-egress-ip>`** ✓ |
| 家里公网 IP（对照） | `<public-ip>` |

### 9.2 关键交互验证：设了代理会不会弄坏 DSH

手机设 Wi-Fi 代理后，**它访问 DSH 的请求也会进 Clash**，而 Tailscale 地址落在 `100.64.0.0/10`（CGNAT 段）。若 Clash 把它当普通流量丢给海外节点，DSH 就会坏。实测（经宿主机的 Clash 请求 DSH）：

| 目标 | 结果 |
|---|---|
| `http://<host-tailnet-ip>:3080/manifest.webmanifest` | **200** |
| `http://<home-lan-ip>:3080/manifest.webmanifest` | **200** |

→ Clash 按**直连**处理私网/CGNAT 目标，**DSH 不受影响**。

### 9.3 防火墙

- **tailnet 路径无需改动**：`Tailscale-In` 是 `Program=Any / Protocol=Any / LocalPort=Any / LocalAddress=<host-tailnet-ip>`，对任意程序放行（§8.2 的同一个发现）。
- **LAN 路径有缺口**：Clash 自建的放行规则只覆盖 `C:\program files\clash verge\clash-meta.exe`（Profile=**Public**），与实际进程名 **`verge-mihomo.exe`** 不符 → 若要让**家里 WiFi 上的其他设备**用 `<home-lan-ip>:7897`，需要补一条 Public 轮廓、指向 `verge-mihomo.exe` 的放行规则。无任何针对 mihomo/clash 的阻止规则。

### 9.4 用法与注意

Android：设置 → 网络和互联网 → WLAN → 长按网络 → 修改 → 高级 → 代理：手动 → 主机 `<host-tailnet-ip>` 端口 `7897`；**"绕过代理"里加上 `<host-tailnet-ip>,<home-lan-ip>,localhost`**（双保险，即使 Clash 规则变了也不影响 DSH 访问）。

- 只对 Wi-Fi 生效；蜂窝网络没有系统代理入口。部分自带网络栈的 App 会绕过系统代理。
- **7897 无鉴权**：任何能进 tailnet 的设备都能使用该代理。
- 验证方法：手机上打开 `https://api.ipify.org`，应显示 `<public-egress-ip>`；同时 DSH 页面应照常可用。

### 9.5 备选：exit node（本次未采用）

Tailscale 版本 **1.98.4**，支持 `--advertise-exit-node`（当前 `ExitNodeOption: False`）。但 exit node 转发的是 **IP 层**流量，不经 Windows 系统代理设置；而实测**没有 TUN 虚拟网卡**（只有 Tailscale 自己的网卡）→ Clash 当前是**系统代理模式**。因此想用 exit node 让手机全流量走 Clash，必须先把 Clash Verge 切到 **TUN 模式**，否则 exit node 只会"从家里宽带出去"而不经过代理。

---

## 10. 手机端"设置"界面布局修复

### 10.1 问题（实测复现，非猜测）

用无头（headless）Edge + CDP（Chrome DevTools Protocol）按 `412×915`（`Emulation.setDeviceMetricsOverride`，DPR 2）真实渲染 `http://127.0.0.1:3080/`，点开"设置"后测量：

```
[role=dialog][aria-modal]  364×800 @ (24,58)   flex-direction: row
  ├── nav                  188px  (navTitle + navList 竖排)
  └── div.content          176px  ← header + options 滚动区
        options: clientHeight 738 / scrollHeight 2023
```

即**桌面双栏布局被原样用在手机上**：内容区只剩 176px，标签被挤成"一字一行"竖排，**32 个元素溢出视口底部**。

### 10.2 修复

新增一个本地宿主插件 `C:\dsh-plugins\dsh-mobile-ui`（自写，无第三方），通过 `webserver/index-inject` 推一行 `kind: 'style'`，把 `@media (max-width: 820px)` 下的对话框改为全屏纵向布局：

- 面板 `position: fixed; inset: 0; width: 100vw; height: 100dvh; border-radius: 0; flex-direction: column`
- `nav` 变整宽顶部条，其列表 `nav > div:last-child` 变**横向可滚动**标签条
- `> div:last-child`（内容区）`flex:1; min-height:0; width:100%`，其内 `> div:last-child` 负责 `overflow-y:auto`

**选择器只用结构，不用类名** —— 实测类名是构建哈希（`VOzbGW_nav`），每次前端重建都会变；而 `role=dialog[aria-modal]` → `nav` + 末位子 div 的结构是该布局真正的契约。桌面端不受影响（媒体查询限定 ≤820px）。

### 10.3 验证（同一次测量，前后对比）

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 对话框 | 364×800 @ (24,58) | **412×915 @ (0,0)** |
| 导航栏 | 188px 竖排 | **412px 横向标签条**（高 102） |
| 内容区宽 | 176px | **412px** |
| options 高 | client 738 / scroll **2023** | client 759 / scroll **759**（完整放下，无需滚动） |
| 溢出视口底部元素 | **32** | **0** |
| 横向溢出 | 0 | 1（`Agent 预设` 标签超出 1px，标签条本身可横向滚动） |

截图对照：`02-settings.png`（前）vs `04-settings-after.png`（后）——这两张图与其产出脚本都不在本仓库内。样式注入也在服务出的 HTML 里核对过（`curl` 取 index 能搜到 `100dvh`）。

`scrollers: []` 曾被误读为"不可滚动"，实际是 `scrollHeight == clientHeight`（内容变矮后不再需要滚动）——**不存在被裁掉够不到的内容**。

### 10.4 使用、回滚与量测方法

手机上**重新加载页面**即可生效（样式在服务端注入进 HTML，已打开的页面不会自动更新）。桌面端 ≤820px 以下同样生效，以上完全不变。删除 profile 补丁里 `- insert:` 的 `dsh-mobile-ui` 那条（条目 id 为 `mobile-ui`）即恢复原样。

**量测方法**（工具本身不在本仓库内）：无头 Edge + CDP，指定视口后执行任意 JS 取几何、再截图；关键做法是**先量、再改、再量**，把 `getBoundingClientRect()` 与 `scrollWidth/scrollHeight` 的数字留下来，而不是只看截图觉得"顺眼了"。要复现，自备任意 CDP 客户端即可。

---

## 11. 复现清单

### 11.1 你需要什么

- 一台 Windows 宿主机，装 DSH `0.1.5-rc.2`，profile `web`，profile 补丁层为 `patchReload: live`。
- **审计材料**：本仓库 `third-party-audit/` 下的五个 tarball 与解包源码（`extract/<包名>/package/`），可直接与 §2 的逐行引用对照；`third-party-audit/lan-expose.patch.yml` 是 §5.1 里用到的组合验证补丁。
- **落地代码**：本仓库 `plugins/` 下的 `dsh-lan-owns-host`、`dsh-lan-url`、`dsh-api-attribution`、`dsh-mobile-ui`（零 npm 依赖，只用 `node:` 内建）；`config/fragments/01-lan-access.patch.yml` 是可追加进 profile 补丁的分片；`config/install.ps1` / `config/uninstall.ps1` 负责在 `C:\dsh-plugins\` 下建联接、追加缺失条目并先备份（默认 dry-run，加 `-Apply` 才写入）。
- **不在本仓库里的**：§10 的 CDP 量测脚本与前后截图的产出工具；运行期文件 `$DSH_HOME/web-urls.txt`（含活 token）与 `$DSH_HOME/api-calls.log`（监控记录）——这两类含凭据或设备信息，仓库里没有副本。
- 超出本文范围的仓库其余部分：Android 端的 DSHPad 壳、`gateway/lan-gateway`（私有域名 + HTTPS + mDNS 入口）。「两台机器的 DSH 互通」（TCP 网桥）已拆到独立仓库 [dsh-net-bridge](https://github.com/Eru07734/dsh-net-bridge)。

### 11.2 结论的适用范围

- §5 与 §8.3 的端到端结论来自 §1.1 所述的那一台宿主机（DSH `0.1.5-rc.2`、profile `web`）。
- 第三方包的行为描述来自对 tarball 的静态读码（§1.1）；落地时**未安装任何第三方包**（§4）。
- §8.6/§8.7 的 tailnet 观测数据是现场量测值（当时的运营商网络与 DERP 分布），不是普适性能指标。
