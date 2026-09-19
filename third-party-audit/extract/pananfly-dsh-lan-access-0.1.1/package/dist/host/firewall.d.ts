export declare function firewallRuleName(port: number): string;
export interface ToolResult {
    ok: boolean;
    out: string;
    err: string;
    missing?: boolean;
}
export type AsyncRunner = (cmd: string, args: readonly string[]) => Promise<ToolResult>;
export declare const defaultAsyncRunner: AsyncRunner;
export interface FirewallBackend {
    readonly label: string;
    ruleExists(port: number, isIPv6?: boolean): Promise<boolean>;
    addRule(port: number, isIPv6?: boolean): Promise<boolean>;
    removeRule(port: number, isIPv6?: boolean): Promise<boolean>;
}
export declare function detectFirewallBackend(platform: NodeJS.Platform, run?: AsyncRunner): Promise<FirewallBackend | undefined>;
export declare function firewallBackend(): Promise<FirewallBackend | undefined>;
export interface FirewallSummary {
    ok: boolean;
    managed: boolean;
    note?: string;
}
export declare function ensureFirewallRule(port: number, isIPv6?: boolean): Promise<boolean>;
export declare function removeFirewallRule(port: number, isIPv6?: boolean): Promise<boolean>;
export declare function computeFirewallSummary(port: number, lanEnabled: boolean, backend: FirewallBackend | undefined, isIPv6?: boolean): Promise<FirewallSummary>;
export declare const FIREWALL_SUMMARY_TTL_MS = 30000;
export declare function invalidateFirewallSummary(): void;
export declare function firewallSummary(port: number, lanEnabled: boolean, isIPv6?: boolean): Promise<FirewallSummary>;
//# sourceMappingURL=firewall.d.ts.map