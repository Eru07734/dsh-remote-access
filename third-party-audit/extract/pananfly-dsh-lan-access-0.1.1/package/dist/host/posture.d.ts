import type { ClientRequest, ClientRequestArgs } from "node:http";
export interface PostureHost {
    host: string;
    exposed: boolean;
}
export interface PostureSnapshot {
    checkedAt: number;
    hosts: PostureHost[];
}
export declare function anyExposed(snapshot: PostureSnapshot): boolean;
export declare function postureTargets(publicBaseUrl: string | undefined, lanAddresses: string[], port: number): string[];
export type ProbeRequest = (options: ClientRequestArgs, onStatus: (status: number) => void) => ClientRequest;
export interface ProbePostureOptions {
    port: number;
    targets: string[];
    request?: ProbeRequest;
    timeoutMs?: number;
    now?: () => number;
    loopbackHost?: string;
}
export declare function probePosture(options: ProbePostureOptions): Promise<PostureSnapshot>;
export declare function claimPostureKey(current: string | undefined, key: string): {
    run: boolean;
    next: string;
};
export declare function releasePostureKey(current: string | undefined, attempted: string): string | undefined;
//# sourceMappingURL=posture.d.ts.map