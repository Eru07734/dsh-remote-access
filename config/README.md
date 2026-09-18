# 配置层：这 5 个插件是怎么被 DSH 装进去的

这份文档回答"把 `plugins/` 里的东西接到一个正在跑的 DSH 上，到底改了哪些文件、怎么改回来"。
读完你能自己完成安装、验证、卸载，也能判断一个新插件该走哪条通道。

只跟两条命令打交道：

```powershell
pwsh -File config\install.ps1          # 默认 dry-run：只打印计划，不写任何东西
pwsh -File config\install.ps1 -Apply   # 真装
pwsh -File config\uninstall.ps1 -Apply # 卸载
```

---

## 1. 先理解两件事：profile 与补丁层

- **profile** 是 DSH 的一组插件装配。它的补丁文件在
  `~/.dsh/profiles/<profile>/cordis.patch.yml`（`$DSH_HOME` 存在时以它为准），是一个**顶层 YAML 数组**的加载器补丁条目。
- **bundle 层**（`dsh plugin add` 装进来的包）只在**进程启动时**组合一次；
  **profile 补丁层**是 `patchReload: live` —— **写进文件即热重组，不用重启**。

这个差别决定了本仓库的两条经验：装完补丁条目立即生效，但**插件源码**的改动必须重启进程才生效
（用 [`tools/restart-harness.ps1`](../tools/restart-harness.ps1)，它带报告与校验）。

---

## 2. 两条互不相同的安装通道

| | 通道 A：bundle 包 | 通道 B：本地文件行 |
|---|---|---|
| 怎么声明 | `package.json` 里有 `dsh.bundle.patch`，包自带 `cordis.patch.yml` **自我注册** | 没有 `dsh` 字段，在 profile 补丁里用**绝对路径**挂一行 `- insert:` |
| 怎么装 | `dsh plugin --profile <profile> add "file:<目录>"` | 把分片条目追加进 `cordis.patch.yml` |
| 落到哪里 | 写 `profile.json` 与 lockfile，进 `node_modules` | 只在补丁文件里留一行；源码真身留在仓库 |
| 何时生效 | **只在进程启动时**组合 | `patchReload: live`，写进去即热重组 |
| 本仓库用量 | **0 个** | **5 个** |

**本仓库 4 个包全部走通道 B。** 原因很实际：它们不需要发布到 npm，源码真身就在本仓库里，
而通道 B 让"改一行源码 → 重启 → 生效"这条回路最短。install.ps1 的第 2 步（bundle 安装）
在这里是空转，但脚本仍然保留它 —— 两条通道的区别是 DSH 本身的，不是本仓库的。

| 包 | 作用 |
|---|---|
| `dsh-lan-owns-host` | 注入 `__DSH_TRANSPORT__.ownsHost`，让 LAN 页面上的设置能真正落盘 |
| `dsh-lan-url` | 把每个接口的带 token URL 写进 `$DSH_HOME/web-urls.txt` |
| `dsh-api-attribution` | 把 `/api*` 与 `GET /` 追加到 `$DSH_HOME/api-calls.log`（设备归属） |
| `dsh-mobile-ui` | 注入 `max-width:820px` 的样式，修手机/平板上的设置面板布局 |

---

## 3. 分片：可以直接追加进 profile 的补丁条目

`fragments/` 里的那个文件就是**profile 级补丁条目**，内容可以直接追加到
`$DSH_HOME/profiles/<profile>/cordis.patch.yml` 末尾。编号是**推荐的应用顺序**；
两个分片不会覆写同一个 id，所以顺序其实不敏感。

| 分片 | 内容 | 前置 |
|---|---|---|
| `01-lan-access.patch.yml` | `webserver` 绑 `0.0.0.0`；`connection` 的 `trustedHosts` 每次组合重推；4 条 insert（lan-owns-host、lan-url、api-attribution、mobile-ui） | 通道 B 的那 4 个小包 |

[`docs/03-live-profile-snapshot.yml`](../docs/03-live-profile-snapshot.yml) 是**一台机器上真实 profile 的对照快照**，只用来对照 —— `install.ps1` / `uninstall.ps1` 都不读它，它也不是任何步骤的输入。「两台机器的 DSH 互通」那部分（`dsh-net-bridge`）的条目已经从快照里移除，那部分现在在 [dsh-net-bridge](https://github.com/Eru07734/dsh-net-bridge)。
（它已经摘掉了与本仓库无关的行，但仍含那台机器特有的内容，例如 `subagent-acp` 的 ssh 目标、
MagicDNS 名、`C:/Users/<user>/...` 路径）。**不要整份覆盖回你的 profile**，只把上面两个分片追加进去。

---

## 4. 路径约定与联接

分片里写的是 `C:/dsh-plugins/<包名>`，这是本仓库采用的部署约定。`install.ps1` 的第 1 步会在
`C:\dsh-plugins\` 下为 `plugins/` 里的每个包建一个**目录联接（junction）**指回本仓库，
于是"分片不用改"和"源码只有一份真身"同时成立。

不想用联接也行，但那样你得自己把分片里的路径改成仓库的实际位置 —— 脚本不会替你改分片。

---

## 5. 一键安装

```powershell
pwsh -File config\install.ps1                                  # dry-run
pwsh -File config\install.ps1 -Apply                           # 真装
pwsh -File config\install.ps1 -Apply -Profile web -SkipBundles # 只装补丁条目
pwsh -File config\install.ps1 -Apply -RepointJunction          # 顺便改指向别处的联接
```

| 参数 | 默认 | 含义 |
|---|---|---|
| `-Profile` | `web` | 装进哪个 profile |
| `-PluginRoot` | `C:\dsh-plugins` | 联接建在哪里（与分片里的路径一致，所以分片不用改） |
| `-Apply` | 关 | 不加就是 dry-run，只打印计划 |
| `-SkipBundles` | 关 | 跳过第 2 步（本仓库没有 bundle 包，所以本来就空转） |
| `-RepointJunction` | 关 | 把指向别处的联接重新指向本仓库；不加就只报告、不动它 |

三步做的事：

1. **建联接**。已经是正确联接就跳过；指向别处或本身是**真目录**时，脚本**只报告、不删除**
   （它拒绝删除真目录，也拒绝悄悄改掉别人指好的联接）。
2. **bundle 包**（本仓库为空转）。`dsh` 不在 PATH 时，它会把该敲的命令打印出来让你自己执行。
3. **补丁条目**。按 **id** 判断是否已存在（一个条目只要有一个 id 已经出现就算存在），
   只追加缺失的；追加前把原文件备份成 `<profile>\cordis.patch.yml.bak-remote-access-<时间戳>`，
   并在追加块前写一行标记 `# ── dsh-remote-access (<时间戳>) ──`（早期版本写的是 `dsh-remote-kit`，两种标记卸载脚本都认，
   卸载时靠它识别"这段是脚本写的"）。

结尾如果出现 `source of truth — read this`，意思是：**这些包没有从本仓库供给** ——
`C:\dsh-plugins\<包名>` 下已经存在真目录或指向别处的联接，而分片是按绝对路径挂载的，
所以那台机器上的 profile 仍然在加载旧副本。要让本仓库成为唯一真身，把旧目录移开再 `-Apply`，
或对已经是联接的那些加 `-RepointJunction`。

---

## 6. 卸载与回滚

```powershell
pwsh -File config\uninstall.ps1          # dry-run
pwsh -File config\uninstall.ps1 -Apply
```

三步是安装的逆操作：

1. **摘补丁条目**。优先路径：找到安装时写下的 `# ── dsh-remote-access (<时间戳>)` 标记（早期版本写的是 `dsh-remote-kit`，同样认），
   **从标记开始整段删除** —— 这样你在这之前手写的同 id 条目不会被误伤。
   没有标记（说明分片是被手工合并进去的）时，退化为**按 id** 删除，并且会显式告警。
   无论走哪条路，改前都备份成 `cordis.patch.yml.bak-remote-access-uninstall-<时间戳>`。
2. **bundle 包**：逐个 `dsh plugin --profile <profile> remove <包名>`（本仓库为空转；
   如果这个包当初根本没装过，`remove` 会失败，脚本只告警）。
3. **删联接**：只删**确实指向本仓库**的联接；真目录一律不动。

卸载后记得两件事：重启 harness（让 bundle 层重新组合），以及 —— 如果你保留了 `dsh-lan-url` ——
`$DSH_HOME/web-urls.txt` 仍然是一份**活凭据**，脚本会提醒你删掉它。

---

## 7. 装完之后怎么确认

```powershell
# 让插件源码生效（带报告、带校验；参数按你的路径给）
pwsh -File tools\restart-harness.ps1 -Workspace <你的工作目录> -DelaySeconds 20

# 手工确认补丁条目组合进了新进程的树
dsh web --patch config\fragments\01-lan-access.patch.yml --dump-config
```

`restart-harness.ps1` 在重启后会检查这 5 个 id 是否都出现在 `--dump-config` 的输出里，
并把结果写进报告（`MISSING` 会列出到底缺哪个）。

### 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 脚本说 `'dsh' is not on PATH` | 它不会猜你的安装位置：按打印出来的命令自己执行一次 |
| `… is a real directory, not a junction — left alone` | 那台机器上 `C:\dsh-plugins\<包名>` 是真目录。移开它再 `-Apply`，脚本才会建联接 |
| `junction points at '…', not at this repo` | 联接指向别处。确认无误后加 `-RepointJunction` |
| 补丁条目没生效 | 先确认 profile 是 `patchReload: live`；**插件源码**的改动无论如何都要重启 |
| 卸载后功能还在 | 进程里的 bundle 层还没重组 —— 重启；如果用的是绝对路径条目，检查 `cordis.patch.yml` 里是否还有残留条目 |
| 想只用其中几个包 | 分片里的条目是独立的，按 id 删掉不想要的那几行即可（`01` 分片里的 4 条 insert 互不依赖） |
