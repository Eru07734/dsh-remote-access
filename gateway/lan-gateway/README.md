# LAN Gateway：用私有域名把宿主机的服务暴露给局域网

这套脚本把宿主机（host machine）上的本地服务包装成 `https://dsh.home.arpa`：局域网内任意设备打开这个域名就能访问，带可信的 HTTPS，不用记 IP 和端口。它写给想用手机、平板或另一台电脑访问宿主机上 DSH（DeepSeek Harness）Web GUI 的人——读完本文你应该能自己把 `https://dsh.home.arpa` 跑起来，并给每台要访问的设备装上根证书。

当前已包装的服务：**DSH Web GUI**（`https://dsh.home.arpa` → `127.0.0.1:3080`）。

---

## 快速开始

在本仓库的 `gateway\lan-gateway\` 目录下执行：

```powershell
cd gateway\lan-gateway
.\gateway.ps1 start      # 启动反代 + mDNS
.\gateway.ps1 status     # 查看状态
.\gateway.ps1 stop       # 停止
.\gateway.ps1 restart    # 重启
.\gateway.ps1 logs       # 看日志
```

`gateway.ps1` 会拉起两个 Python 服务：反向代理（reverse proxy，443/TCP）与 mDNS 广播（Multicast DNS，5353/UDP），两者相互独立；`status` 会同时报告它们的监听状态和当前路由表。

> `gateway.ps1` 用变量 `$Py` 指定 Python 解释器，默认指向宿主机上一个预装了 `cryptography` 的 venv 里的 `python.exe`（`C:\Users\<user>\AppData\Local\hermes\hermes-agent\venv\Scripts\python.exe`）。换一台机器部署时，**这个路径要改成你自己的 Python**；`proxy.py` 与 `mdns.py` 本身只用标准库。

---

## 访问前必须做的两件事

### 1. 在每台要访问的设备上安装根证书（root certificate）

根证书公钥由 `make-certs.py` 生成在 `certs\ca.crt`。（仓库里也把这份 CA 公钥证书写作 `certs\dsh-lan-ca.cer`——`.cer` 只是换个扩展名，方便在 Windows 上双击安装，指的是同一份证书。）

不装证书，浏览器会报 `NET::ERR_CERT_AUTHORITY_INVALID`。把这份 CA 公钥证书拷到设备上安装：

| 设备 | 操作 |
|---|---|
| **Windows** | 双击证书文件（`.crt` / `.cer`）→ 安装证书 → 本地计算机 → 受信任的根证书颁发机构 |
| **macOS** | 双击 → 钥匙串访问 → 拖到"系统"→ 双击 → 信任 → 始终信任 |
| **iOS** | AirDrop/邮件打开 → 设置 → 已下载描述文件 → 安装；再到 设置 → 通用 → 关于本机 → 证书信任设置 → 打开开关（英文系统是 Settings → General → About → Certificate Trust Settings） |
| **Android** | 设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书 |

Windows 命令行安装（需管理员）：

```powershell
Import-Certificate -FilePath .\certs\ca.crt `
  -CertStoreLocation Cert:\LocalMachine\Root
```

### 2. 让 DSH 接受这个域名（改完**必须重启 DSH** 才生效）

DSH 内置了防 DNS 重绑定（DNS rebinding）护栏：非 loopback 的 Host 头（Host header）一律拒绝，返回 403。所以**只配反代不够**，必须把域名加入白名单。

宿主机上的 `C:\Users\<user>\.dsh\settings.yaml` 已经加上了这一段（改动前的原件备份在 `backup\settings.yaml.orig`，那份备份里没有 `client-connection` 一节）：

```yaml
client-connection:
  trustedHosts:
    - dsh.home.arpa
    - <pad>.<tailnet>.ts.net
    - <phone>.<tailnet>.ts.net
    - <pad-tailnet-ip>
    - <phone-tailnet-ip>
```

**但 DSH 只在启动时读配置，需要重启 DSH 才生效。** 重启后 `https://dsh.home.arpa/api/...` 才会从 403 变成正常。

怎么判断生效了：

| 观察到的响应 | 含义 |
|---|---|
| `403` | 配置还没生效 —— 重启 DSH |
| `401` | 已生效（401 是 DSH 自己的登录鉴权，正常） |

重启 DSH 后，首次访问要用带 token 的链接（token 见 `C:\Users\<user>\.dsh\web-urls.txt`）：

```
https://dsh.home.arpa/?token=<你的token>
```

### Tailscale 远端设备

DSH 的 Host 护栏**只自动信任宿主机自身网卡的 IP**（`<host-tailnet-ip>`、`<home-lan-ip>`、VMware 两个网段），远端 peer 及其 MagicDNS 名一律 403。所以上面显式放行了两个远端设备。

实测结论（重启前）：

| Host / 来源 | 结果 |
|---|---|
| `admin.<tailnet>.ts.net`（宿主机自身） | 放行（等于宿主机 IP） |
| `<host-tailnet-ip>`（宿主机自身） | 放行 |
| `<pad>.<tailnet>.ts.net` | **403 → 已加白名单** |
| `<phone>.<tailnet>.ts.net` | **403 → 已加白名单** |
| `<phone-tailnet-ip>` / `<pad-tailnet-ip>` | **403 → 已加白名单** |
| `dsh.home.arpa` | **403 → 已加白名单** |

设备侧访问地址（任选其一，证书都已覆盖）：

```
https://admin.<tailnet>.ts.net/?token=<你的token>
https://<host-tailnet-ip>/?token=<你的token>
```

> 这两个设备仍需**安装根证书**才能消除 HTTPS 警告。
> 若想彻底免装证书，可改用 Tailscale 自带的 HTTPS 证书（`tailscale cert admin.<tailnet>.ts.net`），但它需要占用 443 端口，与这个网关冲突——二选一，见下方"设计说明"。

---

## 域名解析原理

用 **mDNS 广播**把 `dsh.home.arpa` 解析到宿主机的各网卡 IP，不改路由器、不需管理员。mDNS 对以下客户端开箱即用：

- macOS / iOS —— 原生支持
- Linux —— 装了 avahi 即可
- **Windows —— 需要 Bonjour**（装 iTunes 或 [Bonjour Print Services](https://support.apple.com/kb/DL999)）

Windows 客户端若不想装 Bonjour，可临时改 hosts：

```
<home-lan-ip>  dsh.home.arpa
```

> `mdns.py` 在启动时枚举宿主机上所有可用的 IPv4 地址并逐个加入组播组，因此发布出来的地址就是宿主机当时的全部网卡地址。实测那次发布包含四个：`<home-lan-ip>`（WLAN）、`<host-tailnet-ip>`（Tailscale）、`192.168.10.1` / `192.168.126.1`（VMware）。

---

## 追加更多服务

```powershell
# 1. 加路由（写进 routes.json，反代启动时自动加载）
.\gateway.ps1 add nas.home.arpa 127.0.0.1 5000

# 2. 给新域名重签证书（否则浏览器报域名不匹配）
python .\make-certs.py --domains dsh.home.arpa,nas.home.arpa

# 3. 重启
.\gateway.ps1 restart
```

第 2 步用装了 `cryptography` 的解释器执行（`gateway.ps1` 内部用 `$Py` 指向它，`add` 命令也会把这个提示打出来）。

**域名顺序有意义**：`make-certs.py` 把 `--domains` 的**第一个**域名同时用作叶子证书的 Common Name 和文件名，而 `proxy.py` 固定加载 `certs\dsh.home.arpa.crt` / `certs\dsh.home.arpa.key`。所以 `dsh.home.arpa` 必须排在第一位，否则反代会因为找不到证书文件而起不来。

---

## 目录说明

| 文件 | 作用 |
|---|---|
| `proxy.py` | HTTPS 反代，443 → 后端。支持 WebSocket、HTTP/1.1、流式响应 |
| `mdns.py` | mDNS 广播，发布域名 A 记录。纯标准库 |
| `make-certs.py` | 签发本地 CA 与服务器证书（幂等，重跑不换 CA） |
| `gateway.ps1` | 启停控制脚本 |
| `install-autostart.ps1` | 注册开机自启计划任务（需管理员） |
| `certs\ca.crt` | **根证书公钥，拿去装到各设备** |
| `certs\ca.key` | CA 私钥，**不要外传**（本仓库不含它，见 `certs\README.md`） |
| `routes.json` | 域名路由表，不存在时用内置默认路由 |
| `logs\` | 运行日志 |

---

## 开机自启（可选，需管理员）

以管理员身份执行：

```powershell
pwsh -NoProfile -File .\install-autostart.ps1
```

它注册一个名为 `DSH-LAN-Gateway` 的计划任务，触发条件是**登录时**（不是开机时）：服务跑在你的用户会话下，也不需要你登录后再手点一下。验证与卸载命令见脚本运行完打印的提示。

---

## 排错

| 现象 | 原因与处理 |
|---|---|
| 域名解析不了 | 客户端不支持 mDNS（Windows 装 Bonjour），或换 hosts |
| 证书错误 | 根证书没装到该设备的信任库 |
| 页面能开但功能全挂、请求 403 | `trustedHosts` 未生效 —— **重启 DSH** |
| 请求 401 | 正常，是 DSH 登录鉴权，用带 token 的链接 |
| 443 起不来 | 被别的程序占用：`netstat -ano \| findstr :443` |
| 手机连不上 | 确认手机和电脑在同一 WiFi，且没开 AP 隔离 |
| `gateway.ps1 logs` 什么都不显示 | 该命令只收集 `logs\*.out`；而现在反向代理把日志写在 `logs\proxy.log`，`mdns.py` 的文件日志因为脚本里 `LOG_DIR` 未定义而生成不出来。直接看 `logs\proxy.log` |

---

## 设计说明（为什么这么做）

- **不用 `.local`**：mDNS 保留域，公共 CA 禁止为其签证书，且普通 DNS 服务器对它无效。改用 **`home.arpa`**（RFC 8375 专为家庭网络保留）。
- **不用 Caddy/nginx**：宿主机上没有，装一个只为两张证书不值当；纯标准库实现同样支持 WebSocket，且不会因 venv 重建而挂。
- **反代不改 Host 头**：DSH 的 Host 护栏靠它判断来源，改写会破坏鉴权语义，所以走官方 `trustedHosts` 白名单而非绕过。
- **控制脚本不用 `Get-CimInstance`**：在某些沙箱与语言模式下它静默返回空，会误报"服务未运行"；改用 PID 文件 + 端口实时状态双重校验。
- **绝不安杀 5353 端口上的进程**：宿主机上该端口同时被 msedge、adb、ChatGPT、svchost 占用，按端口杀会误杀你的浏览器。
- **443 端口归这个网关**：Tailscale 自带的 HTTPS 证书功能同样要占 443，两者冲突。当前选择这个网关（自签 CA + 私有域名，覆盖所有网卡），代价是每台设备装一次根证书。若更在意"免装证书"，可改为 `tailscale serve` 并停用这个网关的 443。
