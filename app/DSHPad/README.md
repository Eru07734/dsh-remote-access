# DSH Pad —— 把 DSH 的 Web GUI 装进 Android 平板

一个零第三方依赖的 Android WebView 壳：全屏加载宿主机上的 DSH Web GUI，粘贴一次带 token 的网址就能用，
认证 Cookie 落盘，返回键映射为页面后退，并补上了 WebView 缺失的文件选择器。

这份文档给**要自己构建、自己装、或者要改这个 App** 的人看。读者不需要读过仓库其他文档，
但需要知道一件事：**DSH 的浏览器面是靠一次性 token 换 Cookie 认证的**，App 的行为大半由这个机制决定。

- 当前版本：**1.2**，产物约 19 KB（`web/DSHPad.apk`）
- 依赖：无（不使用 AndroidX），只用系统 WebView

---

## 1. 它做什么、不做什么

**做**：

- 全屏 WebView 加载 DSH Web GUI
- 首次运行 / 认证失效时打开「连接设置」，粘贴 `dsh web` 打印的整条网址即可
- 自动从粘贴的网址里抽取 token 与服务器地址
- 认证 Cookie 持久化，App 重启后不用重新输入
- 返回键 = WebView 后退
- **文件与图片上传**：覆写了 WebView 缺失的 `onShowFileChooser`，composer 的「添加附件」能用

**不做**：没有通知、没有前台服务、没有后台常驻。这个壳只做"把 GUI 显示出来、把认证接上、把文件选择器补上"。
（会话等待 / 回合结束的通知曾经长在这个壳上，因为它与"从别的设备访问 DSH"这个主题无关，已从本仓库移出。）

---

## 2. 认证机制（先懂这个，后面的现象才讲得通）

DSH 的浏览器面不是匿名可访问的。`dsh-client-connection` 用**每进程随机生成的启动令牌**
（URL 里的 `token=` 查询参数）做一次换取：`GET /?token=...` 成功时下发一个**绑定请求 authority 的
签名 HttpOnly Cookie**，然后 303 跳到干净的 `/`。App 做的就是这一跳，之后全靠 Cookie。

三点必须知道：

1. **token 每个 `dsh web` 进程都不一样，且不持久化。** DSH 一重启，旧 token 立即失效
   —— 这就是"突然要重新连"的唯一常见原因。
2. **Host / Origin 围栏**：`/api` 请求要求 Host 是 loopback，或者落在 `trustedHosts` 里。
   由于宿主机把 `dsh web` 绑在 `0.0.0.0`（见 [`config/fragments/01-lan-access.patch.yml`](../../config/fragments/01-lan-access.patch.yml)），
   启动时的 `resolveLanTrust` 会把宿主机上所有非内部 IPv4（含 Tailscale 的 `100.x`）自动加进白名单，
   所以走 tailnet IP 访问**不需要**额外改配置。
3. **Cookie 有效期**由宿主机 profile 里的 `cookieMaxAgeDays` 决定。因此正常情况下一整个 `dsh web`
   进程的生命周期里只需要弄一次 token。

---

## 3. 连接一次

1. 在宿主机上拿到那条带 token 的网址。三个来源：
   - `dsh web` 启动时打印的那一行；
   - `$DSH_HOME/web-urls.txt`（由 `dsh-lan-url` 插件逐接口写入）；
   - 随附的 `get-dsh-token.ps1`（见 §7，token 过期后用它找回当前有效的那条）。
2. 打开 App → 若停在「连接设置」，把**整条网址**粘进「Token / 网址」栏。
   App 会自动抽取 token；「服务器地址」留空时同时采用网址里的地址。
3. **建议**：服务器地址显式填 `<host-tailnet-ip>:3080`，只粘贴 token。
   原因见 §7 最后一段 —— `dsh web` 打印的 LAN 地址不一定是 Tailscale IP。

页面顶部出现红色横幅 `认证失败 (401)` 就是 token 过期了：点它回到设置页，重新粘一次即可。

---

## 4. 文件与图片上传（实现要点）

WebView 里 `<input type="file">` **不会自己打开选择器**：它调用 `WebChromeClient.onShowFileChooser`，
不覆写的话默认返回 `false`，于是按钮**静默失效** —— 不报错、不弹窗、什么都不发生。这是 WebView 的既有行为，
不是页面 bug。

本 App 覆写了它：用 `FileChooserParams.createIntent()` 发系统选择器，在 `onActivityResult` 里用
`FileChooserParams.parseResult()` 回填（同时处理"单个 URI"与"多选 ClipData"两种返回形状）。

| 项 | 做法 | 为什么 |
|---|---|---|
| 用户取消 | **必须回填 `null`** | 否则页面下一次文件输入永远挂住 |
| 并发 | 发起新选择器前先把旧回调以 `null` 结掉；`onDestroy` 再兜一次 | WebView 同一时刻只接受一个活的回调 |
| 设备没有选择器 | 捕获 `ActivityNotFoundException` / `SecurityException` → 回 `null` + Toast | 不能让页面等一个永远不来的结果 |
| 权限 | **一个都没加** | 存储访问框架（SAF）按 URI 授权；`content://` 不受 `setAllowFileAccess(false)` 限制 |

上传走的是页面已有的链路：`XHR POST /api/session/uploadFileBinary`（`content-type: application/octet-stream`，
带 Cookie），宿主机侧由 `dsh-attachment-local` 接收 —— **宿主侧零改动**。

实测（Xiaomi Pad 5）：点「添加附件」→ 前台窗口变成 `com.google.android.documentsui/...PickActivity`；
选一个 64 B 文件 → composer 出现 `dshpad-upload-probe.txt TXT 64B`，宿主机附件库里落盘且**逐字节一致**
（中文 UTF-8 无损）。

> 测这个功能时注意：**合成 JS 的 `.click()` 不构成 user activation**，Chromium 会拒绝为它弹选择器。
> 必须用真实的触摸/鼠标事件（`adb shell input tap` 或 CDP 的 `Input.dispatchMouseEvent`）。

---

## 5. 自己构建

依赖：**Gradle 8.14.3 + AGP 8.13.0 + JDK 17+ + Android SDK platform 36**。

先建 `local.properties`。它含**逐机**的 SDK 绝对路径，已被 `.gitignore` 排除，克隆后需要自己创建：

```properties
sdk.dir=C\:\\Users\\<you>\\AppData\\Local\\Android\\Sdk
```

> 本工程在 `build.gradle` 里用的是 `buildscript classpath` 形式，而不是 `plugins {}` DSL ——
> 因为离线缓存里只有 `com.android.tools.build:gradle`，没有 `com.android.application:...gradle.plugin`
> 这个 plugin marker。

```powershell
$env:JAVA_HOME = "C:\Program Files\Java\jdk-22"
$gradle = "$env:USERPROFILE\.gradle\wrapper\dists\gradle-8.14.3-bin\<hash>\gradle-8.14.3\bin\gradle.bat"
& $gradle -p . assembleDebug --offline --console=plain
```

产物：`app/build/outputs/apk/debug/app-debug.apk`。本次仓库里的 `web/DSHPad.apk` 就是这么构建出来的
（19,558 B），不是把别处的构建拷进来。

---

## 6. 安装到设备

```powershell
adb install -r app\build\outputs\apk\debug\app-debug.apk
```

小米 / 红米设备若报 `INSTALL_FAILED_USER_RESTRICTED`，需要在平板上打开
**设置 → 开发者选项 → USB 安装**；否则只能把 APK 拷到设备上手动点击安装。

因为是明文 HTTP（`http://<host-tailnet-ip>:3080`），Manifest 里开了 `usesCleartextTraffic`。
这是在私有网络里访问自己机器的取舍，不是可以随手复制的默认值。

---

## 7. Token 失效后怎么恢复

**方式一（推荐）**：运行随附的 `get-dsh-token.ps1`。它先扫日志（`dsh web` 的启动行通常被重定向进了 `*.log`），
把找到的候选 token **逐个向服务器验证** —— 有效的回 303、过期的回 401 —— 所以它会直接打印当前真正
可用的那一条。这条路**不需要管理员权限**。

```powershell
.\get-dsh-token.ps1
```

日志里找不到时才回退到扫描 DSH 进程内存（那一步需要管理员权限）。跳过内存扫描加 `-SkipMemoryScan`。

**方式二**：直接看宿主机上 `dsh web` 启动时打印的那一行，整条粘进 App：

```
dsh web: http://127.0.0.1:3080/?token=XXXX (LAN: http://<host-tailnet-ip>:3080/?token=XXXX)
```

App 会自动提取 token；「服务器地址」留空则同时采用 URL 里的地址。
注意 `dsh web` 打印的 LAN 地址**不一定**是 Tailscale IP（取决于网卡枚举顺序），
所以稳妥做法是：服务器地址显式填 `<host-tailnet-ip>:3080`，只粘贴 token。

---

## 8. 分发：让设备用浏览器直接下载

设备不方便接 adb 时，用随附的零依赖静态服务把安装包挂到网页上：

```powershell
node serve-apk.js 8900
```

然后设备浏览器打开 `http://<host-tailnet-ip>:8900/`。页面给下载按钮和安装说明；
`/DSHPad.apk` 以 `application/vnd.android.package-archive` +
`content-disposition: attachment` 返回，浏览器会直接交给系统安装器。

改了 APK 之后记得同步 `web/` 目录里的副本（页面就是从那里取的）：

```powershell
Copy-Item app\build\outputs\apk\debug\app-debug.apk web\DSHPad.apk -Force
```

---

## 9. 文件说明

| 文件 | 作用 |
|---|---|
| `app/src/main/java/ai/deepseek/dshpad/MainActivity.java` | WebView 宿主 + token 换取 + 401 提示 + 文件选择器 |
| `app/src/main/java/ai/deepseek/dshpad/SettingsActivity.java` | 连接设置界面（服务器地址 / token） |
| `app/src/main/java/ai/deepseek/dshpad/Prefs.java` | 配置持久化与 URL / token 解析 |
| `get-dsh-token.ps1` | 从运行中的 DSH 进程取回当前有效 token |
| `serve-apk.js` | 零依赖静态服务，提供下载页与 APK |
| `web/index.html` · `web/DSHPad.apk` | 下载页与分发的安装包（**1.2**，约 19 KB） |

体积只作趋势参考：增量构建的 dex 布局会让同一份源码的包大小上下浮动几 KB，别拿它当"功能有没有"的判据。

---

## 10. 排错

| 现象 | 原因 / 处理 |
|---|---|
| 一直停在「连接设置」 | 没配过，或 token 已失效。跑 `get-dsh-token.ps1` 拿新的 |
| 顶部红色横幅 `认证失败 (401)` | token 过期（DSH 重启过）。重新粘贴一次 |
| 页面打不开、一直转 | 确认宿主机端口与地址：`<host-tailnet-ip>:3080`；确认远端设备在同一个 tailnet 里 |
| 点「添加附件」没反应 | 这正是 §4 说的问题。1.2 已修复；若你拿的是更早的构建，请更新 |
| 安装被系统拦下 | 见 §6（小米/红米需要开「USB 安装」） |
| 换了宿主机地址后没生效 | 保存后回到主界面即会重载；若没有，用溢出菜单的「重新加载」 |
