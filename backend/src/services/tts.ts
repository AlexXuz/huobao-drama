/**
 * OpenAI 兼容语音合成（TTS）。
 *
 * POST {baseUrl}/v1/audio/speech { model, input, voice, response_format: 'mp3' } -> 音频字节流（ArrayBuffer）。
 * base 取自 getTextProviderBaseUrl(config)，provider 为 openai 时为 {baseUrl}/v1。
 * 全程不打印、不记录 apiKey。
 */
import { getTextProviderBaseUrl, type AIConfig } from './ai.js'

export const OPENAI_TTS_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] as const

const ALLOWED_MODELS = ['tts-1', 'tts-1-hd'] as const
const MAX_INPUT_LENGTH = 4096

export async function generateSpeech({ config, model, voice, input }: {
  config: AIConfig
  model?: string
  voice: string
  input: string
}): Promise<ArrayBuffer> {
  const resolvedModel = model || 'tts-1'
  if (!(ALLOWED_MODELS as readonly string[]).includes(resolvedModel)) {
    throw new Error('语音生成失败：不支持的模型')
  }
  const text = input ?? ''
  if (!text.trim()) throw new Error('语音生成失败：试音文本必填')
  if (text.length > MAX_INPUT_LENGTH) throw new Error('语音生成失败：试音文本不能超过 4096 字')
  if (!(OPENAI_TTS_VOICES as readonly string[]).includes(voice)) {
    throw new Error('语音生成失败：不支持的音色')
  }
  const base = getTextProviderBaseUrl(config)
  const res = await fetch(`${base}/audio/speech`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: resolvedModel, input: text, voice, response_format: 'mp3' }),
    signal: AbortSignal.timeout(120000),
  })
  if (!res.ok) {
    let detail = ''
    try {
      const data: any = await res.json()
      detail = data?.error?.message || data?.message || ''
    } catch {
      detail = ''
    }
    throw new Error(detail ? `语音生成失败：${detail}` : `语音生成失败，HTTP ${res.status}`)
  }
  return res.arrayBuffer()
}
