import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
//#region src/host/net-utils.ts
/**
* IPv4 private and internal ranges:
* - RFC 1918: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
* - Loopback: 127.0.0.0/8
* - Link-local: 169.254.0.0/16
* - Tailscale CGNAT: 100.64.0.0/10 (100.64.0.0 - 100.127.255.255)
*/
function isPrivateIPv4(addr) {
	const parts = addr.split(".").map(Number);
	if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
	const [a, b] = parts;
	if (a === 10) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 127) return true;
	if (a === 169 && b === 254) return true;
	if (a === 100 && b >= 64 && b <= 127) return true;
	return false;
}
/**
* Check whether a hostname is a loopback address.
*/
function isLoopbackHost(host) {
	const clean = host.toLowerCase().replace(/^\[|\]$/g, "");
	return clean === "localhost" || clean === "127.0.0.1" || clean === "::1" || clean.startsWith("127.");
}
/**
* Normalize an IPv4 or IPv6 address for Host header / authority comparison.
* - IPv4: returns standard dotted quad
* - IPv6: returns bracketed lowercase address, e.g. `[240e:...:1]`
*/
function normalizeHost(addr) {
	if (!addr) return void 0;
	const clean = addr.replace(/^\[|\]$/g, "");
	if (clean.includes(":")) {
		const bare = clean.split("%")[0] ?? "";
		if (!bare || bare === "::1" || bare === "::") return void 0;
		const low = bare.toLowerCase();
		if (!low.includes(":")) return void 0;
		return `[${low}]`;
	}
	if (isPrivateIPv4(clean)) return clean;
}
/**
* Validate whether a host string can be bound by the web server.
* Allows loopback, 0.0.0.0, ::, and any valid private/Tailscale IPv4 or IPv6 IP.
*/
function isValidBindHost(host) {
	if (!host) return false;
	if (host === "127.0.0.1" || host === "0.0.0.0" || host === "::" || host === "::1" || host === "localhost") return true;
	const clean = host.replace(/^\[|\]$/g, "");
	const ipVer = isIP(clean);
	if (ipVer === 4) return isPrivateIPv4(clean);
	if (ipVer === 6) return true;
	return false;
}
/**
* Collect network interface addresses for trustedHosts auto-fill and posture probes.
*/
function collectLocalLanAddresses(options) {
	try {
		const ifs = Object.values(networkInterfaces()).flat().filter(Boolean);
		const addrs = [];
		for (const i of ifs) {
			if (i.internal) continue;
			const fam = i.family;
			const addr = i.address;
			if (fam === "IPv4" || fam === 4) {
				const h = normalizeHost(addr);
				if (h) addrs.push(h);
			} else if ((fam === "IPv6" || fam === 6) && options.includeIPv6) {
				const h = normalizeHost(addr);
				if (h) addrs.push(h);
			}
		}
		return [...new Set(addrs)];
	} catch {
		return [];
	}
}
//#endregion
export { collectLocalLanAddresses, isLoopbackHost, isPrivateIPv4, isValidBindHost, normalizeHost };
