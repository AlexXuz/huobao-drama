import { ref } from 'vue'
import { useDesktopBridge } from './useDesktopBridge'

const gatewayUser = ref<string | null>(null)
const gatewayLoggingOut = ref(false)
let sessionRequest: Promise<void> | undefined
let redirecting = false

function goToLogin(keepCurrentPage = true) {
  if (typeof window === 'undefined' || useDesktopBridge() || redirecting) return
  redirecting = true
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`
  const next = current.startsWith('/') && !current.startsWith('//') && !current.includes('\\')
    && new URL(current, window.location.origin).origin === window.location.origin ? current : '/'
  window.location.replace(keepCurrentPage ? `/auth/login?next=${encodeURIComponent(next)}` : '/auth/login')
}

/** 只识别登录网关的明确错误码；模型服务的 401 不代表网页登录失效。 */
export function handleGatewayLoginRequired(status: number, body: unknown): boolean {
  if (status !== 401 || !body || typeof body !== 'object'
    || (body as { error_code?: unknown }).error_code !== 'loginRequired') return false
  goToLogin()
  return true
}

async function refreshGatewaySession(): Promise<void> {
  if (typeof window === 'undefined' || useDesktopBridge()) return
  if (sessionRequest) return sessionRequest
  sessionRequest = (async () => {
    try {
      const response = await fetch('/auth/session', {
        credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { Accept: 'application/json' },
      })
      if (!response.headers.get('Content-Type')?.includes('application/json')) return
      const body = await response.json()
      if (response.status === 200 && body.authenticated === true && typeof body.user === 'string' && body.user.trim()) {
        gatewayUser.value = body.user
      } else if (response.status === 401 && body.authenticated === false) {
        gatewayUser.value = null
        goToLogin()
      }
    } catch { /* 桌面版及没有登录网关的开发环境不显示网页登录入口。 */ }
    finally { sessionRequest = undefined }
  })()
  return sessionRequest
}

async function logoutGatewaySession(): Promise<void> {
  if (!gatewayUser.value || gatewayLoggingOut.value) return
  gatewayLoggingOut.value = true
  try {
    const response = await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin', redirect: 'error' })
    if (response.status === 204) {
      gatewayUser.value = null
      goToLogin(false)
      return
    }
    const body = await response.json().catch(() => null)
    if (handleGatewayLoginRequired(response.status, body)) return
    throw new Error('logoutFailed')
  } finally { gatewayLoggingOut.value = false }
}

export function useGatewaySession() {
  return { gatewayUser, gatewayLoggingOut, refreshGatewaySession, logoutGatewaySession }
}
