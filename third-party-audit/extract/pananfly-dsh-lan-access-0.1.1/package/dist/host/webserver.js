import { collectLocalLanAddresses } from "./net-utils.js";
import http, { createServer } from "node:http";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import * as zlib from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
//#region src/host/firewall.ts
const execFileAsync = promisify(execFile);
function firewallRuleName(port) {
	return `dsh-lan-access (${port})`;
}
const defaultAsyncRunner = async (cmd, args) => {
	try {
		const { stdout, stderr } = await execFileAsync(cmd, [...args], {
			windowsHide: process.platform === "win32",
			timeout: 15e3,
			encoding: "utf8"
		});
		return {
			ok: true,
			out: stdout ?? "",
			err: stderr ?? ""
		};
	} catch (err) {
		const isMissing = err.code === "ENOENT";
		return {
			ok: false,
			out: err.stdout ?? "",
			err: err.stderr ?? err.message ?? "",
			missing: isMissing
		};
	}
};
function netshBackend(run) {
	const show = async (port) => {
		const name = firewallRuleName(port);
		const result = await run("netsh", [
			"advfirewall",
			"firewall",
			"show",
			"rule",
			`name=${name}`,
			"verbose"
		]);
		return result.ok && result.out.includes(name);
	};
	return {
		label: "netsh",
		ruleExists: show,
		addRule: async (port) => {
			return (await run("netsh", [
				"advfirewall",
				"firewall",
				"add",
				"rule",
				`name=${firewallRuleName(port)}`,
				"dir=in",
				"action=allow",
				"protocol=TCP",
				`localport=${String(port)}`,
				"profile=private,domain"
			])).ok;
		},
		removeRule: async (port) => {
			if (!await show(port)) return true;
			return (await run("netsh", [
				"advfirewall",
				"firewall",
				"delete",
				"rule",
				`name=${firewallRuleName(port)}`
			])).ok;
		}
	};
}
function firewalldBackend(run) {
	return {
		label: "firewalld",
		ruleExists: async (port) => (await run("firewall-cmd", [
			"--permanent",
			"--query-port",
			`${String(port)}/tcp`
		])).ok,
		addRule: async (port) => {
			const add = await run("firewall-cmd", [
				"--permanent",
				"--add-port",
				`${String(port)}/tcp`
			]);
			const reload = await run("firewall-cmd", ["--reload"]);
			return add.ok && reload.ok;
		},
		removeRule: async (port) => {
			const del = await run("firewall-cmd", [
				"--permanent",
				"--remove-port",
				`${String(port)}/tcp`
			]);
			const reload = await run("firewall-cmd", ["--reload"]);
			return del.ok && reload.ok;
		}
	};
}
function ufwBackend(run) {
	return {
		label: "ufw",
		ruleExists: async (port) => {
			const result = await run("ufw", ["status"]);
			return result.ok && new RegExp(`(^|\\s)${String(port)}/tcp\\s+ALLOW`, "i").test(result.out);
		},
		addRule: async (port) => (await run("ufw", ["allow", `${String(port)}/tcp`])).ok,
		removeRule: async (port) => (await run("ufw", [
			"delete",
			"allow",
			`${String(port)}/tcp`
		])).ok
	};
}
function iptablesBackend(run) {
	const rule = (port) => [
		"INPUT",
		"-p",
		"tcp",
		"--dport",
		String(port),
		"-j",
		"ACCEPT"
	];
	return {
		label: "iptables",
		ruleExists: async (port, isIPv6) => {
			const v4 = (await run("iptables", ["-C", ...rule(port)])).ok;
			if (!isIPv6) return v4;
			const v6 = (await run("ip6tables", ["-C", ...rule(port)])).ok;
			return v4 && v6;
		},
		addRule: async (port, isIPv6) => {
			const r = rule(port);
			const v4 = await run("iptables", ["-A", ...r]);
			let v6Ok = true;
			if (isIPv6) v6Ok = (await run("ip6tables", ["-A", ...r])).ok;
			return v4.ok && v6Ok;
		},
		removeRule: async (port, isIPv6) => {
			const r = rule(port);
			const v4 = await run("iptables", ["-D", ...r]);
			let v6Ok = true;
			if (isIPv6) v6Ok = (await run("ip6tables", ["-D", ...r])).ok;
			return v4.ok || v6Ok;
		}
	};
}
async function toolAvailable(run, cmd) {
	try {
		return (await run(cmd, ["--version"])).missing !== true;
	} catch {
		return false;
	}
}
async function detectFirewallBackend(platform, run = defaultAsyncRunner) {
	if (platform === "win32") return netshBackend(run);
	if (platform !== "linux") return void 0;
	if (await toolAvailable(run, "firewall-cmd")) {
		if ((await run("firewall-cmd", ["--state"])).ok) return firewalldBackend(run);
	}
	if (await toolAvailable(run, "ufw")) return ufwBackend(run);
	if (await toolAvailable(run, "iptables")) return iptablesBackend(run);
}
let cachedBackend;
async function firewallBackend() {
	const platform = process.platform;
	if (cachedBackend === void 0 || cachedBackend.platform !== platform) cachedBackend = {
		platform,
		backend: await detectFirewallBackend(platform)
	};
	return cachedBackend.backend;
}
async function ensureFirewallRule(port, isIPv6 = false) {
	invalidateFirewallSummary();
	const backend = await firewallBackend();
	if (backend === void 0) return true;
	await backend.removeRule(port, isIPv6);
	return backend.addRule(port, isIPv6);
}
async function removeFirewallRule(port, isIPv6 = false) {
	invalidateFirewallSummary();
	const backend = await firewallBackend();
	if (backend === void 0) return true;
	return backend.removeRule(port, isIPv6);
}
async function computeFirewallSummary(port, lanEnabled, backend, isIPv6 = false) {
	if (backend === void 0) return {
		ok: true,
		managed: false
	};
	const exists = await backend.ruleExists(port, isIPv6);
	return {
		ok: lanEnabled ? exists : !exists,
		managed: true,
		note: backend.label
	};
}
let summaryCache;
function invalidateFirewallSummary() {
	summaryCache = void 0;
}
async function firewallSummary(port, lanEnabled, isIPv6 = false) {
	const key = `${String(port)}|${lanEnabled ? "1" : "0"}|${isIPv6 ? "1" : "0"}`;
	const now = Date.now();
	if (summaryCache !== void 0 && summaryCache.key === key && now - summaryCache.at < 3e4) return summaryCache.value;
	const value = await computeFirewallSummary(port, lanEnabled, await firewallBackend(), isIPv6);
	summaryCache = {
		key,
		at: now,
		value
	};
	return value;
}
//#endregion
//#region src/host/posture.ts
function postureTargets(publicBaseUrl, lanAddresses, port) {
	const targets = [];
	if (publicBaseUrl !== void 0) try {
		const url = new URL(publicBaseUrl);
		const authority = url.port === "" ? url.hostname : `${url.hostname}:${url.port}`;
		if (authority !== "") targets.push(authority);
	} catch {}
	for (const address of lanAddresses) targets.push(`${address}:${String(port)}`);
	return [...new Set(targets)];
}
const defaultRequest = (options, onStatus) => {
	const request = http.request(options, (response) => {
		onStatus(response.statusCode ?? 0);
	});
	request.on("error", () => {
		onStatus(0);
	});
	return request;
};
async function probeHost(port, targetHostHeader, request, timeoutMs, loopbackHost = "127.0.0.1") {
	return await new Promise((resolve) => {
		let settled = false;
		const finish = (exposed) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			handle.destroy();
			resolve(exposed);
		};
		const handle = request({
			host: loopbackHost,
			port,
			method: "POST",
			path: "/api/session.list",
			headers: {
				host: targetHostHeader,
				"content-type": "application/json"
			},
			timeout: timeoutMs
		}, (status) => {
			finish(status > 0 && status !== 403 && status < 500);
		});
		const timer = setTimeout(() => {
			finish(false);
		}, timeoutMs + 1e3);
		handle.on("error", () => {
			finish(false);
		});
		handle.end("{}");
	});
}
async function probePosture(options) {
	const { port, targets, loopbackHost } = options;
	const request = options.request ?? defaultRequest;
	const timeoutMs = options.timeoutMs ?? 3e3;
	const now = options.now ?? (() => Date.now());
	const hosts = [];
	for (const target of targets) hosts.push({
		host: target,
		exposed: await probeHost(port, target, request, timeoutMs, loopbackHost)
	});
	return {
		checkedAt: now(),
		hosts
	};
}
//#endregion
//#region src/host/webserver.ts
const PATCH_FROM = "isLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),";
const PATCH_FROM_SHORT = "isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),";
const PATCH_TO = "isLoopback: true,";
const PATCH_REGEX = /isLoopback:\s*transport\?\.ownsHost\s*===\s*true\s*\|\|\s*pageLocation\s*===\s*(?:void 0|undefined)\s*\|\|\s*isLoopbackHostname\(pageLocation\.hostname\),/g;
const PATCH_REGEX_SHORT = /isLoopback:\s*pageLocation\s*===\s*(?:void 0|undefined)\s*\|\|\s*isLoopbackHostname\(pageLocation\.hostname\),/g;
const PATCH_FLEXIBLE_REGEX = /isLoopback:\s*(?:transport\?\.ownsHost\s*===\s*true\s*\|\|\s*)?(?:pageLocation\s*===\s*(?:void 0|undefined)\s*\|\|\s*)?isLoopbackHostname\([a-zA-Z0-9_$.]+\),?/g;
const UUID_POLYFILL_SCRIPT = [
	"(function(){",
	"var g=typeof globalThis!==\"undefined\"?globalThis:typeof window!==\"undefined\"?window:self;",
	"if(typeof g.crypto===\"undefined\"){g.crypto={};}",
	"if(typeof g.crypto.randomUUID!==\"function\"){",
	"g.crypto.randomUUID=function(){",
	"var a=new Uint8Array(16);",
	"if(g.crypto.getRandomValues){g.crypto.getRandomValues(a);}",
	"else{for(var j=0;j<16;j++){a[j]=Math.random()*256|0;}}",
	"a[6]=(a[6]&0x0f)|0x40;",
	"a[8]=(a[8]&0x3f)|0x80;",
	"var h=\"\",x=\"0123456789abcdef\";",
	"for(var i=0;i<16;i++){h+=x[a[i]>>4]+x[a[i]&0x0f];",
	"if(i===3||i===5||i===7||i===9)h+=\"-\";}",
	"return h;",
	"};",
	"}",
	"})();"
].join("");
function buildPolyfillScript() {
	return "<script>" + UUID_POLYFILL_SCRIPT + "<\/script>";
}
function injectIntoHead(html, snippet) {
	const m = /<head(?:\s[^>]*)?>/i.exec(html);
	if (m) {
		const pos = m.index + m[0].length;
		return html.slice(0, pos) + snippet + html.slice(pos);
	}
	return snippet + html;
}
var WebServer = class extends Service {
	static Config = z.object({
		host: z.string().required(),
		port: z.natural().max(65535).required()
	});
	config;
	exact = /* @__PURE__ */ new Map();
	prefixes = /* @__PURE__ */ new Map();
	upgrades = /* @__PURE__ */ new Map();
	upgradedSockets = /* @__PURE__ */ new Set();
	indexTaps = [];
	fallback;
	server;
	listenedPort;
	patchEnabled = false;
	constructor(ctx, config) {
		super(ctx, "webServer");
		this.config = config;
	}
	get port() {
		return this.listenedPort;
	}
	get host() {
		return this.config.host;
	}
	register(route) {
		const table = route.kind === "exact" ? this.exact : this.prefixes;
		if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
		table.set(route.path, route);
		return () => {
			table.delete(route.path);
		};
	}
	registerUpgrade(route) {
		if (this.upgrades.has(route.path)) throw new Error(`webserver: duplicate upgrade route "${route.path}"`);
		this.upgrades.set(route.path, route);
		return () => {
			this.upgrades.delete(route.path);
		};
	}
	registerFallback(handler) {
		if (this.fallback !== void 0) throw new Error("webserver: fallback already registered");
		this.fallback = handler;
		return () => {
			this.fallback = void 0;
		};
	}
	tapIndex(transform) {
		this.indexTaps.push(transform);
		return () => {
			const at = this.indexTaps.indexOf(transform);
			if (at !== -1) this.indexTaps.splice(at, 1);
		};
	}
	applyIndexTaps(html) {
		let out = html;
		for (const t of this.indexTaps) out = t(out);
		return out;
	}
	collectIndexInjections() {
		const table = [];
		try {
			this.ctx.emit("webserver/index-inject", table);
		} catch {}
		return table;
	}
	renderIndex(html) {
		const rows = this.collectIndexInjections();
		let head = "";
		let body = "";
		for (const row of rows) {
			const escape = (v) => v.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
			let r;
			switch (row.kind) {
				case "global":
					r = {
						placement: "head",
						markup: `<script>globalThis[${JSON.stringify(row.name).replaceAll("<", "\\u003c")}] = ${row.value === void 0 ? "undefined" : JSON.stringify(row.value).replaceAll("<", "\\u003c")}<\/script>`
					};
					break;
				case "script":
					r = {
						placement: row.placement,
						markup: `<script>${row.text}<\/script>`
					};
					break;
				case "script-src":
					r = {
						placement: row.placement,
						markup: `<script src="${escape(row.src)}"><\/script>`
					};
					break;
				case "style":
					r = {
						placement: "head",
						markup: `<style>${row.text}</style>`
					};
					break;
				case "html":
					r = {
						placement: row.placement,
						markup: row.html
					};
					break;
				default: continue;
			}
			if (r.placement === "head") head += r.markup;
			else body += r.markup;
		}
		let out = html;
		if (head !== "") {
			const m = /<head(?:\s[^>]*)?>/i.exec(out);
			out = m ? `${out.slice(0, m.index + m[0].length)}${head}${out.slice(m.index + m[0].length)}` : `${head}${out}`;
		}
		if (body !== "") {
			const m = /<body(?:\s[^>]*)?>/i.exec(out);
			out = m ? `${out.slice(0, m.index + m[0].length)}${body}${out.slice(m.index + m[0].length)}` : `${out}${body}`;
		}
		return this.applyIndexTaps(out);
	}
	match(pathname) {
		const exact = this.exact.get(pathname);
		if (exact !== void 0) return exact;
		let best;
		for (const [prefix, route] of this.prefixes) {
			if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
			if (best === void 0 || prefix.length > best.path.length) best = route;
		}
		return best;
	}
	async servePatchedBundle(req, res, route) {
		if (!this.patchEnabled) return false;
		const chunks = [];
		let statusCode = 200;
		let headers = {};
		let headersSent = false;
		const fakeRes = {
			writeHead(code, hdrs) {
				statusCode = code;
				if (hdrs) headers = {
					...headers,
					...hdrs
				};
				headersSent = true;
			},
			setHeader(name, value) {
				headers[name.toLowerCase()] = value;
				return this;
			},
			getHeader(name) {
				return headers[name.toLowerCase()];
			},
			getHeaders() {
				return { ...headers };
			},
			hasHeader(name) {
				return name.toLowerCase() in headers;
			},
			removeHeader(name) {
				delete headers[name.toLowerCase()];
			},
			write(chunk) {
				if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
				return true;
			},
			end(chunk) {
				if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
			},
			get headersSent() {
				return headersSent;
			},
			get statusCode() {
				return statusCode;
			},
			set statusCode(code) {
				statusCode = code;
			}
		};
		try {
			await route.handler(req, fakeRes);
		} catch (e) {
			this.ctx.logger?.warn?.(e);
			return false;
		}
		if (!headersSent && chunks.length === 0) return false;
		const contentType = String(headers["content-type"] ?? headers["Content-Type"] ?? "");
		if (!(contentType.includes("javascript") || contentType.includes("text/javascript")) && chunks.length > 0) {
			res.writeHead(statusCode, headers);
			for (const c of chunks) res.write(c);
			res.end();
			return true;
		}
		let bodyBuf = Buffer.concat(chunks);
		const encoding = String(headers["content-encoding"] ?? headers["Content-Encoding"] ?? "").toLowerCase();
		let bodyStr;
		let wasGzipped = false;
		if (encoding.includes("gzip") && bodyBuf.length > 0) try {
			bodyStr = zlib.gunzipSync(bodyBuf).toString("utf8");
			wasGzipped = true;
		} catch {
			bodyStr = bodyBuf.toString("utf8");
		}
		else bodyStr = bodyBuf.toString("utf8");
		let patched = bodyStr;
		if (patched.includes(PATCH_FROM)) patched = patched.replaceAll(PATCH_FROM, PATCH_TO);
		if (patched.includes(PATCH_FROM_SHORT)) patched = patched.replaceAll(PATCH_FROM_SHORT, PATCH_TO);
		if (PATCH_REGEX.test(patched)) {
			PATCH_REGEX.lastIndex = 0;
			patched = patched.replace(PATCH_REGEX, PATCH_TO);
		}
		PATCH_REGEX.lastIndex = 0;
		if (PATCH_REGEX_SHORT.test(patched)) {
			PATCH_REGEX_SHORT.lastIndex = 0;
			patched = patched.replace(PATCH_REGEX_SHORT, PATCH_TO);
		}
		PATCH_REGEX_SHORT.lastIndex = 0;
		if (PATCH_FLEXIBLE_REGEX.test(patched)) {
			PATCH_FLEXIBLE_REGEX.lastIndex = 0;
			patched = patched.replace(PATCH_FLEXIBLE_REGEX, PATCH_TO);
		}
		PATCH_FLEXIBLE_REGEX.lastIndex = 0;
		const didPatch = patched !== bodyStr;
		if (didPatch) this.ctx.logger?.info?.(`[dsh-lan-access] patched /plugins bundle isLoopback:true`);
		else if (req.url?.includes("dsh-client-connection")) this.ctx.logger?.warn?.(`[dsh-lan-access] bundle dsh-client-connection was requested but isLoopback pattern was not matched; upstream format may have changed`);
		const outBuf = Buffer.from(patched, "utf8");
		const outHeaders = { ...headers };
		delete outHeaders["content-encoding"];
		delete outHeaders["Content-Encoding"];
		delete outHeaders["content-length"];
		delete outHeaders["Content-Length"];
		delete outHeaders["transfer-encoding"];
		delete outHeaders["Transfer-Encoding"];
		if (didPatch) outHeaders["cache-control"] = "no-store";
		if ((wasGzipped || /gzip/i.test(String(req.headers["accept-encoding"] ?? ""))) && outBuf.length > 0) {
			outHeaders["content-encoding"] = "gzip";
			outHeaders["vary"] = "Accept-Encoding";
			res.writeHead(statusCode, outHeaders);
			const gz = zlib.createGzip({ level: 6 });
			gz.on("error", () => {
				try {
					res.destroy();
				} catch {}
			});
			gz.end(outBuf);
			gz.pipe(res);
		} else {
			outHeaders["content-length"] = String(outBuf.length);
			res.writeHead(statusCode, outHeaders);
			res.end(outBuf);
		}
		return true;
	}
	async [Service.init]() {
		this.patchEnabled = Boolean(this.ctx.webStartup?.patch) || process.env.DSH_LAN_PATCH === "1";
		if (this.patchEnabled) this.ctx.logger?.info?.("[dsh-lan-access] patch enabled (--lan-patch / DSH_LAN_PATCH=1) in-memory");
		else this.ctx.logger?.info?.("[dsh-lan-access] patch disabled");
		const polyfill = buildPolyfillScript();
		this.tapIndex((html) => injectIntoHead(html, polyfill));
		this.ctx.logger?.info?.(`[dsh-lan-access] webServer polyfill injected for crypto.randomUUID`);
		const handle = async (req, res) => {
			let pathname;
			try {
				pathname = new URL(req.url ?? "/", "http://x").pathname.replace(/\/+/g, "/");
				if (!pathname.startsWith("/")) pathname = "/" + pathname;
			} catch {
				pathname = "/";
			}
			const route = this.match(pathname);
			if (route !== void 0) {
				if (this.patchEnabled && pathname.startsWith("/plugins")) {
					if (await this.servePatchedBundle(req, res, route)) return;
				}
				await route.handler(req, res);
				return;
			}
			const fallback = this.fallback;
			if (fallback === void 0) {
				res.writeHead(404);
				res.end();
				return;
			}
			await fallback(req, res);
		};
		this.server = createServer((req, res) => {
			handle(req, res).catch((err) => {
				this.ctx.logger?.warn?.(err instanceof Error ? err : new Error(String(err)));
				if (res.headersSent) {
					res.destroy?.();
					return;
				}
				res.writeHead(400);
				res.end();
			});
		});
		this.server.on("upgrade", (req, socket, head) => {
			const onError = (err) => {
				this.ctx.logger?.warn?.(err);
				socket.destroy();
			};
			socket.on("error", onError);
			socket.once("close", () => {
				socket.off("error", onError);
				this.upgradedSockets.delete(socket);
			});
			let pathname;
			try {
				pathname = new URL(req.url ?? "/", "http://x").pathname.replace(/\/+/g, "/");
			} catch {
				pathname = "/";
			}
			let route;
			try {
				route = this.upgrades.get(pathname);
			} catch (e) {
				this.ctx.logger?.warn?.(e);
				socket.destroy();
				return;
			}
			if (route === void 0) {
				socket.destroy();
				return;
			}
			this.upgradedSockets.add(socket);
			try {
				Promise.resolve(route.handler(req, socket, head)).catch((e) => {
					this.ctx.logger?.warn?.(e instanceof Error ? e : new Error(String(e)));
					socket.destroy();
				});
			} catch (e) {
				this.ctx.logger?.warn?.(e instanceof Error ? e : new Error(String(e)));
				socket.destroy();
			}
		});
		await new Promise((resolve, reject) => {
			this.server.once("error", reject);
			const listenOpts = {
				port: this.config.port,
				host: this.config.host
			};
			if (this.config.host === "::") listenOpts.ipv6Only = false;
			this.server.listen(listenOpts, () => {
				this.server.off("error", reject);
				this.server.on("error", (err) => {
					this.ctx.logger?.error?.(err);
				});
				this.listenedPort = this.server.address().port;
				const msg = `[dsh-lan-access] webServer listening on ${this.config.host}:${this.listenedPort} patch=${this.patchEnabled ? "enabled" : "disabled"}`;
				this.ctx.logger?.info?.(msg);
				console.log(msg);
				resolve();
			});
		});
		try {
			const isIPv6 = this.config.host === "::" || this.config.host.includes(":");
			const lanEnabled = this.config.host !== "127.0.0.1" && this.config.host !== "localhost" && this.config.host !== "::1";
			const port = this.listenedPort ?? this.config.port;
			if (port !== void 0) (async () => {
				try {
					if (!(lanEnabled ? await ensureFirewallRule(port, isIPv6) : await removeFirewallRule(port, isIPv6))) {
						const warn = `[dsh-lan-access] firewall rule sync failed for ${this.config.host}:${port} (elevated privileges may be required on ${process.platform})`;
						this.ctx.logger?.warn?.(warn);
					} else {
						const summary = await firewallSummary(port, lanEnabled, isIPv6);
						if (!summary.managed) this.ctx.logger?.info?.(`[dsh-lan-access] firewall unmanaged (${process.platform}), port ${port} no rule needed`);
						else if (!summary.ok) this.ctx.logger?.warn?.(`[dsh-lan-access] firewall rule mismatch: ${summary.note} port ${port} lan=${lanEnabled}`);
					}
				} catch (e) {
					this.ctx.logger?.warn?.(`[dsh-lan-access] firewall background sync error: ${e?.message ?? String(e)}`);
				}
			})();
		} catch (e) {
			this.ctx.logger?.warn?.(`[dsh-lan-access] firewall initialization error: ${String(e)}`);
		}
		try {
			const port = this.listenedPort ?? this.config.port;
			if (port !== void 0) {
				const targets = postureTargets(void 0, collectLocalLanAddresses({ includeIPv6: this.config.host === "::" }), port);
				if (targets.length > 0) {
					const loopback = this.config.host === "::1" ? "::1" : "127.0.0.1";
					const timer = setTimeout(() => {
						probePosture({
							port,
							targets,
							loopbackHost: loopback
						}).then((snap) => {
							const exposed = snap.hosts.filter((h) => h.exposed).length;
							if (exposed > 0) this.ctx.logger?.info?.(`[dsh-lan-access] posture: ${exposed}/${snap.hosts.length} LAN probes passed Host fence — BrowserAuth still required (token/cookie)`);
							else {
								this.ctx.logger?.warn?.(`[dsh-lan-access] posture: all ${snap.hosts.length} LAN probes 403 — Host fence blocked LAN, check --trusted-host`);
								console.warn(`[dsh-lan-access] posture: all LAN probes returned 403 — LAN clients will get 403 even with valid token; check --trusted-host`);
							}
						}).catch(() => {});
					}, 2500);
					timer.unref?.();
					this.ctx.effect(() => () => clearTimeout(timer), "webServer:posture-probe");
				}
			}
		} catch {}
		this.ctx.effect(() => async () => {
			const serverClosed = new Promise((resolve) => {
				this.server.close(() => resolve());
			});
			this.server.closeAllConnections();
			const upgradedClosed = [...this.upgradedSockets].map((s) => new Promise((resolve) => {
				s.once("close", () => resolve());
				s.destroy();
			}));
			await Promise.all([serverClosed, ...upgradedClosed]);
		}, "webServer.listen");
	}
};
const name = "lan-webserver";
const inject = ["webStartup"];
//#endregion
export { WebServer, WebServer as default, inject, name };
