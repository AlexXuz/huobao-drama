/** These two text models always run without reasoning in this private deployment. */
export function noReasoningModelId(model: string): string | undefined {
  const name = model.trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (['gpt6.1terra', 'gpt6.1terre'].includes(name)) return 'gpt-6.1-terra'
  if (['gpt6luna', '6luna'].includes(name)) return 'gpt-6-luna'
  return undefined
}

export function isOfficialOpenAIHost(baseURL: string): boolean {
  try { return new URL(baseURL).hostname === 'api.openai.com' }
  catch { return false }
}

export function textModelPolicy(model: string, baseURL: string) {
  const canonical = noReasoningModelId(model)
  const official = isOfficialOpenAIHost(baseURL)
  return {
    // Canonicalize official model display names; custom provider IDs stay intact.
    model: official && canonical ? canonical : model,
    responses: official && canonical === 'gpt-6.1-terra',
  }
}

/** Last request transformation, after SDK serialization and generic proxy patches. */
export function createNoReasoningFetch(model: string, inner: typeof fetch = fetch): typeof fetch {
  if (!noReasoningModelId(model)) return inner
  return async (input, init) => {
    if (typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body)
        if (Array.isArray(body?.messages)) {
          body.reasoning_effort = 'none'
          init = { ...init, body: JSON.stringify(body) }
        } else if (body && typeof body === 'object' && 'input' in body) {
          body.reasoning = { ...body.reasoning, effort: 'none' }
          init = { ...init, body: JSON.stringify(body) }
        }
      } catch { /* Non-JSON requests pass through unchanged. */ }
    }
    return inner(input, init)
  }
}
