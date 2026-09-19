import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
export declare class WebServer extends Service {
    static Config: z<Schemastery.ObjectS<{
        host: z<string, string>;
        port: z<number, number>;
    }>, Schemastery.ObjectT<{
        host: z<string, string>;
        port: z<number, number>;
    }>>;
    config: {
        host: string;
        port: number;
    };
    exact: Map<string, any>;
    prefixes: Map<string, any>;
    upgrades: Map<string, any>;
    upgradedSockets: Set<Socket>;
    indexTaps: Array<(html: string) => string>;
    fallback: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined;
    server: ReturnType<typeof createServer> | undefined;
    listenedPort: number | undefined;
    patchEnabled: boolean;
    constructor(ctx: any, config: any);
    get port(): number | undefined;
    get host(): string;
    register(route: any): () => void;
    registerUpgrade(route: any): () => void;
    registerFallback(handler: any): () => void;
    tapIndex(transform: (html: string) => string): () => void;
    applyIndexTaps(html: string): string;
    collectIndexInjections(): any[];
    renderIndex(html: string): string;
    match(pathname: string): any;
    private servePatchedBundle;
    [Service.init](): Promise<void>;
}
export declare const name = "lan-webserver";
export declare const inject: string[];
export default WebServer;
//# sourceMappingURL=webserver.d.ts.map