# `certs\` 为什么是空的：CA 私钥不进仓库

这份说明解决一个很具体的疑问——为什么 LAN Gateway 的证书目录里什么都没有，以及少了这些东西之后你要怎么把网关跑起来。它写给两类人：拿到这份仓库副本、想在自己机器上复现 `https://dsh.home.arpa` 的人，和来检查"这个仓库有没有顺手把私钥带出去"的人。读完你会知道哪些文件被故意排除、为什么排除是对的，以及复用旧 CA 和重签一套这两条路各自要做什么。

## 原来的 `certs\` 里有什么

宿主机上原来那个 LAN Gateway 目录的 `certs\` 里有这些文件：

| 文件 | 性质 | 是否复制进这份仓库副本 |
|---|---|---|
| `ca.key` | **CA（certificate authority，证书颁发机构）私钥（4096 位）** | ✗ 故意不复制 |
| `ca.crt` / `dsh-lan-ca.cer` | CA 公钥证书（装到设备信任库用的那份） | ✗ 见下 |
| `dsh.home.arpa.key` | **服务器私钥** | ✗ 故意不复制 |
| `dsh.home.arpa.crt` | 服务器公钥证书 | ✗ 离开私钥无用 |

## 为什么把它们排除在外

`ca.key` 能签发**任意域名**的证书，而网关自己的文档要求把这个 CA 装成每台设备的受信任根（见 `gateway/lan-gateway/README.md` 的"访问前必须做的两件事"）。把它放进一个准备被复制、归档、甚至提交的目录里是不对的，所以打包时没有带上。

公钥证书（`ca.crt` / `dsh-lan-ca.cer`）本身不含私钥，单独放出来并不直接泄密；但它在这份副本里没有用处——没有 `ca.key` 就签不出与新域名匹配的服务器证书，而现有服务器证书又只在原来的私钥在手时才能用。所以整体一起排除，让"这里没有可用凭据"这件事一眼可见。

原始文件仍在宿主机上它原来的网关目录里，没有被移动、也没有被改动。

## 想在这份仓库副本里把网关跑起来：两条路

**甲：复用现有 CA**（设备上已经装过这个 CA，不用重新装）

把宿主机上原网关目录里的证书整份拷进来：

```powershell
Copy-Item '<宿主机上原网关目录>\certs\*' gateway\lan-gateway\certs\ -Force
```

（把 `<宿主机上原网关目录>` 换成你自己的 `lan-gateway` 路径。）

**乙：重新签一套**（这份副本自足，但每台设备要重新装新的 CA）

```powershell
pwsh -File gateway\lan-gateway\gateway.ps1 stop
python gateway\lan-gateway\make-certs.py --domains dsh.home.arpa --ips <宿主机各网卡IP,逗号分隔>
# 把新生成的 certs\ca.crt 拷到每台设备上重装信任
pwsh -File gateway\lan-gateway\gateway.ps1 start
```

`make-certs.py` 需要 `cryptography`；它按 `--domains` / `--ips` 生成 CA 与服务器证书，SAN（Subject Alternative Name）覆盖列出的全部主机名与 IP。域名 / IP 与旧的不同，就要按网关 README 的表格在各设备上重装根证书。

两条路的区别只有一件事：**甲不用动各设备的信任库，乙必须重装**（因为新 CA 不是设备上已经信任的那个）。

## 两个容易踩的点

- **`--domains` 的顺序有意义**：第一个域名会成为叶子证书的 Common Name 和文件名，而 `proxy.py` 固定加载 `certs\dsh.home.arpa.crt` / `certs\dsh.home.arpa.key`。所以 `dsh.home.arpa` 必须放在第一个（除非你同时改反代的加载路径）。
- **幂等但不会自动跟着改 SAN**：`make-certs.py` 重跑时会**复用已有的 CA**（已经装到设备上的根证书继续有效），只重新签叶子证书。也正因为如此，改 `--domains` / `--ips` 之后必须重新跑一次，否则新域名 / 新网卡 IP 不在 SAN 里，浏览器依旧报错。
