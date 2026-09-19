# @pananfly/dsh-lan-access

> Repository: https://github.com/pananfly/dsh-lan-access · npm: `@pananfly/dsh-lan-access`

[中文](./README.zh.md) | **English**

Helper plugin for `dsh web` — a drop-in `webServer` that binds `127.0.0.1 | 0.0.0.0 | :: | specific LAN/Tailscale IP`, supports dual-stack and per-interface binding, keeps DSH's own `BrowserAuth` as the single auth source (process `?token=` + `HttpOnly;SameSite=Strict` 30-day HMAC cookie), and patches the client's `isLoopback` so remote sessions get a persistent `settingsScope`. Ships ops helpers (async firewall rule sync + Host-fence posture probe) while relying on official `directory-picker-auto` for seamless native/browse directory selection.

> **Trusted-network only.** Plain HTTP. Anyone with the `?token=` URL or the derived cookie has full UI access. Do not expose the port to the public internet without TLS/tunnel.

## What it does

- **Flexible `webServer` binding** — replaces official `webServer`, binds `127.0.0.1` (loopback), `0.0.0.0` (LAN IPv4), `::` (dual-stack with explicit `ipv6Only: false`), or any specific LAN / Tailscale IP.
- **Auth delegated to DSH** — `BrowserAuth` (`@deepseek-ai/dsh-client-connection`) remains the only gate: root `GET /?token=<256-bit>` mints an authority-bound `dsh-auth-<hash>=v1.<body>.<sig>` cookie (`30d; HttpOnly; SameSite=Strict`), and `/api` is additionally gated by the `Host` fence (`isLoopbackHostname || trustedHosts`) + `Origin == Host` + `Sec-Fetch-Site != cross-site`. This plugin performs **no request inspection**.
- **Optional `isLoopback` patch** — `--lan-patch` (or `DSH_LAN_PATCH=1`) makes `servePatchedBundle` buffer `/plugins` bundles served by the client module registry (including `??a,b&rev=...` combo URLs), defensively gunzips if needed, flexibly rewrites `isLoopback: true`, strips `content-encoding/length`, forces `cache-control: no-store`, and re-negotiates gzip. Remote `settingsScope` then resolves to `host` instead of `memory` (remote edits persist across reload).
- **Guaranteed LAN `trustedHosts` injection** — in `cordis.patch.yml`, `connection` explicitly injects `webStartup`, guaranteeing that `trustedHosts` receives private network literals, Tailscale IPs, and explicit `--trusted-host` arguments, eliminating 403 Host-fence blocking.
- **Non-blocking firewall sync** — asynchronously manages TCP allow rules (scoped with port names `dsh-lan-access (<port>)`), supporting `netsh` (Windows), `firewalld`/`ufw`/`iptables` (Linux, with `ip6tables` support on `::`).
- **Posture probe** — ~2.5 s after a LAN bind, probes loopback with forged LAN `Host` headers to verify fence traversal without false positives.
- **Official adaptive directory picker** — eliminates custom hybrid picker code and delegates directly to official `@deepseek-ai/dsh-host-directory-picker-auto`: loopback sessions automatically use native OS dialogs, while LAN and remote sessions use the official in-app directory browser.
- **`crypto.randomUUID` polyfill** — a `<head>` regex tap injects a guarded polyfill for non-secure `http://<lan-ip>` contexts.

## Architecture

```
browser --http://<host>:3080/--> webServer (polyfill, optional patch)
                                --> DSH host /api (Host fence + BrowserAuth)
                                --> Harness
```

| cordis row | id | provides | note |
|---|---|---|---|
| `web-lan-startup` | `@pananfly/dsh-lan-access/startup` | `webStartup{host, port, trustedHosts}` | replaces `web-startup`, validates bind host, gathers LAN & Tailscale IP literals |
| `web-lan-webserver` | `@pananfly/dsh-lan-access/webserver` | `webServer` (fakeRes compatibility + patch + polyfill) | replaces `webserver`, listens on configured IP/dual-stack, async firewall + posture probe |
| `directory-picker` | `@deepseek-ai/dsh-host-directory-picker-auto` | official | official adaptive chooser (native on loopback, browse on LAN/remote) |

## Usage

### Install

```sh
dsh plugin --profile web add @pananfly/dsh-lan-access
# or local development
dsh plugin --profile web add ./path/to/dsh-lan-access
```

### Host / env

| var / flag | default | description |
|---|---|---|
| `dsh web --host <host>` | `127.0.0.1` | Bind host: `127.0.0.1`, `0.0.0.0`, `::`, or specific LAN / Tailscale IP |
| `dsh web --port <n>` | `3080` | Listen port (`0` lets the OS pick). |
| `--no-open` | | Do not open the browser (headless servers). |
| `--trusted-host <authority...>` | | Extra authority for the `/api` Host fence (`host` or `host:port`, repeatable) — public IPs/domains. |
| `--lan-patch` | `false` | Enable `isLoopback` patch for persistent remote settings. |
| `DSH_LAN_PATCH` | `0` | Set `1` to enable `isLoopback` patch. |
| `connection.trustedHosts` | auto | Injected from `webStartup` automatically. |

### Examples

```sh
# 1. Loopback default
dsh web

# 2. LAN IPv4 bind-all
dsh web --host 0.0.0.0

# 3. Dual-stack bind (IPv4 + IPv6)
dsh web --host ::

# 4. Bind to specific interface (LAN IP or Tailscale IP)
dsh web --host 192.168.1.100
dsh web --host 100.64.0.5

# 5. LAN access with remote persistent settings (recommended: --lan-patch or DSH_LAN_PATCH=1)
dsh web --host 0.0.0.0 --lan-patch
# or: DSH_LAN_PATCH=1 dsh web --host 0.0.0.0

# 6. Reverse proxy / public domain
dsh web --host 0.0.0.0 --trusted-host dsh.example.com
```

Open the URL printed by `dsh web` (contains `?token=`) to mint a 30-day HMAC cookie.

## Development

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm publish --access public
```

## License

MIT