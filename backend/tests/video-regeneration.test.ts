import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-regeneration-'))
Object.assign(process.env, { SQLITE_PATH: path.join(root, 'tasks.sqlite3'), HUOBAO_DATA_DIR: root,
  STORAGE_PATH: path.join(root, 'static'), MYSQL_AUTO_IMPORT: 'false',
  FFMPEG_BIN: path.join(root, 'no-ffmpeg'), FFPROBE_BIN: path.join(root, 'no-ffprobe') })
const { db, schema } = await import('../src/db/index.js')
const { generateVideo, recoverVideoTask, resumeInterruptedTasks } = await import('../src/services/generation.js')
const tasksRoute = (await import('../src/routes/tasks.js')).default
const { OpenAIVideoAdapter } = await import('../src/services/adapters/openai-video.js')
const video = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(32)])
let posts = 0, polls = 0
let holdDownload = false, held: http.ServerResponse | undefined
let pollCode = 'generation_unknown'
const server = http.createServer(async (req, res) => {
  if (req.method === 'POST') {
    for await (const _chunk of req) { /* Consume without retaining request contents. */ }
    posts++
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ id: `generated-${posts}`, status: 'succeeded', result: { url: `${base}/video` } }))
  } else if (req.url?.startsWith('/v1/videos/')) {
    polls++
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(polls === 1
      ? { status: 'processing', stage: 'retrying', retry_count: 1 }
      : { status: 'failed', error_code: pollCode, error: 'local fixture outcome' }))
  } else {
    if (holdDownload) { holdDownload = false; held = res; return }
    res.end(video)
  }
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
const ts = new Date().toISOString()
const config = db.insert(schema.aiServiceConfigs).values({ serviceType: 'video', provider: 'openai', name: 'local test',
  baseUrl: base, apiKey: 'local-only', model: '["muse-video"]', createdAt: ts, updatedAt: ts }).returning().get()
const row = (id: number) => db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()!
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (predicate()) return; await delay(20) }
  assert.fail('Expected task state did not arrive')
}
function persisted(values: Partial<typeof schema.sysTask.$inferInsert> = {}) {
  return db.insert(schema.sysTask).values({ type: 'video', provider: 'openai', model: 'muse-video',
    configId: config.id, configBaseUrl: base, prompt: 'local test', params: '{}', status: 'failed',
    stage: 'polling', errorCode: 'generation_failed', createdAt: ts, updatedAt: ts, ...values }).returning().get()
}
function storyboard() {
  return db.insert(schema.storyboards).values({ episodeId: 1, storyboardNumber: 1, createdAt: ts, updatedAt: ts }).returning().get()
}
function request(storyboardId: number, forceNew?: boolean) {
  return tasksRoute.request('/', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'video', storyboard_id: storyboardId, config_id: config.id,
      model: 'muse-video', prompt: 'local test', ...(forceNew === undefined ? {} : { force_new: forceNew }) }) })
}

test('confirmed failed tasks regenerate without force_new or a confirmation gate; running task cannot duplicate', async () => {
  for (const code of ['generation_failed', 'video_text_only', 'model_refusal', 'quota_exceeded', 'browser_queue_timeout']) {
    const sb = storyboard()
    persisted({ storyboardId: sb.id, taskId: 'old-confirmed-failure', errorCode: code })
    const before = posts
    holdDownload = true
    const response = await request(sb.id)
    assert.equal(response.status, 201, code)
    const created = (await response.json() as any).data
    await until(() => !!held)
    assert.equal(posts, before + 1, 'one new generation, not a recovery or duplicate')
    assert.equal((await request(sb.id, true)).status, 400)
    await assert.rejects(generateVideo({ storyboardId: sb.id, prompt: 'local test', configId: config.id, forceNew: true }), /运行中的任务/)
    assert.equal(posts, before + 1)
    held!.end(video); held = undefined
    await until(() => row(created.id).status === 'completed')
    await delay(30)
  }
})

test('an existing video defaults to recovery while an explicit regenerate button may create a replacement', async () => {
  const sb = storyboard()
  persisted({ storyboardId: sb.id, taskId: 'already-produced', resultUrl: `${base}/video`, errorCode: 'delivery_failed' })
  const before = posts
  assert.equal((await request(sb.id)).status, 400)
  assert.equal(posts, before)
  const response = await request(sb.id, true)
  assert.equal(response.status, 201)
  const created = (await response.json() as any).data
  await until(() => row(created.id).status === 'completed')
  assert.equal(posts, before + 1)
  await delay(30)
})

test('unknown results cannot be bypassed by force_new in either API or service, including non-Muse submissions', async () => {
  for (const fixture of [
    { provider: 'openai', taskId: 'known-upstream-id', errorCode: 'generation_unknown' },
    { provider: 'openai', taskId: null, errorCode: 'submission_unknown' },
    { provider: 'minimax', taskId: null, errorCode: 'submission_unknown' },
  ]) {
    const sb = storyboard()
    const unknown = persisted({ ...fixture, storyboardId: sb.id, stage: 'awaiting_confirmation' })
    const before = posts
    for (const force of [undefined, true]) assert.equal((await request(sb.id, force)).status, 400)
    await assert.rejects(generateVideo({ storyboardId: sb.id, prompt: 'local test', configId: config.id, forceNew: true }), /尚未确认/)
    assert.equal((await tasksRoute.request(`/${unknown.id}`, { method: 'DELETE' })).status, 400)
    assert.equal(posts, before)
    // Fixture cleanup only; no production task is changed by this test.
    db.delete(schema.sysTask).where(eq(schema.sysTask.id, unknown.id)).run()
  }
})

test('Muse retry state is visible, uncertain terminal result blocks queue, confirmed text-only result releases it', async () => {
  const before = posts
  const active = persisted({ status: 'processing', taskId: 'accepted-task', errorCode: null })
  const queued = persisted({ status: 'processing', stage: 'queued', errorCode: null })
  await resumeInterruptedTasks()
  await until(() => row(active.id).stage === 'retrying', 15000)
  assert.equal(row(queued.id).stage, 'queued')
  assert.equal(posts, before)
  await until(() => row(active.id).stage === 'awaiting_confirmation', 15000)
  assert.equal(row(active.id).errorCode, 'generation_unknown')
  assert.equal(posts, before, 'unknown outcome cannot release the next generation')
  pollCode = 'video_text_only'
  await recoverVideoTask(active.id)
  await until(() => row(queued.id).status === 'completed', 15000)
  assert.equal(row(active.id).errorCode, 'video_text_only')
  assert.equal(posts, before + 1)
  await assert.rejects(recoverVideoTask(active.id), /请重新生成/)
  await delay(30)
})

test('legacy failures stay compatible and upstream stages are not inferred', () => {
  const adapter = new OpenAIVideoAdapter()
  assert.deepEqual(adapter.parsePollResponse({ status: 'failed', error: 'legacy' }), { status: 'failed', error: 'legacy', errorCode: undefined })
  assert.deepEqual(adapter.parsePollResponse({ status: 'processing', retry_count: 1 }), { status: 'processing' })
  assert.deepEqual(adapter.parsePollResponse({ status: 'processing', stage: 'retrying' }), { status: 'processing', stage: 'retrying' })
})

test.after(async () => {
  held?.end(video)
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  db.$client.close()
  await fs.rm(root, { recursive: true, force: true })
})
