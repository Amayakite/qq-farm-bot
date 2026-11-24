import { useStorage } from '@vueuse/core'
import axios from 'axios'
import { useAppUpdateStore } from '@/stores/app-update'
import { useToastStore } from '@/stores/toast'
import { isTransientNetworkError } from '@/utils/panel-update'

const tokenRef = useStorage('admin_token', '')
const accountIdRef = useStorage('current_account_id', '')

const api = axios.create({
  baseURL: '/',
  timeout: 10000,
})

export function normalizeApiErrorMessage(raw: unknown): string {
  const text = String(raw || '').trim()
  if (!text)
    return ''

  const codeMatch = text.match(/\bcode=\d+\b/)
  if (codeMatch && codeMatch.index !== undefined && text.slice(0, codeMatch.index).includes('.')) {
    const rest = text.slice(codeMatch.index + codeMatch[0].length).trim()
    if (rest)
      return rest
  }
  return text
}

export function getApiErrorMessage(error: unknown, fallback = '请求失败'): string {
  const candidate = error as any
  const data = candidate?.response?.data
    || (candidate && typeof candidate === 'object' ? candidate : null)
  const raw = data?.errorMessage
    || data?.error
    || data?.message
    || candidate?.message
    || (typeof error === 'string' ? error : '')
  return normalizeApiErrorMessage(raw) || fallback
}

api.interceptors.request.use((config) => {
  const token = tokenRef.value
  if (token) {
    config.headers['x-admin-token'] = token
  }
  const accountId = accountIdRef.value
  if (accountId && !config.headers.has('x-account-id')) {
    config.headers.set('x-account-id', accountId)
  }
  return config
}, (error) => {
  return Promise.reject(error)
})

api.interceptors.response.use((response) => {
  const appUpdate = useAppUpdateStore()
  appUpdate.notifyBackendReachable()
  const observedBuildId = response?.data?.data?.webBuildId
  if (typeof observedBuildId === 'string' && observedBuildId)
    appUpdate.observeBuildId(observedBuildId)

  const responseData = response?.data
  const skipToast = (response?.config as any)?.skipErrorToast
  if (responseData && typeof responseData === 'object' && responseData.ok === false) {
    const message = getApiErrorMessage(responseData, '')
    if (message) {
      responseData.error = message
      if (!skipToast)
        useToastStore().error(message)
    }
  }
  return response
}, (error) => {
  // Aborting an in-flight request is expected when a modal closes or a QR flow restarts.
  if (axios.isCancel(error) || error?.code === 'ERR_CANCELED')
    return Promise.reject(error)

  const toast = useToastStore()
  const appUpdate = useAppUpdateStore()
  const isLoginRequest = String(error.config?.url || '').includes('/api/login')
  const transient = isTransientNetworkError(error)
  if (error.response && Number(error.response.status) < 500)
    appUpdate.notifyBackendReachable()
  if (transient && !isLoginRequest)
    appUpdate.notifyBackendUnavailable()
  const suppressTransientToast = transient && !isLoginRequest && appUpdate.reconnecting

  const normalizedMessage = getApiErrorMessage(error, '')
  if (normalizedMessage) {
    error.message = normalizedMessage
    if (error.response?.data && typeof error.response.data === 'object')
      error.response.data.error = normalizedMessage
  }

  // 支持 skipErrorToast 配置，让调用方自行处理错误
  const skipToast = error.config?.skipErrorToast

  if (error.response) {
    if (error.response.status === 401) {
      // Avoid redirect loop or multiple redirects
      if (!window.location.pathname.includes('/login') && !window.location.pathname.startsWith('/renew')) {
        let expiredTenant = false
        try {
          const cached = JSON.parse(localStorage.getItem('user_info') || 'null')
          expiredTenant = cached?.role === 'tenant'
            && typeof cached?.expiresAt === 'number'
            && cached.expiresAt <= Date.now()
        }
        catch {
          // ignore malformed cached user info
        }
        tokenRef.value = ''
        localStorage.removeItem('user_info')
        window.location.href = expiredTenant ? '/renew?expired=1' : '/login'
        toast.warning(expiredTenant ? '账号已到期，请续费' : '登录已过期，请重新登录')
      }
    }
    else if (error.response.status === 403) {
      const errorType = error.response.data?.errorType
      if (errorType === 'tenant_expired' || errorType === 'tenant_disabled') {
        tokenRef.value = ''
        localStorage.removeItem('user_info')
        const target = errorType === 'tenant_expired' ? '/renew?expired=1' : '/login?disabled=1'
        if (!window.location.pathname.startsWith(errorType === 'tenant_expired' ? '/renew' : '/login')) {
          window.location.href = target
          toast.warning(errorType === 'tenant_expired' ? '账号已到期，请续费' : '账号已被停用')
        }
        return Promise.reject(error)
      }
      if (!skipToast) {
        toast.error(errorType === 'owner_only'
          ? '仅管理员可执行此操作'
          : getApiErrorMessage(error, '没有权限执行此操作'))
      }
    }
    else if (error.response.status >= 500) {
      const backendError = getApiErrorMessage(error, '')
      // 后端运行态可预期错误：不弹全局500，交给页面状态处理
      if (backendError === '账号未运行' || backendError === 'API Timeout') {
        return Promise.reject(error)
      }
      if (!skipToast && !suppressTransientToast) {
        toast.error(backendError || '请求失败，请稍后重试')
      }
    }
    else {
      if (!skipToast) {
        toast.error(getApiErrorMessage(error, `请求失败，请联系管理员！`))
      }
    }
  }
  else if (error.request) {
    if (!skipToast && !suppressTransientToast) {
      toast.error('网络错误，无法连接到服务器')
    }
  }
  else {
    if (!skipToast) {
      toast.error(`错误: ${getApiErrorMessage(error, '请求失败')}`)
    }
  }

  return Promise.reject(error)
})

export default api
