# dsh-lan-owns-host

**让"从局域网打开的那个页面"被当成宿主机自己的页面。** 只补一个布尔字段，别的什么都不做。

要改 DSH 前端行为、或者好奇"为什么 LAN 页面上改设置不落盘"的人读这一页。

## 它补的缺口：LAN 页面的设置只活在内存里

上游浏览器半边 `@deepseek-ai/dsh-client-connection` 这样判断"这是不是本机页面"：

```js
isLoopback: transport?.ownsHost === true || pageLocation === void 0
            || isLoopbackHostname(pageLocation.hostname)
```

而随包发布的装配**从不设置** `__DSH_TRANSPORT__.ownsHost`。于是从 LAN 地址打开的页面被判为非 loopback，
两个设置客户端因此降级（在已安装的包里核对过）：

| 包 | 降级后的行为 |
|---|---|
| `dsh-client-ui-settings/lib/client.js` | `persistence = ctx.remote.$host.isLoopback ? "host" : "memory"` —— 设置只写内存，不进宿主机 `settings.yaml` |
| `dsh-client-ui-settings-general/lib/client.js` | `documentController = isLoopback ? new SettingsDocumentStore(…) : void 0` —— 原始设置文档编辑器根本不挂载 |

表现就是：在手机上改设置"保存成功"，刷新一下全没了。

## 它做什么

往 webserver 的结构化注入表里推一行 `kind: 'script'`、`placement: 'head'`，内容是：

```js
globalThis.__DSH_TRANSPORT__=Object.assign({},globalThis.__DSH_TRANSPORT__,{ownsHost:true});
```

`Object.assign` 是为了不覆盖 shell 可能已经放进去的字段。

| 项 | 值 |
|---|---|
| 通道 | plain（绝对路径挂载） |
| `inject` | `['webServer']` |
| 接缝 | `ctx.on('webserver/index-inject')` |

## 它不放开任何权限

能打开那个页面，本身就已经需要进程启动令牌（或它换来的签名 Cookie）+ 一个能过 `/api` Host 栅栏的 Host。
这一行只影响**用户已经到达的那个页面**如何被分类。

## 单独装 / 单独关

- 装：`config/install.ps1 -Apply` 会一起装；只想装这一个，就把 `config/fragments/01-lan-access.patch.yml` 里那条 `id: lan-owns-host` 的 insert 追加进 profile 补丁。
- 关：从 profile 补丁里删掉那条 insert（profile 是 `patchReload: live`，改完即热重组，不用重启进程）。

## 怎么验证

1. 用远端设备打开 `http://<宿主机地址>:3080/?token=…`。
2. 打开开发者工具，看 `<head>` 里是否有 `__DSH_TRANSPORT__…ownsHost:true` 那行脚本。
3. 改一个设置 → 刷新页面 → 设置还在（并且宿主机 `settings.yaml` 里真的写进去了）。
