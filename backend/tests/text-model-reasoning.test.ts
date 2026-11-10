import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModelV3CallOptions } from '@ai-sdk/provider'
import { createNoReasoningFetch, isOfficialOpenAIHost, noReasoningModelId, textModelPolicy } from '../src/agents/text-model-reasoning.js'

const officialBase = 'https://api.openai.com/v1'

test('official display names and spelling aliases resolve to the requested model', () => {
  for (const alias of ['gpt-6.1-terra', 'GPT-6.1 Terra', 'gpt-6.1-terre', ' GPT_6.1_TERRE ']) {
    assert.equal(noReasoningModelId(alias), 'gpt-6.1-terra')
    assert.deepEqual(textModelPolicy(alias, officialBase), { model: 'gpt-6.1-terra', responses: true })
  }
  for (const alias of ['gpt-6-luna', 'GPT-6 Luna', '6luna', ' GPT_6_LUNA ']) {
    assert.equal(noReasoningModelId(alias), 'gpt-6-luna')
    assert.deepEqual(textModelPolicy(alias, officialBase), { model: 'gpt-6-luna', responses: false })
  }
})

test('custom endpoints retain their exact model IDs and Chat Completions routing', () => {
  for (const base of ['https://gateway.example/v1', 'https://api.openai.com.example/v1', 'https://gateway.example/api.openai.com/v1']) {
    assert.equal(isOfficialOpenAIHost(base), false)
    for (const model of ['GPT-6 Luna', 'gpt-6.1-terre', 'gpt-6.1-terra']) {
      assert.deepEqual(textModelPolicy(model, base), { model, responses: false })
    }
  }
  assert.equal(isOfficialOpenAIHost('not a URL'), false)
  assert.equal(isOfficialOpenAIHost('https://API.OPENAI.COM/v1'), true)
})

test('unrelated models keep their IDs, route and fetch implementation', () => {
  const transport: typeof fetch = async () => { throw new Error('unexpected transport call') }
  for (const model of ['gpt-4o', 'gpt-5.4', 'gpt-6.1-terra-pro', 'gpt-6-luna-preview', 'vendor/gpt-6-luna', 'gemini-3-flash']) {
    assert.equal(noReasoningModelId(model), undefined)
    assert.deepEqual(textModelPolicy(model, officialBase), { model, responses: false })
    assert.equal(createNoReasoningFetch(model, transport), transport)
  }
})

const initialPrompt: LanguageModelV3CallOptions['prompt'] = [
  { role: 'system', content: 'Use the available tool when requested.' },
  { role: 'user', content: [{ type: 'text', text: 'Read the local test record.' }] },
]
const continuationPrompt: LanguageModelV3CallOptions['prompt'] = [
  ...initialPrompt,
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_local_1', toolName: 'read_local_record', input: { id: 7 } }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_local_1', toolName: 'read_local_record', output: { type: 'json', value: { id: 7, text: 'local record' } } }] },
]

for (const requestedModel of ['GPT-6 Luna', 'gpt-6.1-terre']) {
  for (const operation of ['doGenerate', 'doStream'] as const) {
    test(`${requestedModel} ${operation}: real SDK initial and tool-result requests disable reasoning`, async () => {
      const policy = textModelPolicy(requestedModel, officialBase)
      const captures: Array<{ url: string; body: Record<string, any> }> = []
      // Capture after actual SDK serialization; this terminal transport never uses the network.
      const capture: typeof fetch = async (input, init) => {
        captures.push({
          url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
          body: JSON.parse(String(init?.body)),
        })
        throw new Error('LOCAL_SERIALIZATION_CAPTURE_COMPLETE')
      }
      const provider = createOpenAI({
        apiKey: 'local-test-not-a-real-key',
        baseURL: officialBase,
        fetch: createNoReasoningFetch(policy.model, capture),
      })
      const model = policy.responses ? provider.responses(policy.model) : provider.chat(policy.model)

      for (const prompt of [initialPrompt, continuationPrompt]) {
        const options: LanguageModelV3CallOptions = {
          prompt,
          tools: [{ type: 'function', name: 'read_local_record', description: 'Read a local test record.', inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'], additionalProperties: false } }],
          toolChoice: { type: 'tool', toolName: 'read_local_record' },
          // Force the old SDK to serialize a conflicting value, proving the final patch wins.
          providerOptions: { openai: { forceReasoning: true, reasoningEffort: 'high', reasoningSummary: 'auto' } },
        }
        await assert.rejects(async () => model[operation](options))
      }
      assert.equal(captures.length, 2, 'both actual SDK calls must reach the terminal capture')
      for (const { url, body } of captures) {
        assert.equal(url, `${officialBase}/${policy.responses ? 'responses' : 'chat/completions'}`)
        assert.equal(body.model, policy.model)
        assert.equal(body.stream, operation === 'doStream' ? true : undefined)
        assert.equal(body.thinking, undefined, 'official requests must not acquire third-party thinking fields')
        assert.equal(body.enable_thinking, undefined)
        if (policy.responses) {
          assert.deepEqual(body.reasoning, { effort: 'none', summary: 'auto' })
          assert.equal(body.reasoning_effort, undefined)
          assert.equal(body.tools[0].name, 'read_local_record')
          assert.equal(body.tool_choice.name, 'read_local_record')
          assert.ok(Array.isArray(body.input))
        } else {
          assert.equal(body.reasoning_effort, 'none')
          assert.equal(body.reasoning, undefined)
          assert.equal(body.tools[0].function.name, 'read_local_record')
          assert.equal(body.tool_choice.function.name, 'read_local_record')
          assert.ok(Array.isArray(body.messages))
        }
      }
      const secondBody = captures[1].body
      if (policy.responses) {
        assert.ok(secondBody.input.some((item: any) => item.type === 'function_call' && item.call_id === 'call_local_1'))
        assert.ok(secondBody.input.some((item: any) => item.type === 'function_call_output' && item.call_id === 'call_local_1'))
      } else {
        assert.ok(secondBody.messages.some((item: any) => item.role === 'assistant' && item.tool_calls?.[0]?.id === 'call_local_1'))
        assert.ok(secondBody.messages.some((item: any) => item.role === 'tool' && item.tool_call_id === 'call_local_1'))
      }
    })
  }
}

test('Responses none is injected even when the installed SDK does not recognize the model', async () => {
  let body: Record<string, any> | undefined
  const capture: typeof fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body))
    throw new Error('LOCAL_SERIALIZATION_CAPTURE_COMPLETE')
  }
  const provider = createOpenAI({ apiKey: 'local-test-not-a-real-key', fetch: createNoReasoningFetch('gpt-6.1-terra', capture) })
  await assert.rejects(async () => provider.responses('gpt-6.1-terra').doGenerate({
    prompt: initialPrompt,
    providerOptions: { openai: { reasoningEffort: 'none' } },
  }))
  assert.ok(body)
  assert.deepEqual(body.reasoning, { effort: 'none' })
})

test('final transformation preserves other reasoning fields and caller request data', async () => {
  const original = { model: 'gpt-6.1-terra', input: 'hello', reasoning: { effort: 'high', summary: 'detailed', custom: 'preserved' }, temperature: 0.4 }
  const init: RequestInit = { method: 'POST', headers: { 'X-Local-Test': 'true' }, body: JSON.stringify(original) }
  const capture: typeof fetch = async (_input, received) => {
    assert.deepEqual(JSON.parse(String(received?.body)), { ...original, reasoning: { ...original.reasoning, effort: 'none' } })
    assert.equal(received?.headers, init.headers)
    assert.equal(received?.method, 'POST')
    return new Response(null, { status: 204 })
  }
  await createNoReasoningFetch('gpt-6.1-terra', capture)('https://api.openai.com/v1/responses', init)
  assert.equal(init.body, JSON.stringify(original), 'the caller request object is not mutated')
})

test('non-text and non-JSON requests are passed through without rewriting', async () => {
  for (const body of ['not JSON', JSON.stringify({ model: 'gpt-6-luna', contents: [{ text: 'untouched' }] })]) {
    const init = { method: 'POST', body }
    const capture: typeof fetch = async (_input, received) => {
      assert.equal(received, init)
      return new Response(null, { status: 204 })
    }
    await createNoReasoningFetch('gpt-6-luna', capture)('https://provider.example', init)
  }
})
