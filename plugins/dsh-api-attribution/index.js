/**
 * dsh-api-attribution — local plugin (our own code, no third-party package).
 *
 * Why: nothing in the harness attributes a message to the device it came from.
 * The model only ever receives `role` + content; `MessageSource.kind` records a
 * producer CLASS (`user` / `model` / `tool` / `plugin`), never a device, and
 * `clientId` exists only inside `dsh-api-gateway`'s transport state — it is
 * absent from `dsh-session`, the API controllers, and the persistence layer.
 * The webserver logs no requests at all.
 *
 * What this does: attaches one extra listener to the webserver's HTTP server —
 * a public property (`ctx.webServer.server`), so no first-party code is patched
 * — and appends one line per qualifying request to `$DSH_HOME/api-calls.log`:
 *
 *   <iso timestamp>  <kind>  <METHOD> <path>  host=<authority>  ua=<user agent>
 *
 * The `host` field is the authority the device actually connected to, which is
 * what separates a loopback client (`127.0.0.1:3080`) from a LAN one
 * (`<home-lan-ip>:3080`); `ua` separates phone from desktop.
 *
 * Which requests are logged: `/api*` (every message, tool call, and stream
 * RPC crosses this) plus `GET /` (a device opening the GUI). Assets, plugin
 * bundles, and the manifest are deliberately NOT logged — a single page load
 * would otherwise write dozens of rows and bury the signal.
 *
 * Caveats worth knowing:
 *   - This is monitoring. Every device that reaches the GUI is recorded here,
 *     including its User-Agent.
 *   - The log is a plain append-only text file with no rotation. Delete it if
 *     it grows; removing the row from cordis.patch.yml stops the logging.
 *   - The model does NOT receive these lines. They land in a file: attribution
 *     is something you (or the agent, on request) read afterwards.
 *   - WebSocket upgrades are logged too (`kind=upgrade`), since the /api stream
 *     transport opens that way.
 */

import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Stable Cordis plugin name. */
const name = 'api-attribution'

/** The server object only exists once the webserver is active. */
const inject = ['webServer']

/** Max User-Agent characters kept per line; the full value is rarely longer. */
const UA_LIMIT = 300

/**
 * Whether a request is worth a row: the RPC bridge and the GUI entry point.
 * @param pathname - the request pathname.
 * @returns true when the request should be recorded.
 */
function isInteresting(pathname) {
  return pathname === '/' || pathname === '/api' || pathname.startsWith('/api/')
}

/** One log line: ISO time, kind, method/path, connecting authority, device. */
function formatLine(kind, method, pathname, headers) {
  const host = typeof headers.host === 'string' ? headers.host : '-'
  const raw = typeof headers['user-agent'] === 'string' ? headers['user-agent'] : '-'
  const ua = raw.length > UA_LIMIT ? `${raw.slice(0, UA_LIMIT)}…` : raw
  return `${new Date().toISOString()}  ${kind.padEnd(7)}  ${method} ${pathname}  host=${host}  ua=${ua}\n`
}

/**
 * Attach the attribution listener to the live HTTP server.
 * @param ctx - plugin context carrying `webServer`.
 */
function apply(ctx) {
  const server = ctx.webServer.server
  if (server === undefined) {
    ctx.logger?.warn?.('api-attribution: webServer has no HTTP server yet; not attached')
    return
  }
  const file = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'api-calls.log')

  const record = (kind, req) => {
    try {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      if (!isInteresting(pathname)) return
      appendFileSync(file, formatLine(kind, req.method ?? '-', pathname, req.headers), 'utf8')
    } catch (error) {
      // Never let attribution break a request.
      ctx.logger?.warn?.(`api-attribution: could not log a request: ${String(error)}`)
    }
  }

  const onRequest = (req) => { record('http', req) }
  const onUpgrade = (req) => { record('upgrade', req) }

  // prependListener: record before any handler runs, so a throwing route still
  // leaves a trace. The disposer keeps re-activation from double-logging.
  server.prependListener('request', onRequest)
  server.on('upgrade', onUpgrade)
  ctx.effect(() => () => {
    server.off('request', onRequest)
    server.off('upgrade', onUpgrade)
  }, 'api-attribution: request listener')

  ctx.logger?.info?.(`api-attribution: logging /api and / from ${file}`)
}

export { apply, formatLine, inject, isInteresting, name }
