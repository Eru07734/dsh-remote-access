# dsh-lan-url

**把当前进程那条带 token 的网址落成文件**，免得去翻终端。零 npm 依赖。

第一次要把手机 / 平板接上宿主机、或者 token 被日志刷掉之后要找回来的人读这一页。

## 它补的缺口：token 只在内存里，而且只打印一次

浏览器入口 URL 带着一个**每进程随机生成**的启动令牌，它只活在内存里
（`dsh-client-connection/lib/index.js` 用模块级 `WeakMap`（以根 context 为键）持有，`randomBytes` 生成），
而 `dsh web` 只在启动时往自己的 stdout 打印一次。那行一旦滚走，想从别的设备连上就只剩两条路：
回去翻终端，或者重启进程换一个新 token。

## 它做什么

调的是 `dsh-web-app` 打印那行时用的**同一个第一方公开 API**：

```js
ctx.connection.authenticatedUrl(`http://<host>:<port>`)
```

对 loopback 加上宿主机上每一个非内部 IPv4 地址各调一次，然后把结果**每行一条**写进：

```
$DSH_HOME/web-urls.txt        # DSH_HOME 不存在时是 ~/.dsh/web-urls.txt
```

没有凭空生成、推导或绕过任何东西 —— token 来自活着的那个服务。文件在每次激活时重写
（token 能扛住 Connection 重载，因为 WeakMap 以根 context 为键；但**进程一重启就换新 token**）。

| 项 | 值 |
|---|---|
| 通道 | plain（绝对路径挂载） |
| `inject` | `['connection', 'webServer']` |
| 日志 | `lan-url: wrote <N> token-bearing URLs to <file>`；端口还没起来时是 `lan-url: webServer has no listening port yet; nothing written` |

## ⚠️ 这个文件是活凭据

`web-urls.txt` 里每一条 URL 都等于宿主机 DSH 的完整控制权（见根 README 的安全姿态一节）。
因此：

- 不需要它的时候就删掉；`.gitignore` 也拦着它，别提交。
- 想停止写出：从 profile 补丁里删掉那条 `id: lan-url` 的 insert。

## 单独装 / 单独关

- 装：`config/install.ps1 -Apply` 会一起装；只想装这一个，就把 `config/fragments/01-lan-access.patch.yml` 里那条 `id: lan-url` 的 insert 追加进 profile 补丁。
- 关：删掉那条 insert（`patchReload: live`，即改即生效），然后删掉 `web-urls.txt`。

## 怎么验证

```powershell
Get-Content "$env:USERPROFILE\.dsh\web-urls.txt"
```

应该看到逐接口一行、每条都带 `?token=`。用其中一条在远端设备上打开就能进 GUI。
