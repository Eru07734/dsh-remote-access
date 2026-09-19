/**
 * IPv4 private and internal ranges:
 * - RFC 1918: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
 * - Loopback: 127.0.0.0/8
 * - Link-local: 169.254.0.0/16
 * - Tailscale CGNAT: 100.64.0.0/10 (100.64.0.0 - 100.127.255.255)
 */
export declare function isPrivateIPv4(addr: string): boolean;
/**
 * Check whether a hostname is a loopback address.
 */
export declare function isLoopbackHost(host: string): boolean;
/**
 * Normalize an IPv4 or IPv6 address for Host header / authority comparison.
 * - IPv4: returns standard dotted quad
 * - IPv6: returns bracketed lowercase address, e.g. `[240e:...:1]`
 */
export declare function normalizeHost(addr: string): string | undefined;
/**
 * Validate whether a host string can be bound by the web server.
 * Allows loopback, 0.0.0.0, ::, and any valid private/Tailscale IPv4 or IPv6 IP.
 */
export declare function isValidBindHost(host: string): boolean;
/**
 * Collect network interface addresses for trustedHosts auto-fill and posture probes.
 */
export declare function collectLocalLanAddresses(options: {
    includeIPv6: boolean;
}): string[];
//# sourceMappingURL=net-utils.d.ts.map