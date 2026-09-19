/**
 * dsh-lan-access — DSH 局域网访问插件（代码部分）
 *
 * 职责（v0.1.2）：
 *   1) webserver 绑定 0.0.0.0 由 cordis.patch.yml 负责（见同目录补丁）；
 *   2) 通过 webserver 的 tapIndex 钩子，向 index.html 注入：
 *        a. crypto.randomUUID polyfill（局域网明文 HTTP 非安全上下文兼容）；
 *        b. 移动端排版 CSS（屏幕 ≤820px 自动紧凑适配 DSH Web GUI）。
 *
 * polyfill 说明：浏览器只在"安全上下文"（HTTPS 或 localhost）暴露
 * `crypto.randomUUID`。局域网明文 HTTP（如 http://192.168.x.x:3080）不是
 * 安全上下文，`crypto.randomUUID` 不存在，DSH 浏览器端 RPC 会全部抛
 * "crypto.randomUUID is not a function"。兜底实现用 crypto.getRandomValues
 * 生成标准 UUID v4（getRandomValues 在非安全上下文同样可用）。
 *
 * 移动端 CSS 说明：移植自 hchao3335-maker/dsh-lan-gate（MIT License），
 * 取其 `@media (max-width:820px)` 兜底层——窄屏自动紧凑排版，无需代理/
 * 设备标记。选择器依赖 DSH 的稳定 data-* 属性（data-slot / data-chat-flow
 * / data-composer-card / role="dialog"）。
 */
const name = "dsh-lan-access";

/** 需要 webserver 服务先就绪，才能注册 index tap。 */
const inject = ["webServer"];

/** UUID v4 兜底实现（crypto.getRandomValues 版，标准格式，非加密用途）。 */
function uuidV4Fallback() {
	const b = crypto.getRandomValues(new Uint8Array(16));
	b[6] = (b[6] & 0x0f) | 0x40; // version 4
	b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
	const h = Array.prototype.map.call(b, (x) => x.toString(16).padStart(2, "0")).join("");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 注入到 <head> 末尾的内联脚本；带幂等守卫，重复注入不叠加。 */
const POLYFILL_SCRIPT = `<script>
if (typeof crypto !== "undefined" && typeof crypto.randomUUID !== "function") {
	crypto.randomUUID = ${uuidV4Fallback.toString()};
}
</script>`;

/**
 * 移动端排版 CSS（屏幕 ≤820px 自动紧凑适配）。
 * 移植自 hchao3335-maker/dsh-lan-gate（MIT License）的 DEVICE_CSS 兜底层：
 * 去掉了其代理注入 data-lan-device 属性的机制，窄屏即生效；
 * `html:not([data-lan-device="desktop"])` 在未设置该属性时恒匹配，
 * 保留该选择器以便将来可选地支持"桌面强制模式"。
 */
const DEVICE_CSS = `<style>
@media (max-width:820px){
html:not([data-lan-device="desktop"]){-webkit-text-size-adjust:100%;text-size-adjust:100%}
html:not([data-lan-device="desktop"]) [data-slot="conversation"] [data-phase]{--dsh-composer-side-clearance:2px;--dsw-font-s-14-font-size:12px;--dsw-font-xs-13-font-size:11px;--dsw-font-xxs-12-font-size:10.5px;--dsw-font-xxxs-11-font-size:9.5px}
html:not([data-lan-device="desktop"]) [data-slot="conversation"] [data-phase]{--dsw-font-markdown-base-font-size:13.5px;--dsw-font-markdown-base-strong-font-size:13.5px;--dsw-font-markdown-base-italic-font-size:13.5px;--dsw-font-markdown-base-strong-italic-font-size:13.5px;--dsw-font-markdown-small-font-size:12px;--dsw-font-markdown-small-strong-font-size:12px;--dsw-font-markdown-small-italic-font-size:12px;--dsw-font-markdown-small-strong-italic-font-size:12px;--dsw-font-markdown-code-font-size:11.5px;--dsw-font-markdown-code-block-font-size:11px;--dsw-font-markdown-code-block-small-font-size:10px;--dsw-font-markdown-table-font-size:12px;--dsw-font-markdown-table-head-font-size:12px;--dsw-font-markdown-h1-font-size:17px;--dsw-font-markdown-h2-font-size:15px;--dsw-font-markdown-h3-font-size:14px;--dsw-font-markdown-h4-font-size:13px}
html:not([data-lan-device="desktop"]) [data-chat-flow]{line-height:1.4;gap:6px}
html:not([data-lan-device="desktop"]) [data-chat-flow] pre{font-size:11px;max-width:100%}
html:not([data-lan-device="desktop"]) [data-slot="conversation"] input,html:not([data-lan-device="desktop"]) [data-slot="conversation"] textarea{font-size:16px}
html:not([data-lan-device="desktop"]) [data-slot="conversation"] button,html:not([data-lan-device="desktop"]) [data-slot="sidebar"] button{min-height:32px;touch-action:manipulation}
html:not([data-lan-device="desktop"]) [data-slot="conversation"],html:not([data-lan-device="desktop"]) [data-slot="sidebar"]{-webkit-tap-highlight-color:transparent}
html:not([data-lan-device="desktop"]) [data-composer-card] button{min-height:28px}
html:not([data-lan-device="desktop"]) [data-composer-card] select{max-width:120px;font-size:12px;height:24px;padding:0 14px 0 6px}
html:not([data-lan-device="desktop"]) [data-composer-card] > div:last-child > div:first-child{gap:8px}
html:not([data-lan-device="desktop"]) [data-composer-card] > div:last-child > div:last-child{flex:0 1 auto;min-width:0;gap:8px}
html:not([data-lan-device="desktop"]) [role="dialog"][aria-modal="true"]{display:flex;flex-direction:column;width:100vw;height:100dvh;max-width:100vw;max-height:100dvh;border-radius:0}
html:not([data-lan-device="desktop"]) [role="presentation"]:has([role="dialog"]){padding:0}
html:not([data-lan-device="desktop"]) [role="dialog"][aria-modal="true"] nav{width:100%;flex:none;flex-direction:column;gap:6px;padding:10px 12px 6px}
html:not([data-lan-device="desktop"]) [role="dialog"][aria-modal="true"] nav>div:last-child{display:flex;flex-direction:row;flex-wrap:nowrap;overflow-x:auto;gap:4px}
html:not([data-lan-device="desktop"]) [role="dialog"][aria-modal="true"] > div:last-child{flex:1;min-height:0}
html:not([data-lan-device="desktop"]) [role="dialog"][aria-modal="true"] > div:last-child > div:last-child{flex:1;min-height:0;overflow-y:auto}
html:not([data-lan-device="desktop"]) [data-slot="conversation.input.model"] [role="menu"]{position:fixed;right:max(8px,env(safe-area-inset-right));left:auto;top:96px;bottom:auto;width:min(240px,calc(100vw - 72px));max-height:min(360px,calc(100dvh - 150px));z-index:120}
html:not([data-lan-device="desktop"]) [data-composer-card] [role="dialog"]{position:fixed;right:max(8px,env(safe-area-inset-right));left:auto;top:96px;bottom:90px;width:min(320px,calc(100vw - 72px));max-height:min(420px,calc(100dvh - 200px));z-index:120}
}
</style>`;

/** 注入到 <head> 末尾；带幂等守卫（polyfill 含 randomUUID 关键词）。 */
function injectHead(html) {
	if (html.includes("randomUUID")) return html;
	return html.replace("</head>", POLYFILL_SCRIPT + DEVICE_CSS + "</head>");
}

/**
 * @param ctx - plugin context；因 inject: [webServer]，ctx.webServer 可用。
 * @param config - 本行配置（当前无配置项）。
 */
function apply(ctx) {
	ctx.webServer.tapIndex(injectHead);
}

export { apply, inject, name };
