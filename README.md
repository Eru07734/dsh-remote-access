# dsh-remote-access

从**别的设备**访问、操作宿主机上的 **DSH（DeepSeek Harness）**。

DSH 是一个 agent 运行时（`dsh web` 会起一个 Web GUI），它默认只监听 `127.0.0.1` —— 也就是说，只有坐在那台机器前面的人能用它。
这个仓库把"离开那把椅子"所需的全部东西收在一起，并且把每一步的**取舍理由与实测证据**一并留下，而不是只留结论。

仓库的取舍只有一条判据：**它服务的是"从别的设备访问 / 操作宿主机上的 DSH"吗？** 不是就不在这里。
所以这里没有跟着长出来的一堆周边（会话通知、静态资源缓存、其它站点的 App 壳等），那些实现已经从本仓库移出。

本仓库现在只做一件事：**把浏览器面（DSH Web GUI）开放给别的设备**。曾经与它同仓的「两台机器的 DSH 互通」（TCP 网桥）已经拆到独立仓库 [dsh-net-bridge](https://github.com/Eru07734/dsh-net-bridge)。

> **本仓库是脱敏副本。** 用户名、IP、主机名、tailnet 名都换成了 `<...>` 占位符，对照表在
> **§8 安全姿态**。当文档读没问题，**照抄运行不行** —— 每条命令里的占位符都要换成你自己的值。

---

## 1. 先搞清楚这套东西在解决什么

三个具体问题，各自有对应组件：

| # | 你想要 | 靠什么 |
|---|---|---|
| 1 | 手机 / 平板 / 另一台电脑打开宿主机上的 DSH Web GUI | 把 webserver 绑到 `0.0.0.0` + 4 个宿主插件补上安全与可用性缺口。想让地址好记再叠 **lan-gateway**；想要一个原生 App 壳就用 **DSHPad** |
| 2 | 这条要能装、能回滚、能验证 | `config/`（补丁分片 + 一键装卸）、`tools/`（带报告的重启）、`docs/`（审计与判定记录） |

**为什么不是"开个端口、把 token 发过去"就完了**：那条带 token 的 URL 等于这台机器的完整控制权
（DSH 常在 danger-full-access 下运行、agent 能直接跑 `pwsh`），而 DSH **不按设备授权** ——
手机、平板、token 持有者权限完全相同。另外还有两个会直接把人绊倒的坑：`/api` 的 Host 栅栏，
以及 Tailscale 网卡起得比进程晚导致的白名单漏采样。三件事都在 [`docs/01-lan-access-audit.md`](docs/01-lan-access-audit.md) 里有实测记录。

---

## 2. 目录一览

```
dsh-remote-access\
├── plugins\            4 个宿主插件（见 §6），每个包自带一页 README
├── app\DSHPad\         Android WebView 壳（1.2）：把 DSH GUI 装进口袋
├── gateway\lan-gateway\ 可选入口：https://dsh.home.arpa（反代 + mDNS + 自签 CA）
├── config\             profile 补丁分片 + 一键安装 / 卸载脚本
├── tools\              带报告的原地重启，校验插件行真的组合进了新树
├── docs\               01 局域网审计 · 02 插件地图 · 03 profile 快照（对照用）
└── third-party-audit\  5 个第三方局域网插件的 tarball 与解包源码（逐字保真，见 §11）
```

---

## 3. 快速上手

前置：Windows、已经装好并能跑 `dsh web` 的 DSH、Node.js（插件只用 `node:` 内建）与 PowerShell 7。

```powershell
# 1. 先看它会做什么（默认 dry-run，不写任何东西）
pwsh -File config\install.ps1

# 2. 真装：在 C:\dsh-plugins 建目录联接 + 把缺失的补丁条目追加进 profile
pwsh -File config\install.ps1 -Apply

# 3. 让插件代码生效：带报告的原地重启
pwsh -File tools\restart-harness.ps1 -Workspace <你的工作目录> -DelaySeconds 20

# 4. 验证 4 条插件行都组合进了新进程的树
dsh web --patch config\fragments\01-lan-access.patch.yml --dump-config
```

拿到给远端设备用的那条带 token 的网址，有两个来源：`dsh web` 启动时打印的那一行，
或者 `dsh-lan-url` 写出的 `$DSH_HOME/web-urls.txt`（逐接口一行）。把整条 URL 粘进 DSHPad 即可（它会自动抽取 token 与地址）。

想回滚：`pwsh -File config\uninstall.ps1 -Apply`（先 dry-run 看一遍更稳妥）。

**两个可选组件的入口**：

| 想要 | 读 |
|---|---|
| 用域名 + HTTPS 访问，而不是记 IP 和端口 | [`gateway/lan-gateway/README.md`](gateway/lan-gateway/README.md) |
| 平板上有个 App，而不是浏览器标签页 | [`app/DSHPad/README.md`](app/DSHPad/README.md) |

---

## 4. 只用浏览器：什么都不装

远端设备**不需要安装任何东西** —— 系统自带的浏览器就够了。这是本仓库的主路径：宿主机侧把 §6 那 4 个插件装好之后，任何能访问到它的设备都能直接用。

前提：远端设备与宿主机在同一个局域网，或同一个 tailnet 里（明文 HTTP 的提醒见 §8）。

1. **拿网址** —— 宿主机上 `dsh web` 启动时打印的那一行，或者 `$DSH_HOME/web-urls.txt`（`dsh-lan-url` 逐接口写进去的，一行一条）。
2. **在远端设备上打开整条网址**。`GET /?token=…` 会让服务端下发一个签名 Cookie，然后 303 跳到干净的 `/`。
3. **之后只用地址**：`http://<宿主机地址>:3080/`。Cookie 是 `HttpOnly` + `SameSite=Strict` + `Max-Age` 30 天（由 profile 里的 `cookieMaxAgeDays` 决定），**只有 `dsh web` 重启才会失效**；失效后重做第 2 步。

| 纯浏览器可以做 | 纯浏览器做不到 |
|---|---|
| 完整 GUI：会话、工具调用与审批、文件 / 图片上传（`<input type="file">` 在浏览器里是原生能力，不需要客户端配合） | **系统通知与后台保活**：标签页一关就没有提醒。要"会话在等你时提醒"，得装 Android 壳 [`app/DSHPad`](app/DSHPad/README.md) |
| 手机 / 平板视口下可用的布局（`dsh-mobile-ui` 修的就是这一段） | 免粘贴 token 的冷启动：token 每次 `dsh web` 重启都会换 |
| 加到主屏幕当全屏应用用：服务端会发 `manifest.webmanifest`，其中 `display: "fullscreen"`、`start_url: "/"`、`short_name: "DSH"` | 明文 HTTP 下的"真安装"：Android Chrome 在非安全上下文里一般只给一个快捷方式；要 HTTPS（[`gateway/lan-gateway`](gateway/lan-gateway/README.md)）才会给 WebAPK |

**实测**（对着宿主机的活实例，用它的非 loopback 地址当"远端设备"；headless Edge + CDP 模拟 412×915 / DPR 2 的手机视口）：

| 检查 | 观察到的结果 |
|---|---|
| `GET /?token=…` | `303 SeeOther` → `Location: /`；`Set-Cookie: …; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict` |
| 带 Cookie 取页面 | `200`，29 KB。HTML 里**没有任何 loopback 绝对引用**（`127.0.0.1` / `localhost` 命中 0）—— 这是远端浏览器能用的前提 |
| 页面引用的每一个资源 | 逐个 `200`：入口 JS 543 KB、vendor JS 723 KB、两个 CSS、favicon、manifest，以及 10.9 MB 的 `/plugins/??…` 插件包 |
| `/api` 的 Host 栅栏 | 用真实 Host 取 `/api` 不是 `403`（栅栏放行）；伪造 `Host: evil.example.com` 被挡 |
| 真实渲染（412×915） | 标题 `DeepSeek Harness`；应用 shell 挂载 **19 个具名 slot**（`sidebar`、`main.conversation`、`conversation.composer`、`conversation.input.attachments` …），输入框与发送键都在 |
| 同视口下的设置面板 | 对话框实测 `412×915 @ (0,0)`、`position: fixed`、`border-radius: 0`；分区列表变成 `412×102` 的横向标签条、内容区 `412×813`；**纵向溢出 0**（`dsh-mobile-ui` 生效） |
| 设备归属 | 这些请求都进了 `$DSH_HOME/api-calls.log`，`host=` 是远端设备连的那个地址（`dsh-api-attribution` 生效） |

**没验证的**：真实手机浏览器（Android Chrome / iOS Safari）以及各平台"加到主屏幕"的实际行为 —— 上面是 headless Edge 的模拟视口，不是真机。

---
## 5. 术语表

| 词 | 在这里的含义 |
|---|---|
| **DSH（DeepSeek Harness）** | 要暴露的那个 agent 运行时。`dsh web` 起它的 Web GUI |
| **宿主机（host machine）** | 运行 `dsh web`、也就是被访问的那台机器 |
| **远端设备（remote device）** | 手机 / 平板 / 另一台电脑等发起访问的一方 |
| **profile 补丁 / 补丁层** | `~/.dsh/profiles/<profile>/cordis.patch.yml`：DSH 在 bundle 层之后叠加的自定义装配层。`patchReload: live` 表示写进去即热重组 |
| **宿主插件（host plugin）** | 跑在 DSH 宿主进程里的插件，即本仓库 `plugins/` 下的包 |
| **浏览器半边（browser half）** | 跑在浏览器 / WebView 里的客户端插件（`lib/client.js`）。**本仓库一个都没有** |
| **分片（fragment）** | `config/fragments/*.patch.yml`，可以直接追加进 profile 补丁的条目 |
| **联接（junction）** | Windows 目录联接：让 `C:\dsh-plugins\<name>` 指回本仓库里的源码，真身只有一份 |
| **tailnet / MagicDNS** | Tailscale 的私有网络与域名解析 |
| **占位符** | `<user>`、`<host-tailnet-ip>` 这类被替换掉的个人基础设施坐标，见 §8 |

---

## 6. 它是怎么做到的：profile 补丁 + 4 个宿主插件

`dsh web` 默认绑 loopback。要让别的设备连上，需要同时处理"能连上"和"连上之后不出问题"两件事，
所以是「profile 补丁 + 4 个宿主插件」的组合：

| 包 | 补的缺口（不装会怎样） | 挂的接缝 |
|---|---|---|
| `dsh-lan-owns-host` | 不注入 `__DSH_TRANSPORT__.ownsHost` 的话，LAN 页面上的设置写入会降级成 memory-only —— 看起来保存成功，刷新就没了 | `webserver/index-inject` |
| `dsh-lan-url` | DSH 只在启动时打印一次带 token 的网址。这个插件调 `ctx.connection.authenticatedUrl()`，把每个接口的 URL 写进 `$DSH_HOME/web-urls.txt`，省得去翻日志 | `connection` + `webServer` |
| `dsh-mobile-ui` | 为手机/平板视口注入一段 `max-width:820px` 的样式。修之前实测 412×915 下设置面板是双栏、内容区只剩 176px、32 个元素溢出视口 | `webserver/index-inject` |
| `dsh-api-attribution` | DSH 不归属消息来源：`MessageSource.kind` 只记生产者类别（`user`/`model`/`tool`/`plugin`），没有设备信息。这个插件把 `/api*` 与 `GET /` 追加到 `$DSH_HOME/api-calls.log`，是**事后识别**的唯一办法 | `webServer.server` 上的 `request` / `upgrade` 监听 |

profile 补丁同时改两行关键配置：`webserver` 绑 `0.0.0.0`，以及 `connection` 的 `trustedHosts`
——后者用 `!!js` 在**每次组合时**重推全部非内部 IPv4 + MagicDNS 名，因为上游只在启动时采样一次，
Tailscale 的 `100.x` 网卡起得晚就会被 403 拒掉。

> 为什么是自己写这 4 个插件而不是用现成的？——`third-party-audit/` 里躺着 5 个现成的局域网插件，
> 逐个读过、量过权限面，选型理由与证据在 [`docs/01`](docs/01-lan-access-audit.md)。

**可选叠加**：`gateway/lan-gateway` 把上面的服务包成 `https://dsh.home.arpa`（反代 + mDNS + 自签 CA），
局域网里任何设备用域名访问，不用记 IP 和端口；`app/DSHPad` 则是把 GUI 装进 Android 平板的一个 WebView 壳。

---

## 7. 安装 / 卸载

```powershell
# 只看计划（默认 dry-run，不写任何东西）
pwsh -File config\install.ps1

# 真装：建 C:\dsh-plugins 联接 + 追加缺失的补丁条目（改前自动备份）
pwsh -File config\install.ps1 -Apply

# 卸载：摘条目 + plugin remove + 删联接（同样先备份）
pwsh -File config\uninstall.ps1 -Apply
```

- **全部走 profile 补丁的绝对路径通道**：本仓库 4 个包都没有 `dsh.bundle.patch`，不进 `node_modules`。
  通道差异、分片顺序、路径约定见 [`config/README.md`](config/README.md)。
- 补丁层是 `patchReload: live`，**写进补丁文件即热重组**；但**插件源码**的改动仍然要重启才生效
  ——`tools/restart-harness.ps1` 就是为这件事写的：它停旧进程、起新进程、等首次 HTTP 应答、
  校验插件行真的组合进了新树，最后写一份带各阶段耗时的报告。
- 两个脚本都是**幂等**的：已存在的联接不会重建，已存在的条目不会重复追加，改动前一律先备份。
- **脱敏副本注意**：`tools/restart-harness.ps1` 的默认参数里带
  `<user>` 占位符路径，直接跑会找不到目录 —— 用之前传自己的 `-Workspace` / `-LogPath` / `-ReportPath`。

---

## 8. 安全姿态（照字面理解）

- **拿到那条带 token 的 URL = 拿到这台机器的完整控制权。** DSH 以 danger-full-access 运行、
  会话审批提示常被禁用，agent 能直接跑 `pwsh`；明文 HTTP 下 token 与 cookie 在局域网里可被嗅探。
  **DSH 没有按设备授权** —— 手机、平板、token 持有者权限完全相同（实测端点返回逐字节一致，
  见 [`docs/01`](docs/01-lan-access-audit.md) §7.7）。`api-calls.log` 只做事后识别。
  要真正的设备白名单，只能用 Tailscale ACL 或防火墙。
- **本仓库不含活凭据。** 以下文件**故意没有**收进来：`$DSH_HOME/web-urls.txt`（带 token 的 URL）、
  `$DSH_HOME/api-calls.log`（真实设备与 UA 记录）、
  `logs\`、`__pycache__\`。`.gitignore` 也拦着它们与 `*.key` / `*.pem`。全仓库扫
  token / `sk-` / `BEGIN … PRIVATE KEY` / `password=` / `Bearer` 形状：**零命中**。
- **占位符对照表**（脱敏只处理个人基础设施坐标，没有动任何结构性内容）：

  | 占位符 | 性质 |
  |---|---|
  | `<user>` | Windows 用户名（`C:\Users\<user>\...`） |
  | `<host-tailnet-ip>` `<pad-tailnet-ip>` `<phone-tailnet-ip>` | 各设备的 Tailscale 地址 |
  | `<home-lan-ip>` `<pad-lan-ip>` | 局域网地址 |
  | `<tailnet>` `<tailnet-login>` `<email>` | tailnet 名与账号 |
  | `<guest-pc>` | 虚拟机客户机的主机名 |
  | `<pad>` `<phone>` | 设备名 |
  | `<public-egress-ip>` `<public-ip>` | 出口公网地址（STUN 观测） |
  | `<stale-link-local>` | 已过期的链路本地地址 |

  **两处故意没动**：`third-party-audit/` 全程逐字保真（改它就是篡改审计材料；其中
  `192.168.1.100` 是上游作者自己的通用示例）；`studyzy@163.com` 是第三方插件作者的公开邮箱
  （本就发布在 npm 上），保留是对署名的尊重。

- **占位符落在标记语言里必须转义。** `<host-tailnet-ip>` 在 Markdown 的代码区外、在 XML / HTML 里
  都会被当成标签，结果是**文件坏掉或内容凭空消失**，不是"显示得难看一点"：

  | 位置 | 写法 |
  |---|---|
  | XML（`strings.xml`） | `&lt;host-tailnet-ip&gt;` —— 不转义 `aapt2` 直接报`元素类型必须由匹配的结束标记终止`，**整仓构建不了** |
  | HTML（`web/index.html`） | `&lt;host-tailnet-ip&gt;` —— 不转义该标签被浏览器吞掉，页面只剩 `:3080` |
  | Markdown 正文 | 用反引号包住（行内代码）；裸露会被 GitHub 的 HTML 清洗器抹掉 |
  | 代码 / YAML / 脚本 | 只要在字符串里就安全（已逐文件确认） |

  这三类位置本仓已全部修正。`app/DSHPad/web/DSHPad.apk` 也是**从这份脱敏源码构建**的
  （不是把原始构建拷进来）：二进制里能搜到 `host-tailnet-ip`（明文 UTF-8），却搜不到任何真实
  Tailscale 地址、tailnet 名、用户名或主机名 —— 也搜不到已经从仓库移出的那套通知实现。检查方法见 §9 验证状态。

---

## 9. 验证状态

跑过的和**没跑**的分开说 —— 这是本仓库的一贯写法，`docs/` 里也照此。

### 已跑通

| 检查 | 结果 |
|---|---|
| DSHPad 离线重建 | `gradle assembleDebug --offline` **成功**（JDK 22 + Gradle 8.14.3 + SDK android-36），产物 **19,558 B**，已同步到 `app/DSHPad/web/DSHPad.apk` |
| APK 二进制静态检查 | 能搜到 `host-tailnet-ip`；搜不到 `100.*` tailnet 地址、tailnet 名、用户名、主机名 |
| DSHPad 文件上传（真机） | 选择器打开 → 64 B 文件、0.72 MB PNG、391 KB PDF 三种都**逐字节落盘**（SHA-256 自算比对） |
| 本仓库 4 个宿主插件的自动化测试 | **没有**：验证方式是隔离实例实测与真机实测，证据在 docs/01 |
| 本仓库 4 个宿主插件的自动化测试 | **没有**：验证方式是隔离实例实测与真机实测，证据在 docs/01 |
| 本仓库 4 个宿主插件的自动化测试 | **没有**：验证方式是隔离实例实测与真机实测，证据在 docs/01 |
| 本仓库 4 个宿主插件的自动化测试 | **没有**：验证方式是隔离实例实测与真机实测，证据在 docs/01 |
| 局域网端到端 | 远端设备打开 GUI、发消息、拿回结果；证据与量测见 `docs/01` |
| Tailscale 实测 | 走 tailnet IP 访问可用（`trustedHosts` 重推那条补丁就是为它写的），见 `docs/01` |
| 手机端布局 | 412×915 前后几何对照，见 `docs/01` §10 |
| 纯浏览器路径（非 loopback 地址 + 手机视口） | token 交换 → Cookie → 页面与全部资源 200 → 412×915 下 shell 挂载 19 个具名 slot、设置面板满屏、纵向 0 溢出；逐项数值见 §4 |

### 未验证

| 项 | 为什么没跑 |
|---|---|
| `gateway/lan-gateway` 起停 | 需要证书与管理员权限改 hosts / 防火墙；`certs\` 已清空（原因见 `certs\README.md`） |
| `config/install.ps1 -Apply` 的真实写入 | 会改动**正在运行**的 profile；dry-run 已经证明识别逻辑正确 |
| 平板上的实际安装 | 表里的重建与静态检查是构建机做的；没有在真实设备上跑过这一版 |

---

## 10. 文档索引

| 文件 | 内容 | 谁该读 |
|---|---|---|
| [`docs/01-lan-access-audit.md`](docs/01-lan-access-audit.md) | **主文档**。5 个第三方局域网插件逐行审计 + 选型结论 + 落地方案 + 端到端验证证据 + Tailscale 实测 + 手机端布局修复 + 代理共存 | 想知道"为什么这么写"、要评估安全面的人 |
| [`docs/02-plugin-map.md`](docs/02-plugin-map.md) | 插件地图：三层构成、依赖的三个层次、两条安装通道、合成顺序，以及「新功能该放哪一层」的判定表 | 准备往里加功能的人 |
| [config/README.md](config/README.md) | 两种安装通道、补丁分片的依赖顺序、路径约定、装卸与回滚 | 负责部署的人 |
| plugins/<包名>/README.md | 4 个插件各自的缺口、接缝、单独安装与验证 | 要动插件的人 |
| [docs/03-live-profile-snapshot.yml](docs/03-live-profile-snapshot.yml) | 一台真实机器上 profile 的对照快照（不是配置输入） | 想知道「实际长什么样」的人 |
| [`app/DSHPad/README.md`](app/DSHPad/README.md) | 认证机制、构建命令、文件选择器的实现要点 | 要改 App 或自己构建的人 |
| [`gateway/lan-gateway/README.md`](gateway/lan-gateway/README.md) | 网关用法与各设备装根证书的步骤 | 想要域名 + HTTPS 入口的人 |

---

## 11. 许可

**MIT**，见 [`LICENSE`](LICENSE)。覆盖本仓库自己写的代码（`plugins/`、`app/`、`gateway/`、`tools/`、`config/`、`docs/`）。

**`third-party-audit/` 不在此列。** 那里是五个 MIT 协议 npm 包的**逐字副本**，作为审计材料保留，
各自仍归原作者版权所有，且各自随包附带 LICENSE：

| 包 | 作者 |
|---|---|
| `dsh-lan-access@0.1.3` | Leon0555 |
| `dsh-public-access@1.3.0` | JNan-QQ |
| `dsh-web-lan-access@1.3.2` | 包作者 |
| `@pananfly/dsh-lan-access@0.1.1` | pananfly |
| `@studyzy/dsh-web-remote-access@1.0.1` | studyzy |
