# dsh-lan-access

让 DeepSeek Harness Web GUI 可在局域网内被其他设备访问的 DSH 插件（可信内网专用）。

[![npm version](https://img.shields.io/npm/v/dsh-lan-access)](https://www.npmjs.com/package/dsh-lan-access)
[![License](https://img.shields.io/npm/l/dsh-lan-access)](LICENSE)

- **npm**: https://www.npmjs.com/package/dsh-lan-access
- **GitHub**: https://github.com/Leon0555/dsh-lan-access

## 功能

1. **局域网绑定**：把 webserver 的 `host` 改为 `0.0.0.0`，手机/其他电脑可通过
   `http://<运行DSH设备的IP>:3080` 访问（查 IP：`ipconfig getifaddr en0`）。
2. **crypto.randomUUID polyfill**：浏览器只在安全上下文（HTTPS/localhost）暴露
   `crypto.randomUUID`，局域网明文 HTTP 下不存在，会导致 DSH 的 RPC 全部失败
   （项目/会话列表加载不出、无法添加工作区）。本插件向每次返回的 index.html
   注入兜底实现（标准 UUID v4，`crypto.getRandomValues` 生成），任何设备的
   浏览器访问都正常。
3. **手机/窄屏自动适配**（v0.1.2+）：屏幕宽度 ≤820px 时自动切换为紧凑移动排版，
   无需任何配置。包括：
   - 字号压缩与排版收紧（消息流、代码块、标题层级）
   - 输入框 `font-size:16px`，规避 iOS 聚焦自动放大
   - 按钮加大触控目标、去除点击延迟（`touch-action:manipulation`）
   - 弹层/对话框全屏化（100dvh + 安全区适配），模型选择等浮层固定定位防遮挡
   - 深色/浅色主题下均生效（跟随 DSH 本身）

   > 适配 CSS 移植自 [dsh-lan-gate](https://github.com/hchao3335-maker/dsh-lan-gate)
   > （MIT License），取其窄屏兜底层，仅保留排版适配，不含其网关/审批功能。

## 安装（从 npm）

```sh
dsh plugin --profile web add dsh-lan-access
```

> 需要 pnpm（`npm i -g pnpm`）。本地开发安装可用
> `dsh plugin --profile web add file:/path/to/dsh-lan-access`。

安装后重启服务生效：

```sh
launchctl kickstart -k gui/$(id -u)/com.dsh.web   # 如果用 launchd 常驻
```

## 卸载

```sh
dsh plugin --profile web remove dsh-lan-access
```

卸载后 webserver 恢复默认仅 `127.0.0.1`，polyfill 不再注入。

## 安全提醒

- 绑定 `0.0.0.0` 后，同一网络内任何设备都能连接 DSH（**无认证**），
  等于整网都能触达本机的命令执行能力。**仅限家庭/公司可信内网使用**，
  公共 WiFi 请勿开启。
- 建议：路由器/防火墙限制来源 IP；出外网访问请叠加 Tailscale 等隧道。

## 远程访问限制（安全设计，本插件有意不绕过）

DSH 把"配置平面"——**设置页、模型/Provider 管理、凭据、Agent Preset、
目录选择、`llm.discoverModels`（模型探测）**等接口——**硬性限制为仅本机回环
（127.0.0.1）可访问**。即使本插件将 Web 服务绑定到 `0.0.0.0`，这些接口从
局域网 IP 访问仍会返回 `HTTP 403`（如"加载提供方目录失败: ... HTTP 403"）。

这是 DSH 官方刻意的安全边界（`dsh-client-connection` 的 `PRIVILEGED_METHODS`）：
`trustedHosts` 白名单只是 DNS 反绑定栅栏，**不是认证**；在真正的认证层出现
之前，设置/凭据域必须保持仅本机可访问。

**本插件不绕过这个栅栏**，也不提供代理/端口转发去改写请求头——那会把设置与
凭据侦察能力暴露给局域网内任何设备，违背 DSH 的安全设计。

### 远程（局域网）可用 vs 不可用

| ✅ 远程正常 | ❌ HTTP 403（仅本机回环） |
|---|---|
| 对话、实时进度 | 设置页（模型、Provider 配置） |
| 会话内模型选择（`llm.providers` / `llm.models`） | 凭据管理（`credentials.*`） |
| 会话历史、工作区浏览 | Agent Preset 管理 |
| 其余正常 API | 目录选择（`host.pickDirectory`）、`llm.discoverModels` |

### 远程需要改设置怎么办

- **日常路径**：在 Mac 本机（`http://127.0.0.1:3080`）完成模型/凭据配置，
  远程设备只用于对话、看进度、选模型。
- **唯一合规的完整方案**：SSH 本地端口转发
  `ssh -L 3080:127.0.0.1:3080 用户@MacIP`，然后访问 `http://127.0.0.1:3080`
  ——从服务端视角这仍是回环访问（不绕过栅栏），且自带 SSH 认证。
  ⚠️ 需开启 Mac 的"远程登录"；SSH 会把命令行访问权限交给能登录的人，
  请自行评估风险。
- 期待官方后续加入真正的认证层后，配置平面可以安全地开放给局域网。

## 技术说明

- 绑定：以 bundle patch 覆盖 `webserver` 行（`host: 0.0.0.0`，port 保持
  `ctx.webStartup.port ?? 3080` 表达式）。
- polyfill：代码行注入 `webServer`，用官方预留的 `tapIndex` 钩子向
  index.html `<head>` 注入内联脚本；带幂等守卫，非安全上下文才生效，
  本机 localhost 访问不受影响。
- 手机适配：同一 `tapIndex` 注入 `<style>`（`@media (max-width:820px)` 兜底层，
  选择器针对 DSH 的 `data-slot` / `data-chat-flow` / `data-composer-card` /
  `role="dialog"` 等稳定结构属性）。

## 许可证

MIT © Leon0555
