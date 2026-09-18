/**
 * dsh-lan-owns-host — local plugin (no third-party code) that exists to patch
 * exactly one first-party field.
 *
 * Why: the browser half of @deepseek-ai/dsh-client-connection computes
 *
 *   isLoopback: transport?.ownsHost === true || pageLocation === void 0
 *               || isLoopbackHostname(pageLocation.hostname)
 *
 * and the shipped composition never sets `__DSH_TRANSPORT__.ownsHost`. A page
 * opened over a LAN address therefore reads as non-loopback, and two settings
 * clients degrade because of it (verified in the installed packages):
 *
 *   dsh-client-ui-settings/lib/client.js
 *     const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";
 *   dsh-client-ui-settings-general/lib/client.js
 *     const documentController = ctx.remote.$host.isLoopback
 *       ? new SettingsDocumentStore(...) : void 0;
 *
 * i.e. settings changed from a LAN device are kept in memory instead of being
 * written to the host's settings.yaml, and the raw settings document editor is
 * not mounted.
 *
 * What this does: pushes one `webserver/index-inject` row rendered as the first
 * <script> inside <head>, before the shell entry bundle reads the transport.
 * `Object.assign` keeps any field the shell may have put there already.
 *
 * Scope: it grants nothing new by itself. Reaching the page at all already
 * requires the process launch token (or its signed cookie) plus a Host that
 * passes the /api browser-trust fence, so this only affects how the page the
 * user already reached is classified.
 */

/** Stable Cordis plugin name. */
const name = 'lan-owns-host'

/** Wait for the webserver so the row is contributed into a live index render. */
const inject = ['webServer']

/** Presence-aware assignment: never clobber a transport the shell installed. */
const OWNS_HOST_SCRIPT = 'globalThis.__DSH_TRANSPORT__=Object.assign({},globalThis.__DSH_TRANSPORT__,{ownsHost:true});'

/**
 * Contribute the bootstrap row into the webserver's injection table.
 * @param ctx - plugin context; `inject: ['webServer']` guarantees the service.
 */
function apply(ctx) {
  ctx.on('webserver/index-inject', (table) => {
    table.push({
      kind: 'script',
      placement: 'head',
      text: OWNS_HOST_SCRIPT,
    })
  })
}

export { apply, inject, name, OWNS_HOST_SCRIPT }
