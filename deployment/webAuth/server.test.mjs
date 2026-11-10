import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, scryptSync } from 'node:crypto'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

const directory = await mkdtemp(join(tmpdir(), 'manju-web-auth-'))
const password = 'only-local-regression-password-42'
const salt = randomBytes(32)
const configFile = join(directory, 'config.json')
await writeFile(configFile, JSON.stringify({ username: 'alex', salt: salt.toString('hex'), passwordHash: scryptSync(password, salt, 64, { N:32768,r:8,p:1,maxmem:96*1024*1024 }).toString('hex'), sites: { toonflow:{host:'toonflow.example.test',name:'ToonFlow'},huobao:{host:'huobao.example.test',name:'火宝漫剧'} } }))
let child
async function start() {
  child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], { env:{...process.env,AUTH_CONFIG_FILE:configFile,AUTH_DATA_DIR:directory,PORT:'13080'},stdio:['ignore','pipe','pipe'] })
  await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw new Error('Auth service exited before ready')})])
}
async function stop() { const exited=once(child,'exit');child.kill('SIGTERM');await exited }
const headers = { 'X-Manju-Site':'toonflow','X-Manju-Host':'toonflow.example.test','X-Manju-Proto':'https','X-Manju-Client-IP':'192.0.2.1' }
let checks=0
const expect=(actual,expected)=>{assert.deepEqual(actual,expected);checks++}
async function request(path, options={}) { return fetch('http://127.0.0.1:13080'+path,{...options,redirect:'manual',headers:{...headers,...options.headers}}) }
async function login(secret=password,next='/#/home',ip='192.0.2.1',oldCookie='') {
  const page=await request('/auth/login',{headers:{'X-Manju-Client-IP':ip}})
  const text=await page.text()
  const csrf=text.match(/name="csrf" value="([^"]+)"/)[1]
  const csrfCookie=page.headers.getSetCookie()[0].split(';')[0]
  return request('/auth/login',{method:'POST',headers:{Origin:'https://toonflow.example.test','Content-Type':'application/x-www-form-urlencoded',Cookie:csrfCookie+(oldCookie?'; '+oldCookie:''),'X-Manju-Client-IP':ip},body:new URLSearchParams({username:'alex',password:secret,csrf,next})})
}
const cookieFrom=response=>response.headers.getSetCookie().find(value=>value.startsWith('__Host-manjuSession=')).split(';')[0]
try {
  await start()
  let response=await request('/internal/verify',{headers:{Accept:'application/json','X-Forwarded-Uri':'/api/private','X-Forwarded-Method':'GET'}})
  expect(response.status,401);expect((await response.json()).error_code,'loginRequired');expect(response.headers.get('www-authenticate'),null)
  response=await request('/internal/verify',{headers:{Accept:'text/html','X-Forwarded-Uri':'/project/1?a=b','X-Forwarded-Method':'GET'}})
  expect(response.status,303);expect(response.headers.get('location'),'/auth/login?next=%2Fproject%2F1%3Fa%3Db')
  response=await login('bad-password');expect(response.status,401);expect(response.headers.get('www-authenticate'),null);assert.ok((await response.text()).includes('账号或密码不正确'))
  response=await login();expect(response.status,303);expect(response.headers.get('location'),'/#/home')
  const header=response.headers.getSetCookie()[0]
  assert.ok(header.includes('Secure')&&header.includes('HttpOnly')&&header.includes('SameSite=Lax')&&!header.includes('Domain='));checks++
  let sessionCookie=cookieFrom(response)
  response=await request('/internal/verify',{headers:{Cookie:sessionCookie}});expect(response.status,204)
  response=await request('/auth/session',{headers:{Cookie:sessionCookie}});expect(await response.json(),{authenticated:true,user:'alex'})
  response=await request('/internal/verify',{headers:{Cookie:sessionCookie,'X-Manju-Site':'huobao','X-Manju-Host':'huobao.example.test'}});expect(response.status,401)
  response=await request('/internal/verify',{headers:{Cookie:'__Host-manjuSession='+randomBytes(32).toString('base64url')}});expect(response.status,401)
  await stop();await start()
  response=await request('/internal/verify',{headers:{Cookie:sessionCookie}});expect(response.status,204)
  response=await login(password,'/','192.0.2.1',sessionCookie)
  const nextCookie=cookieFrom(response)
  response=await request('/internal/verify',{headers:{Cookie:sessionCookie}});expect(response.status,401)
  sessionCookie=nextCookie
  response=await request('/auth/logout',{method:'POST',headers:{Cookie:sessionCookie,Origin:'https://evil.example'}});expect(response.status,403)
  response=await request('/internal/verify',{headers:{Cookie:sessionCookie}});expect(response.status,204)
  response=await request('/auth/logout',{method:'POST',headers:{Cookie:sessionCookie,Origin:'https://toonflow.example.test'}});expect(response.status,204)
  response=await request('/internal/verify',{headers:{Cookie:sessionCookie}});expect(response.status,401)
  response=await request('/auth/login',{method:'POST',headers:{Origin:'https://toonflow.example.test','Content-Type':'application/x-www-form-urlencoded'},body:'username=alex&password=x&csrf=bad'});expect(response.status,403)
  for (const next of ['https://evil.example','//evil.example','/%2fevil.example','/\\evil.example','/%5cevil.example','/auth/logout','/%0a/evil.example']) {
    response=await login(password,next);expect(response.status,303);expect(response.headers.get('location'),'/')
  }
  response=await login();sessionCookie=cookieFrom(response)
  await stop()
  const persisted=JSON.parse(await readFile(join(directory,'sessions.json'),'utf8'))
  for (const [,value] of persisted) value.expires=Date.now()-1000
  await writeFile(join(directory,'sessions.json'),JSON.stringify(persisted))
  await start()
  response=await request('/internal/verify',{headers:{Cookie:sessionCookie}});expect(response.status,401)
  for(let index=0;index<5;index++){response=await login('wrong','/','192.0.2.8');expect(response.status,401)}
  response=await login('wrong','/','192.0.2.8');expect(response.status,429)
  response=await request('/internal/verify',{headers:{'X-Manju-Host':'evil.example'}});expect(response.status,400)
  console.log(JSON.stringify({passed:checks,checks:'login, cookie flags, CSRF, host separation, persistence, rotation, logout, expiry, safe redirects, throttling'}))
} finally {
  if(child&&child.exitCode===null) await stop()
  await rm(directory, { recursive: true, force: true })
}
