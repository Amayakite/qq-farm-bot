import { useStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed } from 'vue'
import api, { getApiErrorMessage } from '@/api'

export type UserRole = 'owner' | 'tenant'

export interface AdminInfo {
  id?: string
  username: string
  role: UserRole
  status?: string
  avatar?: string
  mustChangePassword?: boolean
  expiresAt?: number | null
  maxAccounts?: number
  accountCount?: number
  note?: string
}

export interface LoginResult {
  ok: boolean
  error?: string
  errorType?: string
  remainingMs?: number
  expiresAt?: number | null
  data?: {
    token: string
    role: UserRole
    user: AdminInfo
    mustChangePassword?: boolean
    expiresAt?: number | null
    maxAccounts?: number
  }
}

interface CredentialResult {
  ok: boolean
  error?: string
  errorType?: string
  expiresAt?: number | null
}

export const useUserStore = defineStore('user', () => {
  const token = useStorage('admin_token', '')
  const userInfo = useStorage<AdminInfo | null>('user_info', null)
  const isLoggedIn = computed(() => !!token.value)
  const isOwner = computed(() => userInfo.value?.role === 'owner')
  const isTenant = computed(() => userInfo.value?.role === 'tenant')
  const username = computed(() => userInfo.value?.username || '')
  const avatar = computed(() => userInfo.value?.avatar || '')
  const roleLabel = computed(() => isOwner.value ? '超级管理员' : '用户')
  const homePath = computed(() => isOwner.value ? '/admin' : '/home')
  const expiresAt = computed(() => userInfo.value?.expiresAt || null)
  const isExpired = computed(() => {
    const value = expiresAt.value
    return typeof value === 'number' && value > 0 && value <= Date.now()
  })
  const expiresInDays = computed(() => {
    const value = expiresAt.value
    if (typeof value !== 'number' || value <= 0)
      return null
    return Math.max(0, Math.ceil((value - Date.now()) / 86_400_000))
  })

  function applyAuth(data: LoginResult['data']) {
    if (!data)
      return
    // 切换用户时不要沿用上一个租户选中的游戏账号。
    localStorage.removeItem('current_account_id')
    token.value = data.token
    userInfo.value = {
      ...data.user,
      role: data.role || data.user?.role || 'tenant',
      mustChangePassword: data.mustChangePassword ?? data.user?.mustChangePassword,
    }
  }

  async function login(usernameInput: string, password: string): Promise<LoginResult> {
    try {
      const res = await api.post('/api/login', { username: usernameInput, password })
      if (res.data.ok)
        applyAuth(res.data.data)
      return res.data
    }
    catch (error: any) {
      const data = error.response?.data
      return data
        ? {
            ok: false,
            error: getApiErrorMessage(data, '网络错误'),
            errorType: data.errorType,
            remainingMs: data.remainingMs,
            expiresAt: data.expiresAt,
          }
        : { ok: false, error: getApiErrorMessage(error, '网络错误') }
    }
  }

  async function redeem(code: string, usernameInput: string, password: string): Promise<CredentialResult> {
    try {
      const res = await api.post('/api/redeem', { code, username: usernameInput, password })
      if (res.data.ok)
        applyAuth(res.data.data)
      return res.data
    }
    catch (error: any) {
      const data = error.response?.data
      return {
        ok: false,
        error: getApiErrorMessage(data || error, '兑换失败'),
        errorType: data?.errorType,
        expiresAt: data?.expiresAt,
      }
    }
  }

  async function renew(code: string, usernameInput: string, password: string): Promise<CredentialResult> {
    try {
      const res = await api.post('/api/renew', { code, username: usernameInput, password })
      if (res.data.ok)
        applyAuth(res.data.data)
      return res.data
    }
    catch (error: any) {
      const data = error.response?.data
      return {
        ok: false,
        error: getApiErrorMessage(data || error, '续费失败'),
        errorType: data?.errorType,
        expiresAt: data?.expiresAt,
      }
    }
  }

  async function logout() {
    try {
      await api.post('/api/logout')
    }
    finally {
      clearAuth()
    }
  }

  function clearAuth() {
    token.value = ''
    userInfo.value = null
    localStorage.removeItem('current_account_id')
  }

  async function fetchUserInfo() {
    try {
      const res = await api.get('/api/user/me')
      if (res.data.ok)
        userInfo.value = res.data.data
      return res.data
    }
    catch {
      return { ok: false }
    }
  }

  async function changePassword(oldPassword: string, newPassword: string) {
    const res = await api.post('/api/user/change-password', { oldPassword, newPassword })
    if (res.data.ok)
      clearAuth()
    return res.data
  }

  return {
    token,
    userInfo,
    isLoggedIn,
    isOwner,
    isTenant,
    username,
    avatar,
    roleLabel,
    homePath,
    expiresAt,
    expiresInDays,
    isExpired,
    login,
    redeem,
    renew,
    logout,
    fetchUserInfo,
    changePassword,
  }
})
