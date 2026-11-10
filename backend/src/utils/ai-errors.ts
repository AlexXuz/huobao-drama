export const aiConfigurationMessages = {
  apiKeyLooksLikeUrl: 'API Key 中填入了网址，请把网址填入 Base URL，并填写服务商提供的 API 密钥。',
  apiKeyInvalid: 'API Key 无效或已失效，请在设置 → AI 服务中检查密钥与 Base URL。',
} as const

type AiConfigurationErrorCode = keyof typeof aiConfigurationMessages

export class AiConfigurationError extends Error {
  constructor(public error_code: AiConfigurationErrorCode) {
    super(aiConfigurationMessages[error_code])
    this.name = 'AiConfigurationError'
  }
}

/** 本地无鉴权服务允许空密钥，但网址不能作为 API 密钥发送。 */
export function assertApiKeyValue(value: unknown): void {
  if (value == null || value === '') return
  if (typeof value !== 'string') throw new AiConfigurationError('apiKeyInvalid')
  if (/^(?:[a-z][a-z\d+.-]*:\/\/|www\.)/i.test(value.trim())) {
    throw new AiConfigurationError('apiKeyLooksLikeUrl')
  }
}

const INVALID_KEY_RE = /\b(?:invalid|incorrect|expired)[\s_-]+api[\s_-]+key\b|\bapi[\s_-]+key\b[^\r\n]{0,30}\b(?:not\s+valid|invalid|incorrect|expired)\b|\binvalid_api_key\b/i

/** SDK 非流式/流式错误可能包装在 cause、error 或 errors 中；只返回固定文案，不回显密钥。 */
export function getAiConfigurationError(error: unknown): { error_code: AiConfigurationErrorCode; message: string } | undefined {
  const seen = new Set<unknown>()
  function visit(value: unknown, depth: number): AiConfigurationErrorCode | undefined {
    if (value == null || depth > 8 || seen.has(value)) return
    seen.add(value)
    if (typeof value === 'string') {
      for (const code of Object.keys(aiConfigurationMessages) as AiConfigurationErrorCode[]) {
        if (value === code || value === aiConfigurationMessages[code]) return code
      }
      if (INVALID_KEY_RE.test(value)) return 'apiKeyInvalid'
      return
    }
    if (typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) { const code = visit(item, depth + 1); if (code) return code }
      return
    }
    const details = value as Record<string, unknown>
    const explicit = visit(details.error_code, depth + 1) || visit(details.code, depth + 1)
    if (explicit) return explicit
    if (Number(details.statusCode ?? details.status) === 401) return 'apiKeyInvalid'
    for (const field of ['message', 'cause', 'error', 'errors', 'lastError', 'response', 'data', 'payload', 'responseBody']) {
      const code = visit(details[field], depth + 1)
      if (code) return code
    }
  }
  const error_code = visit(error, 0)
  return error_code ? { error_code, message: aiConfigurationMessages[error_code] } : undefined
}
