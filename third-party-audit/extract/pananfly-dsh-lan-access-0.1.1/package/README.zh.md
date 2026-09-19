# @pananfly/dsh-lan-access

> 仓库: https://github.com/pananfly/dsh-lan-access · npm: `@pananfly/dsh-lan-access`

[English](./README.md) | **中文**

`dsh web` 局域网/跨网卡访问辅助插件——替换官方 `webServer` 直接监听 `127.0.0.1 | 0.0.0.0 | :: | 指定局域网/Tailscale IP`，支持双栈与指定网卡绑定。鉴权完全委托给 DSH 自带的 `BrowserAuth`（进程级 `?token=` + `HttpOnly;SameSite=Strict` 30 天 HMAC Cookie），并打 `isLoopback` 补丁让远端会话拿到持久 `settingsScope`。附带运维助手（异步防火墙放行 + Host 围栏探针），目录选择由官方 `directory-picker-auto` 原生自适应。

> **仅受信网络使用。** 全程明文 HTTP，拿到 `?token=` URL 或对应 Cookie 即等同获得完整 UI 权限，不要将端口直接暴露到公网，必要时走 TLS/隧道。

## 功能

- **灵活直连 `webServer`** — 替换官方 `webServer`，支持 `127.0.0.1`（回环）、`0.0.0.0`（LAN IPv4）、`::`（双栈，显式 `ipv6Only: false`）、以及指定的本机局域网/Tailscale IP。
- **鉴权委托给 DSH** — `BrowserAuth`（`@deepseek-ai/dsh-client-connection`）是唯一门：根路径 `GET /?token=<256bit>` 换取 `dsh-auth-<hash>=v1.<body>.<sig>`（`30d HttpOnly;SameSite=Strict`），`/api` 再叠加 `Host` 围栏（`isLoopbackHostname || trustedHosts`）+ `Origin == Host` + `Sec-Fetch-Site != cross-site`。本插件**不做任何额外请求校验**。
- **可选 `isLoopback` 补丁** — 启用 `--lan-patch`（或 `DSH_LAN_PATCH=1`）时 `servePatchedBundle` 缓冲 `/plugins` 客户端模块包（含 `??a,b&rev=...` 合批 URL），弹性重写 `isLoopback: true`，去掉 `content-encoding/length`、命中时强制 `cache-control: no-store`、按客户端协商重压 gzip。远端 `settingsScope` 由此走 `host` 而非 `memory`（远端修改刷新不丢）。
- **LAN `trustedHosts` 自动注入与时序保证** — `cordis.patch.yml` 中 `connection` 显式注入 `webStartup`，从 `startup` 提取完整的私网与 Tailscale IP、用户指定的绑定 IP 以及 `--trusted-host`，彻底消除 403 围栏阻断问题。
- **异步防火墙放行** — 非阻塞异步执行防火墙规则放行（按端口隔离命名 `dsh-lan-access (<port>)`），支持 Windows `netsh`，Linux `firewalld`/`ufw`/`iptables`（监听 `::` 时同步支持 `ip6tables`）。
- **非阻塞 Posture 探针** — LAN 绑定约 2.5s 后，回环向本地伪造 `Host: <lan-ip:port>` 探针请求，校验 Host 围栏放行状态，探针不出网，杜绝假阳性。
- **自适应目录选择器** — 移除第三方冗余选择器代码，完全交由官方 `@deepseek-ai/dsh-host-directory-picker-auto` 原生驱动：本地回环自动调用原生 OS 文件对话框，局域网/远程/无头自动调用官方 Web 目录树浏览组件。
- **`crypto.randomUUID` 补丁** — `<head>` 正则注入守卫式 polyfill，兼容 `http://<lan-ip>` 非安全上下文。

## 架构

```
浏览器 --http://<host>:3080/--> webServer（polyfill + 可选 patch）
                               --> DSH host /api（Host 围栏 + BrowserAuth）
                               --> Harness
```

| cordis 行 | id | 提供 | 说明 |
|---|---|---|---|
| `web-lan-startup` | `@pananfly/dsh-lan-access/startup` | `webStartup{host, port, trustedHosts}` | 替换 `web-startup`，支持私网/Tailscale/双栈 IP 校验与 trustedHosts 采集 |
| `web-lan-webserver` | `@pananfly/dsh-lan-access/webserver` | `webServer`（fakeRes 规范兼容 + patch + polyfill） | 替换 `webserver`，监听指定 IP 或双栈，异步防火墙/探针 |
| `directory-picker` | `@deepseek-ai/dsh-host-directory-picker-auto` | 官方原生提供 | 官方原生自适应（回环走原生 OS 弹窗，局域网/远程走 browse） |

## 使用

### 安装

```sh
dsh plugin --profile web add @pananfly/dsh-lan-access
# 本地调试
dsh plugin --profile web add ./path/to/dsh-lan-access
```

### 变量/参数

| 变量/参数 | 默认 | 说明 |
|---|---|---|
| `dsh web --host <host>` | `127.0.0.1` | 监听地址，支持 `127.0.0.1`、`0.0.0.0`、`::`、指定物理局域网 IP 或 Tailscale IP |
| `dsh web --port <n>` | `3080` | 端口（`0` 由系统分配） |
| `--no-open` | | 不自动打开浏览器（headless 服务器） |
| `--trusted-host <authority...>` | | 追加 `/api` Host 围栏接受的 authority（`host` 或 `host:port`，可重复）——公网 IP/域名 |
| `--lan-patch` | `false` | 启用 `isLoopback` 补丁使远端设置持久化 |
| `DSH_LAN_PATCH` | `0` | 设为 `1` 启用 `isLoopback` 补丁 |
| `connection.trustedHosts` | 自动 | 由 `webStartup` 自动采集私网/Tailscale/指定 IP 并注入 |

### 示例

```sh
# 1. 默认回环
dsh web

# 2. LAN IPv4 全绑定
dsh web --host 0.0.0.0

# 3. 双栈全绑定（同时监听 IPv4 与 IPv6）
dsh web --host ::

# 4. 指定网卡绑定（如特定局域网 IP 或 Tailscale VPN IP）
dsh web --host 192.168.1.100
dsh web --host 100.64.0.5

# 5. 局域网模式 + 远端持久化设置（推荐使用 --lan-patch 或 DSH_LAN_PATCH=1）
dsh web --host 0.0.0.0 --lan-patch
# 或: DSH_LAN_PATCH=1 dsh web --host 0.0.0.0

# 6. 反向代理或公网穿透
dsh web --host 0.0.0.0 --trusted-host dsh.example.com
```

打开终端打印的含 `?token=` 的 URL 即可换取 30 天 Cookie。

## 开发

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm publish --access public
```

## 许可证

MIT