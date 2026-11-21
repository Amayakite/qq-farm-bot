import { useStorage } from '@vueuse/core'
import axios from 'axios'
import NProgress from 'nprogress'
import { createRouter, createWebHistory } from 'vue-router'
import { useUserStore } from '@/stores/user'
import { allMenuRoutes } from './menu'
import 'nprogress/nprogress.css'

NProgress.configure({ showSpinner: false })

const adminToken = useStorage('admin_token', '')
let validatedToken = ''
let validatingPromise: Promise<boolean> | null = null
let lastAuthErrorType = ''

async function ensureTokenValid() {
  const token = String(adminToken.value || '').trim()
  if (!token)
    return false

  if (validatedToken && validatedToken === token)
    return true

  if (validatingPromise)
    return validatingPromise

  lastAuthErrorType = ''
  validatingPromise = axios.get('/api/auth/validate', {
    headers: { 'x-admin-token': token },
    timeout: 6000,
  }).then((res) => {
    const ok = !!(res.data && res.data.ok)
    if (ok) {
      validatedToken = token
      useUserStore().userInfo = res.data.data.user
    }
    return ok
  }).catch((error) => {
    lastAuthErrorType = String(error?.response?.data?.errorType || '')
    return false
  }).finally(() => {
    validatingPromise = null
  })

  return validatingPromise
}

function authFailureRoute() {
  if (lastAuthErrorType === 'tenant_expired')
    return { name: 'renew', query: { expired: '1' } }
  if (lastAuthErrorType === 'tenant_disabled')
    return { name: 'login', query: { disabled: '1' } }
  return { name: 'login' }
}

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      component: () => import('@/layouts/DefaultLayout.vue'),
      children: allMenuRoutes.map(route => ({
        path: route.path,
        name: route.name,
        component: route.component,
        meta: route.meta,
      })),
    },
    {
      path: '/mystery-shop',
      name: 'mystery-shop',
      redirect: to => ({ name: 'game-mall', query: { ...to.query, tab: 'mystery' }, hash: to.hash }),
    },
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/Login.vue'),
    },
    {
      path: '/redeem',
      name: 'redeem',
      component: () => import('@/views/Redeem.vue'),
    },
    {
      path: '/renew',
      name: 'renew',
      component: () => import('@/views/Renew.vue'),
    },
  ],
})

const PUBLIC_ROUTES = new Set(['login', 'redeem', 'renew'])

router.beforeEach(async (to, _from) => {
  NProgress.start()

  if (PUBLIC_ROUTES.has(String(to.name || ''))) {
    // 兑换/续费页始终允许访问；登录页在已登录时回到面板。
    if (to.name === 'login' && adminToken.value) {
      const valid = await ensureTokenValid()
      if (valid)
        return useUserStore().userInfo?.mustChangePassword ? true : useUserStore().homePath
      adminToken.value = ''
      validatedToken = ''
      if (lastAuthErrorType)
        return authFailureRoute()
    }
    return true
  }

  if (!adminToken.value) {
    validatedToken = ''
    return { name: 'login' }
  }

  const valid = await ensureTokenValid()
  if (!valid) {
    adminToken.value = ''
    validatedToken = ''
    return authFailureRoute()
  }

  const userStore = useUserStore()
  if (userStore.userInfo?.mustChangePassword)
    return { name: 'login' }

  if ((to.meta.ownerOnly && !userStore.isOwner) || (to.meta.tenantOnly && userStore.isOwner))
    return userStore.homePath

  return true
})

router.afterEach(() => {
  NProgress.done()
})

export default router
