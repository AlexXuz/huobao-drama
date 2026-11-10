import { createServer } from 'node:http'
import { randomBytes, createHash, timingSafeEqual, scrypt } from 'node:crypto'
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const deriveKey = promisify(scrypt)
const config = JSON.parse(await readFile(process.env.AUTH_CONFIG_FILE, 'utf8'))
const directory = resolve(process.env.AUTH_DATA_DIR)
await mkdir(directory, { recursive: true, mode: 0o700 })
const sessionFile = resolve(directory, 'sessions.json')
const cookieName = '__Host-manjuSession'
const csrfName = '__Host-manjuCsrf'
const lifetimeSeconds = 7 * 24 * 60 * 60
const tokenPattern = /^[A-Za-z0-9_-]{43}$/
if (typeof config.username !== 'string' || !/^[a-f0-9]{64}$/.test(config.salt) || !/^[a-f0-9]{128}$/.test(config.passwordHash)) throw new Error('Invalid authentication configuration')
const sites = new Map(Object.entries(config.sites || {}))
for (const [, site] of sites) {
  if (!/^[a-z0-9.-]+$/.test(site.host) || typeof site.name !== 'string') throw new Error('Invalid authentication site')
}
if (!sites.size) throw new Error('No authentication sites configured')

let sessions
try {
  const data = JSON.parse(await readFile(sessionFile, 'utf8'))
  if (!Array.isArray(data)) throw new Error('Invalid session store')
  sessions = new Map(data)
} catch (error) {
  if (error.code !== 'ENOENT') throw error
  sessions = new Map()
}
let mutationQueue = Promise.resolve()
function changeSessions(change) {
  const operation = mutationQueue.catch(() => {}).then(async () => {
    const updated = new Map(sessions)
    const now = Date.now()
    for (const [key, value] of updated) if (!value || value.expires <= now) updated.delete(key)
    change(updated)
    while (updated.size > 1000) updated.delete(updated.keys().next().value)
    const temporary = sessionFile + '.new'
    await writeFile(temporary, JSON.stringify([...updated]), { mode: 0o600 })
    await rename(temporary, sessionFile)
    sessions = updated
  })
  mutationQueue = operation
  return operation
}

const digest = value => createHash('sha256').update(value).digest('hex')
const equal = (a, b) => {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
const html = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
function cookie(req, name) {
  const values = (req.headers.cookie || '').split(';').map(item => item.trim()).filter(item => item.startsWith(name + '=')).map(item => item.slice(name.length + 1))
  return values.length === 1 && tokenPattern.test(values[0]) ? values[0] : ''
}
function cookieHeader(name, value, age) {
  return `${name}=${value}; Path=/; Max-Age=${age}; Secure; HttpOnly; SameSite=Lax`
}
function session(req, siteId) {
  const token = cookie(req, cookieName)
  const value = token && sessions.get(digest(token))
  return value && value.site === siteId && value.user === config.username && value.expires > Date.now() ? value : null
}
function safeNext(value, origin) {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/') || value.startsWith('//')) return '/'
  try {
    const decoded = decodeURIComponent(value)
    if (/[\\\u0000-\u001f\u007f]/.test(value + decoded) || decoded.startsWith('//')) return '/'
    const url = new URL(value, origin)
    if (url.origin !== origin || /^\/auth(?:\/|$)/i.test(url.pathname)) return '/'
    return url.pathname + url.search + url.hash
  } catch { return '/' }
}
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
function redirect(res, location) {
  res.writeHead(303, { Location: location })
  res.end()
}
function loginPage(res, site, next, status = 200, message = '', username = '') {
  const csrf = randomBytes(32).toString('base64url')
  const nonce = randomBytes(18).toString('base64')
  res.setHeader('Set-Cookie', cookieHeader(csrfName, csrf, 3600))
  res.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`)
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · ${html(site.name)}</title>
<style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;padding:28px;background:#f4f6fa;color:#182033;font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}main{width:100%;max-width:420px;padding:38px;background:white;border:1px solid #e4e8ef;border-radius:20px;box-shadow:0 18px 60px #16233a0c}.brand{font-size:14px;font-weight:700;letter-spacing:.04em;color:${site.host.startsWith('huobao.') ? '#c65b12' : '#395bd5'}}h1{font-size:29px;line-height:1.25;margin:18px 0 10px}p{color:#687286;font-size:14px;line-height:1.7;margin:0 0 26px}label{display:block;margin:18px 0 8px;font-size:14px;font-weight:600}input{width:100%;height:48px;padding:0 14px;border:1px solid #cdd4df;border-radius:9px;font-size:16px;color:#182033;background:#fff}input:focus{outline:3px solid #dce5ff;border-color:#5477de}.password{position:relative}.password input{padding-right:64px}.reveal{position:absolute;right:8px;top:8px;height:32px;border:0;border-radius:6px;background:#f0f3f8;color:#48566c;padding:0 10px;cursor:pointer}.submit{width:100%;height:48px;margin-top:26px;border:0;border-radius:9px;background:#3158c9;color:white;font-size:16px;font-weight:600;cursor:pointer}.submit:disabled{opacity:.65;cursor:wait}.note{font-size:12px;color:#8590a2;margin:18px 0 0;text-align:center}.error{background:#fff0ef;border:1px solid #f4c6c1;color:#a52c24;padding:11px 13px;border-radius:8px;font-size:14px;line-height:1.6;margin:20px 0 0}@media(max-width:480px){body{padding:18px}main{padding:28px 24px}}
</style></head><body><main><div class="brand">${html(site.name)}</div><h1>欢迎回来</h1><p>登录后继续创作，访问你的项目和素材。</p>${message ? `<div class="error" role="alert">${html(message)}</div>` : ''}<form method="post" action="/auth/login"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="next" value="${html(next)}"><label for="username">账号</label><input id="username" name="username" autocomplete="username" maxlength="64" required value="${html(username)}" autofocus><label for="password">密码</label><div class="password"><input id="password" name="password" type="password" autocomplete="current-password" maxlength="256" required><button type="button" class="reveal" aria-label="显示密码" aria-pressed="false">显示</button></div><button class="submit" type="submit">登录</button><p class="note">登录状态保留 7 天，可随时退出登录。</p></form></main>
<script nonce="${nonce}">const form=document.querySelector('form');const next=form.elements.next;if(location.hash&&!next.value.includes('#'))next.value+=location.hash;const button=document.querySelector('.reveal');button.addEventListener('click',()=>{const input=form.elements.password;const show=input.type==='password';input.type=show?'text':'password';button.textContent=show?'隐藏':'显示';button.setAttribute('aria-label',show?'隐藏密码':'显示密码');button.setAttribute('aria-pressed',String(show));});form.addEventListener('submit',()=>{const button=document.querySelector('.submit');button.disabled=true;button.textContent='正在登录…';});</script></body></html>`)
}

const attempts = new Map()
let globalAttempts = []
let hashing = 0
function limited(ip) {
  const threshold = Date.now() - 5 * 60 * 1000
  const current = (attempts.get(ip) || []).filter(time => time > threshold)
  globalAttempts = globalAttempts.filter(time => time > threshold)
  if (current.length >= 5 || globalAttempts.length >= 50 || hashing >= 2) return true
  const now = Date.now()
  attempts.set(ip, [...current, now])
  globalAttempts.push(now)
  if (attempts.size > 2000) for (const [key, values] of attempts) if (values.at(-1) <= threshold) attempts.delete(key)
  return false
}
async function readForm(req) {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/x-www-form-urlencoded')) throw Object.assign(new Error('Expected form submission'), { status: 415 })
  const chunks = []
  let length = 0
  for await (const chunk of req) {
    length += chunk.length
    if (length > 8192) throw Object.assign(new Error('Form is too large'), { status: 413 })
    chunks.push(chunk)
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}
async function handle(req, res) {
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'same-origin')
  res.setHeader('X-Frame-Options', 'DENY')
  const siteId = req.headers['x-manju-site']
  const site = sites.get(siteId)
  if (!site || req.headers['x-manju-host'] !== site.host || req.headers['x-manju-proto'] !== 'https') return json(res, 400, { message: 'Unknown authentication site' })
  const origin = 'https://' + site.host
  const url = new URL(req.url, origin)
  const current = session(req, siteId)

  if (url.pathname === '/internal/verify' && req.method === 'GET') {
    if (current) { res.writeHead(204); return res.end() }
    const original = req.headers['x-forwarded-uri'] || '/'
    const method = req.headers['x-forwarded-method'] || 'GET'
    const target = safeNext(original, origin)
    if ((method === 'GET' || method === 'HEAD') && req.headers.accept?.includes('text/html') && !/^\/(?:api|static)(?:\/|$)/i.test(target)) return redirect(res, '/auth/login?next=' + encodeURIComponent(target))
    return json(res, 401, { code: 401, error_code: 'loginRequired', message: '请先登录' })
  }
  if (url.pathname === '/auth/session' && req.method === 'GET') return json(res, current ? 200 : 401, current ? { authenticated: true, user: current.user } : { authenticated: false, code: 401, error_code: 'loginRequired' })
  if (url.pathname === '/auth/login' && req.method === 'GET') {
    const next = safeNext(url.searchParams.get('next'), origin)
    if (current) return redirect(res, next)
    return loginPage(res, site, next)
  }
  if (req.method === 'POST' && ['/auth/login', '/auth/logout'].includes(url.pathname)) {
    if (req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { message: '请从本站页面提交' })
    if (url.pathname === '/auth/logout') {
      const token = cookie(req, cookieName)
      if (token) await changeSessions(updated => updated.delete(digest(token)))
      res.setHeader('Set-Cookie', [cookieHeader(cookieName, '', 0), cookieHeader(csrfName, '', 0)])
      res.writeHead(204)
      return res.end()
    }
    const form = await readForm(req)
    const next = safeNext(form.get('next'), origin)
    const csrf = cookie(req, csrfName)
    const suppliedCsrf = form.get('csrf') || ''
    if (!csrf || !tokenPattern.test(suppliedCsrf) || !equal(csrf, suppliedCsrf)) return loginPage(res, site, next, 403, '登录页面已过期，请重新输入账号密码。')
    const username = form.get('username') || ''
    const password = form.get('password') || ''
    if (username.length > 64 || password.length > 256 || !username || !password) return loginPage(res, site, next, 400, '请输入有效的账号和密码。')
    const ip = req.headers['x-manju-client-ip'] || 'unknown'
    if (limited(ip)) {
      res.setHeader('Retry-After', '300')
      return loginPage(res, site, next, 429, '尝试次数过多，请 5 分钟后再试。', username)
    }
    hashing++
    let key
    try { key = await deriveKey(password, Buffer.from(config.salt, 'hex'), 64, { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 }) }
    finally { hashing-- }
    const valid = timingSafeEqual(key, Buffer.from(config.passwordHash, 'hex')) && equal(username, config.username)
    key.fill(0)
    if (!valid) return loginPage(res, site, next, 401, '账号或密码不正确，请重新输入。', username)
    const token = randomBytes(32).toString('base64url')
    const old = cookie(req, cookieName)
    await changeSessions(updated => {
      if (old) updated.delete(digest(old))
      updated.set(digest(token), { user: config.username, site: siteId, created: Date.now(), expires: Date.now() + lifetimeSeconds * 1000 })
    })
    attempts.delete(ip)
    res.setHeader('Set-Cookie', [cookieHeader(cookieName, token, lifetimeSeconds), cookieHeader(csrfName, '', 0)])
    return redirect(res, next)
  }
  return json(res, 404, { message: 'Not found' })
}

const server = createServer((req, res) => {
  handle(req, res).catch(error => {
    // Never log request bodies, credentials, cookies or raw upstream errors.
    console.error('Authentication request failed:', error.status || 500)
    if (!res.headersSent) json(res, error.status || 503, { message: '登录服务暂时不可用，请稍后重试。' })
    else res.end()
  })
})
server.requestTimeout = 15000
server.headersTimeout = 10000
server.keepAliveTimeout = 5000
server.listen(Number(process.env.PORT || 3080), '127.0.0.1', () => console.log('Web authentication service ready on loopback'))
process.once('SIGTERM', () => server.close(() => mutationQueue.finally(() => process.exit(0))))
