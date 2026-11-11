
/**
 * OpenAI 兼容视频生成 Adapter（muse2api 网关 muse-video）。
 *
 * 协议（网关接入文档 https://alexych.asia/muse/）：
 * - POST /v1/videos { prompt, duration, size } -> { id, status: "queued" }
 * - GET  /v1/videos/{id} -> { status: "queued" | "processing" | "succeeded" | "failed", result: { url: "/v1/media/xxx.mp4" } }
 * - 结果 url 为相对路径，需按 baseUrl 的 origin 拼成绝对地址再下载（/v1/media/* 无需鉴权）
 */
import type {
  AIConfig,
  ProviderRequest,
  VideoGenerationRecord,
  VideoGenResponse,
  VideoPollResponse,
  VideoProviderAdapter,
} from './types'
import { joinProviderUrl } from './url'

const DEFAULT_MODEL = 'muse-video'
const VALID_RATIOS = new Set(['1:1', '16:9', '9:16', '4:3', '3:4'])

/**
 * ACT: parse 方法收不到 config，拿不到 baseUrl；origin 在 build 请求时暂存到实例上。
 * 调用链里每次 parse 之前一定刚调过同任务的 buildPollRequest/buildGenerateRequest，
 * 所以暂存值总是当前任务的；多任务并发用不同 baseUrl 时理论上可能串，当前单配置试用可接受。
 */
export class OpenAIVideoAdapter implements VideoProviderAdapter {
  provider = 'openai'
  private baseOrigin = ''

  private captureOrigin(config: AIConfig) {
    try {
      this.baseOrigin = new URL(config.baseUrl).origin
    } catch {
      this.baseOrigin = ''
    }
  }

  /** 网关返回的 result.url 是相对路径（/v1/media/xxx.mp4），拼成绝对地址；已是绝对地址则原样返回 */
  private resolveUrl(url: string | null | undefined): string | null {
    if (!url) return null
    if (/^https?:\/\//i.test(url)) return url
    if (!this.baseOrigin) return null
    try {
      return new URL(url, this.baseOrigin).toString()
    } catch {
      return null
    }
  }

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    this.captureOrigin(config)
    const model = record.model || config.model || DEFAULT_MODEL
    const prompt = (record.prompt || '').trim()
    if (!prompt) throw new Error('muse-video 要求必须提供提示词')
    const body: any = {
      model,
      prompt,
      duration: this.normalizeDuration(record.duration),
      size: this.normalizeRatio(record.aspectRatio),
    }
    // 图生视频：规范字段 images（有序数组，最多 10 张），公网 URL / Data URL / { url } 对象均可。
    let referenceImages: unknown[] = []
    try {
      const parsed = JSON.parse(record.referenceImageUrls ?? "[]")
      if (Array.isArray(parsed)) referenceImages = parsed
    } catch {
      referenceImages = []
    }
    const images: unknown[] = [record.firstFrameUrl, record.imageUrl, ...referenceImages, record.lastFrameUrl]
      .map((item) => (typeof item === "string" ? item.trim() : item))
      .filter((item) => item !== "" && item != null)
      .filter((item, index, arr) => arr.indexOf(item) === index)
      .slice(0, 10)
    if (images.length > 0) body.images = images
    return {
      url: joinProviderUrl(config.baseUrl, '/v1', '/videos'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    const taskId = result.id ?? result.task_id ?? result.task?.id
    const videoUrl = this.resolveUrl(result.result?.url || result.url || result.video_url)
    if (videoUrl && (!result.status || result.status === 'succeeded')) {
      return { isAsync: false, videoUrl, taskId: taskId == null ? undefined : String(taskId), duration: result.duration }
    }
    if (taskId != null) return { isAsync: true, taskId: String(taskId) }
    throw new Error('No task id or video url in response')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    this.captureOrigin(config)
    return {
      url: joinProviderUrl(config.baseUrl, '/v1', `/videos/${taskId}`),
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): VideoPollResponse {
    const status = result.status
    if (status === 'succeeded' || status === 'completed') {
      return {
        status: 'completed',
        videoUrl: this.resolveUrl(result.result?.url || result.url || result.video_url) ?? undefined,
        duration: result.result?.duration ?? result.duration,
      }
    }
    if (status === 'failed') {
      const err = result.error ?? result.result?.error
      const msg = typeof err === 'string' ? err : (err?.message || JSON.stringify(err) || 'Video generation failed')
      return { status: 'failed', error: msg, errorCode: typeof result.error_code === 'string' ? result.error_code : undefined }
    }
    return { status: 'processing', ...(result.stage === 'retrying' ? { stage: 'retrying' as const } : {}) }
  }

  extractVideoUrl(result: any): string | null {
    return this.resolveUrl(result.result?.url || result.url || result.video_url)
  }

  private normalizeDuration(duration?: number | null): number {
    const parsed = Math.round(Number(duration || 5))
    if (!Number.isFinite(parsed) || parsed <= 0) return 5
    return parsed
  }

  private normalizeRatio(ratio?: string | null): string {
    const r = (ratio || '').trim()
    return VALID_RATIOS.has(r) ? r : '16:9'
  }
}
