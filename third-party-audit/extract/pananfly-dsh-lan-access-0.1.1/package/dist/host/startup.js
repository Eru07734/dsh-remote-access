import { collectLocalLanAddresses, isValidBindHost, normalizeHost } from "./net-utils.js";
import { Command } from "commander";
import { parseCmdline } from "@deepseek-ai/dsh-cmdline";
//#region src/host/startup.ts
const name = "lan-startup";
const inject = ["cmdlineArgs"];
const WEB_STARTUP_SERVICE = "webStartup";
const MAX_AUTO_TRUSTED_HOSTS = 32;
function webCommand() {
	return new Command().name("dsh --profile web").description("Serve the DeepSeek Harness browser UI with LAN access support.").helpOption("-h, --help", "show this help").option("--host <host>", "bind host (127.0.0.1 | 0.0.0.0 | :: | specific LAN/Tailscale IP)").option("--no-open", "do not open the Web UI in the default browser").option("--port <port>", "listen port; pass 0 to let the OS pick a free one").option("--trusted-host <authority...>", "extra authority the /api browser-trust fence accepts (host or host:port; repeatable)").option("--lan-patch", "enable isLoopback patch for remote persistent settingsScope").addHelpText("after", `
Examples:
  dsh web                                                              # 127.0.0.1:3080 loopback only
  dsh web --host 0.0.0.0                                               # LAN IPv4 (print LAN URL with token)
  dsh web --host ::                                                   # dual-stack [::] (covers 0.0.0.0 + IPv6)
  dsh web --host 192.168.1.100                                        # bind to specific LAN IP interface
  dsh web --host 100.64.0.5                                            # bind to Tailscale VPN interface
  dsh web --host :: --lan-patch                                       # remote settingsScope -> host (isLoopback:true patch)
  DSH_LAN_PATCH=1 dsh web --host 0.0.0.0                              # enable patch via environment variable
Env:
  DSH_LAN_PATCH=1           enable isLoopback patch for remote settingsScope (pageLocation.hostname -> true)
`);
}
function apply(ctx) {
	const program = webCommand();
	program.action(async () => {
		const opts = program.opts();
		if (opts.port !== void 0 && !/^\d+$/.test(String(opts.port))) program.error(`error: --port must be a number, got ${JSON.stringify(opts.port)}`);
		const requestedHost = opts.host;
		if (requestedHost !== void 0 && !isValidBindHost(requestedHost)) program.error(`error: --host must be a valid bind address (e.g. 127.0.0.1, 0.0.0.0, ::, or a valid private/Tailscale IP), got ${JSON.stringify(requestedHost)}`);
		const host = requestedHost ?? "127.0.0.1";
		const port = opts.port !== void 0 ? Number(opts.port) : void 0;
		const patch = Boolean(opts.lanPatch) || process.env.DSH_LAN_PATCH === "1";
		let trustedHosts = Array.isArray(opts.trustedHost) ? opts.trustedHost.flat() : opts.trustedHost ? [opts.trustedHost] : [];
		if (host === "0.0.0.0" || host === "::") {
			const detected = collectLocalLanAddresses({ includeIPv6: host === "::" });
			const merged = [.../* @__PURE__ */ new Set([...trustedHosts, ...detected])];
			if (merged.length > MAX_AUTO_TRUSTED_HOSTS) {
				const warn = `[dsh-lan-access] trustedHosts auto-fill capped at ${MAX_AUTO_TRUSTED_HOSTS} (had ${merged.length}), extra LAN literals dropped`;
				ctx.logger?.warn?.(warn);
				console.warn(warn);
			}
			trustedHosts = merged.slice(0, MAX_AUTO_TRUSTED_HOSTS);
		} else if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
			const norm = normalizeHost(host);
			if (norm && !trustedHosts.includes(norm)) trustedHosts = [norm, ...trustedHosts];
		}
		ctx.provide(WEB_STARTUP_SERVICE, {
			openBrowser: opts.open,
			host,
			...port !== void 0 ? { port } : {},
			trustedHosts,
			patch
		});
		const msg = `[dsh-lan-access] webServer configured on ${host}:${port ?? 3080} patch=${patch ? "enabled" : "disabled"} auth=token (BrowserAuth)`;
		ctx.logger?.info?.(msg);
		console.log(msg);
		if (host !== "127.0.0.1" && !patch) {
			const warn = `[dsh-lan-access] remote host ${host} without --lan-patch (or DSH_LAN_PATCH=1): settingsScope will be memory (remote edits lost on reload)`;
			ctx.logger?.warn?.(warn);
			console.warn(warn);
		}
	});
	parseCmdline(ctx, program);
}
//#endregion
export { WEB_STARTUP_SERVICE, apply, inject, name };
