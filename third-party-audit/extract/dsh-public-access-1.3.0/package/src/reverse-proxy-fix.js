import { validateSession, createSession, validateLogin, getLoginPage } from './auth.js'

export const name = 'reverse-proxy-fix'
export const inject = ['webServer', 'connection']

// Cookie attributes shared by every dsh_session cookie we issue or clear.
const SESSION_COOKIE = 'dsh_session'
const SESSION_MAX_AGE = 24 * 60 * 60 // 24 hours, in seconds

function handleLoginRoute(req, res) {
  if (req.method === 'POST') {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString()
      const params = new URLSearchParams(body)
      const username = params.get('username') || ''
      const password = params.get('password') || ''

      if (validateLogin(username, password)) {
        const sessionId = createSession()
        res.writeHead(302, {
          'Set-Cookie': `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`,
          'Location': '/'
        })
        res.end()
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(getLoginPage('用户名或密码错误'))
      }
    })
    return
  }

  // GET (and anything else) shows the login page.
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(getLoginPage())
}

function handleLogoutRoute(_req, res) {
  res.writeHead(302, {
    'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    'Location': '/_auth/login'
  })
  res.end()
}

export function apply(ctx) {
  console.log('[reverse-proxy-fix] Adapting to dsh browser-token auth...')

  const webServer = ctx.webServer

  // ── Public login / logout routes (no session required) ───────────────────
  // Registered as ordinary webserver routes so they sit ahead of the SPA
  // fallback and never pass through the connection auth gate.
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/_auth/login',
    handler: (req, res) => handleLoginRoute(req, res)
  }), 'reverse-proxy-fix: /_auth/login route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/_auth/logout',
    handler: (_req, res) => handleLogoutRoute(_req, res)
  }), 'reverse-proxy-fix: /_auth/logout route')

  // ── Drive the connection auth gate with the plugin session ───────────────
  // dsh 0.1.x gates index requests through ctx.connection.authorizeIndex and
  // every /api request through ctx.connection.requestRejection (the Host /
  // Origin browser-trust fence followed by the signed browser cookie). Binding
  // to 0.0.0.0 for public access needs those decisions to honor the plugin's
  // dsh_session cookie too — otherwise an authenticated user is bounced by the
  // token gate they never went through.
  //
  // We layer the plugin session ON TOP of the original gate: a valid plugin
  // session lets the request through, and otherwise the original dsh token /
  // cookie auth runs unchanged (so the printed ?token=... URL still works).
  const conn = ctx.get('connection')
  if (!conn || typeof conn.requestRejection !== 'function' || typeof conn.authorizeIndex !== 'function') {
    throw new Error('reverse-proxy-fix: ctx.connection auth gate not found; dsh version mismatch')
  }

  const origRequestRejection = conn.requestRejection.bind(conn)
  const origAuthorizeIndex = conn.authorizeIndex.bind(conn)

  conn.requestRejection = (req) => {
    // A valid plugin session satisfies both the trust fence and the auth.
    if (validateSession(req.headers.cookie)) return undefined
    // Otherwise fall back to the native token / cookie gate (403 or 401).
    return origRequestRejection(req)
  }

  conn.authorizeIndex = (req, res) => {
    // A valid plugin session may serve the index directly.
    if (validateSession(req.headers.cookie)) return true
    // Let the native flow handle the launch-token exchange (?token=...) and a
    // pre-existing signed dsh-auth cookie. For anything else, send the browser
    // to the plugin login page instead of dsh's bare 401.
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    if (url.searchParams.has('token')) return origAuthorizeIndex(req, res)
    if (origRequestRejection(req) === undefined) return true
    res.writeHead(302, { 'Location': '/_auth/login' })
    res.end()
    return false
  }

  // ── Browser-side polyfills, injected into the index ───────────────────────
  ctx.on('webserver/index-inject', (table) => {
    // dsh computes connection.isLoopback from globalThis.__DSH_TRANSPORT__
    // (ownsHost) or the page hostname. ownsHost is an unused hook that dsh
    // never populates, so a public-IP deployment reads as non-loopback and
    // loses host-side settings persistence plus file-open. Set ownsHost so
    // authenticated public access behaves like loopback.
    table.push({
      kind: 'script',
      placement: 'head',
      text: `globalThis.__DSH_TRANSPORT__=Object.assign({},globalThis.__DSH_TRANSPORT__,{ownsHost:true});`
    })

    // Web Crypto is absent or partial on plain-HTTP origins; shim the two
    // calls the client bundle relies on.
    table.push({
      kind: 'script',
      placement: 'head',
      text: `if(typeof crypto==='undefined'||typeof crypto.randomUUID!=='function'){var s={randomUUID:function(){return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){var r=Math.random()*16|0;var v=c==='x'?r:(r&0x3|0x8);return v.toString(16);});},getRandomValues:function(a){for(var i=0;i<a.length;i++)a[i]=Math.floor(Math.random()*256);return a;}};if(typeof crypto==='undefined')window.crypto=s;else{if(typeof crypto.randomUUID!=='function')crypto.randomUUID=s.randomUUID;if(typeof crypto.getRandomValues!=='function')crypto.getRandomValues=s.getRandomValues;}}`
    })
  })

  console.log('[reverse-proxy-fix] Plugin session auth + polyfills installed')
}
