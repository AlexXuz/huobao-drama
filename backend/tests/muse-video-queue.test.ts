import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { eq } from 'drizzle-orm'

// Real local HTTP and an isolated SQLite/storage directory. No production imports or credentials.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-muse-queue-'))
process.env.SQLITE_PATH = path.join(root, 'tasks.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.FFMPEG_BIN = path.join(root, 'no-ffmpeg')
process.env.FFPROBE_BIN = path.join(root, 'no-ffprobe')
const { db, schema } = await import('../src/db/index.js')
const { generateVideo, recoverVideoTask, resumeInterruptedTasks } = await import('../src/services/generation.js')
const tasksRoute = (await import('../src/routes/tasks.js')).default

const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(32)])
const submissions: string[] = []
const events: string[] = []
const polls = new Map<string, number>()
const pollModes = new Map<string, 'failed' | 'http-error' | 'missing'>()
let nextResponse: 'normal' | 'reject' | 'broken' | 'header-broken' = 'normal'
let holdNextDownload = false
let heldDownload: http.ServerResponse | undefined
let submissionNumber = 0
const server = http.createServer(async (req, res) => {
  if (req.method === 'POST') {
    for await (const _chunk of req) { /* consume the real request without recording its contents */ }
    const id = `local-${++submissionNumber}`
    submissions.push(id)
    events.push(`submit:${id}`)
    const mode = nextResponse
    nextResponse = 'normal'
    if (mode === 'reject') { res.writeHead(422).end('{"error":"invalid local request"}'); return }
    if (mode === 'broken' || mode === 'header-broken') {
      if (mode === 'header-broken') res.setHeader('X-Huobao-Task-Id', id)
      res.end('{broken response')
      return
    }
    res.setHeader('Content-Type', 'application/json')
    const result = req.url?.includes('/video_generation')
      ? { task: { id, status: 'succeeded', duration: 5, content: { url: `${base}/media/${id}` } } }
      : { id, status: 'succeeded', duration: 5, result: { url: `/media/${id}` } }
    res.end(JSON.stringify(result))
    return
  }
  if (req.url?.startsWith('/v1/videos/')) {
    const id = req.url.split('/').at(-1)!
    polls.set(id, (polls.get(id) || 0) + 1)
    events.push(`poll:${id}`)
    const mode = pollModes.get(id) || 'failed'
    if (mode === 'http-error') {
      // Mix HTTP errors and valid JSON with an invalid shape: neither proves termination.
      if ((polls.get(id) || 0) % 2 === 0) res.setHeader('Content-Type', 'application/json').end('null')
      else res.writeHead(503).end('{"error":"temporarily unavailable"}')
      return
    }
    if (mode === 'missing') { res.writeHead(404).end('{"error":"task not found"}'); return }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ id, status: 'failed', error: 'local upstream terminal failure' }))
    return
  }
  if (req.url?.startsWith('/media/')) {
    events.push(`download:${req.url.split('/').at(-1)}`)
    if (holdNextDownload) { holdNextDownload = false; heldDownload = res; return }
    res.end(mp4)
    return
  }
  res.writeHead(404).end()
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
const ts = new Date().toISOString()
const muse = db.insert(schema.aiServiceConfigs).values({ serviceType: 'video', provider: 'openai', name: 'local Muse', baseUrl: base, apiKey: 'local-only', model: '["muse-video"]', createdAt: ts, updatedAt: ts }).returning().get()
const other = db.insert(schema.aiServiceConfigs).values({ serviceType: 'video', provider: 'minimax', name: 'local other', baseUrl: base, apiKey: 'local-only', model: '["MiniMax-H3"]', createdAt: ts, updatedAt: ts }).returning().get()
const row = (id: number) => db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()!
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate: () => boolean, description: string, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(20)
  }
  assert.fail(description)
}
async function settled(id: number, status = 'completed', timeout = 5000) {
  await until(() => row(id).status === status, `task ${id} did not reach ${status}`, timeout)
  await delay(30) // allow the dispatcher's finally block to release its in-process slot
}
function persisted(values: Partial<typeof schema.sysTask.$inferInsert> = {}) {
  return db.insert(schema.sysTask).values({ type: 'video', provider: 'openai', model: 'muse-video',
    configId: muse.id, configBaseUrl: base, prompt: 'local test', params: '{}',
    status: 'processing', stage: 'queued', createdAt: ts, updatedAt: ts, ...values }).returning().get()
}

test('concurrent Muse creations stay FIFO until delivery finishes; queue cannot be bypassed by recover', async () => {
  const before = submissions.length
  holdNextDownload = true
  const ids = await Promise.all([0, 1, 2].map(() => generateVideo({ prompt: 'local test', configId: muse.id })))
  await until(() => !!heldDownload, 'first download was not reached')
  assert.equal(submissions.length, before + 1)
  for (const id of ids.slice(1)) {
    assert.equal(row(id).stage, 'queued')
    assert.equal(row(id).taskId, null)
    assert.equal(row(id).status, 'processing')
  }
  await Promise.all(ids.map(recoverVideoTask))
  await delay(100)
  assert.equal(submissions.length, before + 1)
  heldDownload!.end(mp4)
  heldDownload = undefined
  await settled(ids.at(-1)!)
  assert.deepEqual(ids.map(id => row(id).taskId), submissions.slice(before))
  for (const id of ids) assert.equal(row(id).status, 'completed')
})

test('definitive submission rejection releases the slot, and preparation failures never POST', async () => {
  const before = submissions.length
  nextResponse = 'reject'
  const rejected = await generateVideo({ prompt: 'local test', configId: muse.id })
  const preparedBadly = await generateVideo({ prompt: '', configId: muse.id })
  const next = await generateVideo({ prompt: 'local test', configId: muse.id })
  await settled(next)
  assert.equal(row(rejected).errorCode, 'submission_rejected')
  assert.equal(row(preparedBadly).errorCode, 'preparation_failed')
  assert.equal(submissions.length, before + 2)
})

test('startup reconciles all accepted tasks before sending persisted queued work', async () => {
  const before = submissions.length
  const acceptedA = persisted({ taskId: 'accepted-before-restart-a', stage: 'polling' })
  const queued = persisted()
  const acceptedB = persisted({ taskId: 'accepted-before-restart-b', status: 'failed', stage: 'awaiting_confirmation', errorCode: 'upstream_status_unknown' })
  await resumeInterruptedTasks()
  await delay(150)
  assert.equal(submissions.length, before, 'no new submission while either accepted task is unresolved')
  assert.equal(row(queued.id).stage, 'queued')
  await settled(queued.id, 'completed', 15000)
  assert.equal(row(acceptedA.id).errorCode, 'generation_failed')
  assert.equal(row(acceptedB.id).errorCode, 'generation_failed')
  const newSubmitEvent = events.indexOf(`submit:${row(queued.id).taskId}`)
  assert.ok(events.indexOf('poll:accepted-before-restart-a') < newSubmitEvent)
  assert.ok(events.indexOf('poll:accepted-before-restart-b') < newSubmitEvent)
  assert.equal(submissions.length, before + 1, 'the accepted tasks were never re-submitted')
})

test('polling failures and 404 both pause the queue until the original task reaches a known terminal state', async () => {
  const before = submissions.length
  pollModes.set('accepted-network-failure', 'http-error')
  const accepted = persisted({ taskId: 'accepted-network-failure', stage: 'polling' })
  const queued = persisted()
  await resumeInterruptedTasks()
  await until(() => row(accepted.id).stage === 'awaiting_confirmation', 'poll failures did not pause the queue', 60000)
  assert.equal(polls.get('accepted-network-failure'), 5)
  assert.equal(row(accepted.id).errorCode, 'upstream_status_unknown')
  assert.equal(row(queued.id).stage, 'queued')
  assert.equal(submissions.length, before)
  assert.equal((await tasksRoute.request(`/${accepted.id}`, { method: 'DELETE' })).status, 400)
  pollModes.set('accepted-network-failure', 'missing')
  await Promise.all([recoverVideoTask(accepted.id), recoverVideoTask(accepted.id)])
  await until(() => polls.get('accepted-network-failure') === 6 && row(accepted.id).stage === 'awaiting_confirmation', '404 did not preserve the queue occupant', 15000)
  assert.equal(row(accepted.id).errorCode, 'upstream_status_unknown')
  assert.equal(submissions.length, before)
  assert.equal(row(queued.id).stage, 'queued')
  assert.equal(polls.get('accepted-network-failure'), 6, 'concurrent recovery issued just one query')
  pollModes.set('accepted-network-failure', 'failed')
  await recoverVideoTask(accepted.id)
  await settled(queued.id, 'completed', 15000)
  assert.equal(row(accepted.id).errorCode, 'generation_failed')
  assert.equal(submissions.length, before + 1)
})

test('unknown submission survives recovery and blocks Muse, while other providers and models continue', async () => {
  const before = submissions.length
  nextResponse = 'broken'
  const unknown = await generateVideo({ prompt: 'local test', configId: muse.id })
  const queued = await generateVideo({ prompt: 'local test', configId: muse.id })
  await until(() => row(unknown).stage === 'awaiting_confirmation', 'broken response was not retained')
  assert.equal(row(unknown).errorCode, 'submission_unknown')
  assert.equal(row(unknown).taskId, null)
  assert.equal(row(queued).stage, 'queued')
  await assert.rejects(recoverVideoTask(unknown), /未保存上游任务编号/)
  assert.equal((await tasksRoute.request(`/${unknown}`, { method: 'DELETE' })).status, 400)
  await resumeInterruptedTasks()
  await delay(100)
  assert.equal(submissions.length, before + 1, 'neither unknown submission nor queued task was re-submitted')
  const otherProvider = await generateVideo({ prompt: 'local test', configId: other.id })
  const otherModel = await generateVideo({ prompt: 'local test', configId: muse.id, model: 'other-video' })
  await settled(otherProvider)
  await settled(otherModel)
  assert.equal(row(queued).stage, 'queued')
  // Simulate operator confirmation only inside this disposable database, then resume queued work.
  db.update(schema.sysTask).set({ errorCode: 'generation_failed' }).where(eq(schema.sysTask.id, unknown)).run()
  await resumeInterruptedTasks()
  await settled(queued)
})

test('accepted ID survives a broken submission response and is only queried during recovery', async () => {
  const before = submissions.length
  nextResponse = 'header-broken'
  const accepted = await generateVideo({ prompt: 'local test', configId: muse.id })
  const queued = await generateVideo({ prompt: 'local test', configId: muse.id })
  await until(() => row(accepted).stage === 'awaiting_confirmation', 'accepted ID was not retained')
  const upstreamId = row(accepted).taskId!
  assert.ok(upstreamId)
  assert.equal(row(accepted).errorCode, 'upstream_status_unknown')
  assert.equal(submissions.length, before + 1)
  await resumeInterruptedTasks()
  await settled(queued, 'completed', 15000)
  assert.equal(polls.get(upstreamId), 1)
  assert.equal(submissions.length, before + 2)
})

test('persisted queue keeps the original config binding and does not switch to a changed endpoint', async () => {
  const before = submissions.length
  const queued = persisted({ configBaseUrl: `${base}/original-address` })
  await resumeInterruptedTasks()
  await settled(queued.id, 'failed')
  assert.equal(row(queued.id).errorCode, 'preparation_failed')
  assert.equal(submissions.length, before)
})

test('empty legacy model uses the Muse adapter default and remains subject to the queue', async () => {
  const before = submissions.length
  holdNextDownload = true
  const first = await generateVideo({ prompt: 'local test', configId: muse.id })
  await until(() => !!heldDownload, 'first download was not reached')
  const legacy = persisted({ model: '' })
  await recoverVideoTask(legacy.id)
  await delay(100)
  assert.equal(row(legacy.id).stage, 'queued')
  assert.equal(submissions.length, before + 1)
  heldDownload!.end(mp4)
  heldDownload = undefined
  await settled(legacy.id)
  assert.equal(row(first).status, 'completed')
  assert.equal(submissions.length, before + 2)
})

test.after(async () => {
  heldDownload?.end(mp4)
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  db.$client.close()
  await fs.rm(root, { recursive: true, force: true })
})
