<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseTextarea from '@/components/ui/BaseTextarea.vue'
import { useToastStore } from '@/stores/toast'

interface TenantSummary {
  id: string
  username: string
  status: 'active' | 'disabled'
  expiresAt: number | null
  maxAccounts: number
  accountCount: number
  runningCount: number
  lastLoginAt?: number | null
}

const toast = useToastStore()
const loading = ref(false)
const loaded = ref(false)
const loadError = ref('')
const tenants = ref<TenantSummary[]>([])
const stats = ref<any>({})
const codeStats = ref<any>({})
const announcement = ref('')
const announcementEnabled = ref(false)
const announcementBusy = ref(false)
const announcementLoaded = ref(false)

const expiring = computed(() => tenants.value
  .filter(tenant => tenant.status === 'active' && tenant.expiresAt && tenant.expiresAt > Date.now() && tenant.expiresAt <= Date.now() + 7 * 86_400_000)
  .sort((a, b) => Number(a.expiresAt) - Number(b.expiresAt)))
const expired = computed(() => tenants.value.filter(tenant => tenant.status === 'active' && tenant.expiresAt && tenant.expiresAt <= Date.now()))
const disabled = computed(() => tenants.value.filter(tenant => tenant.status === 'disabled'))
const alerts = computed(() => {
  const list: Array<{ key: string, text: string, tone: 'warning' | 'danger' | 'info', to: string, action: string }> = []
  for (const tenant of expired.value.slice(0, 2)) {
    list.push({ key: tenant.id, text: `${tenant.username} 已到期`, tone: 'danger', to: `/admin/tenants?manage=${encodeURIComponent(tenant.id)}&action=extend`, action: '延期' })
  }
  for (const tenant of expiring.value.slice(0, 2)) {
    const id = encodeURIComponent(tenant.id)
    list.push({ key: tenant.id, text: `${tenant.username} 将在 ${remainingDays(tenant.expiresAt)}内到期`, tone: 'warning', to: `/admin/tenants?tab=codes&tenant=${id}&issue=renew&target=${id}`, action: '发续费码' })
  }
  if (expired.value.length > 2)
    list.push({ key: 'expired', text: `共 ${expired.value.length} 个租户已到期`, tone: 'danger', to: '/admin/tenants?filter=expired', action: '全部到期租户' })
  if (expiring.value.length > 2)
    list.push({ key: 'expiring', text: `共 ${expiring.value.length} 个租户即将到期`, tone: 'warning', to: '/admin/tenants?filter=expiring', action: '全部即将到期' })
  if (disabled.value.length)
    list.push({ key: 'disabled', text: `${disabled.value.length} 个租户处于停用状态`, tone: 'info', to: '/admin/tenants?filter=disabled', action: '查看' })
  return list
})

const cards = computed(() => [
  { label: '有效用户', value: stats.value.activeTenantCount || 0, hint: `共 ${stats.value.tenantCount || 0} 位用户`, icon: 'i-carbon-user-multiple' },
  { label: '未使用激活码', value: codeStats.value.unused || 0, hint: `共 ${codeStats.value.total || 0} 个激活码`, icon: 'i-carbon-ticket' },
  { label: '租户运行中账号', value: stats.value.runningCount || 0, hint: `共 ${stats.value.accountCount || 0} 个账号`, icon: 'i-carbon-sprout' },
])

function formatDate(value: number | null | undefined): string {
  if (!value)
    return '永久'
  return new Date(value).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function remainingDays(value: number | null | undefined): string {
  if (!value)
    return '永久'
  const days = Math.ceil((value - Date.now()) / 86_400_000)
  if (days <= 0)
    return '已到期'
  return `${days} 天`
}

function tenantStatus(tenant: TenantSummary): { label: string, className: string } {
  if (tenant.status === 'disabled')
    return { label: '已停用', className: 'status-disabled' }
  if (tenant.expiresAt && tenant.expiresAt <= Date.now())
    return { label: '已到期', className: 'status-expired' }
  return { label: '正常', className: 'status-active' }
}

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    const { data } = await api.get('/api/admin/overview')
    if (data?.ok) {
      tenants.value = data.data.tenants || []
      stats.value = data.data
      codeStats.value = data.data.codes || {}
      loaded.value = true
    }
    else {
      loadError.value = getApiErrorMessage(data, '加载失败')
      toast.error(loadError.value)
    }
  }
  catch (error: any) {
    loadError.value = getApiErrorMessage(error, '加载失败')
    toast.error(loadError.value)
  }
  finally {
    loading.value = false
  }
}

async function loadAnnouncement() {
  try {
    const { data } = await api.get('/api/admin/announcement')
    if (!data?.ok) throw new Error(getApiErrorMessage(data, '加载公告失败'))
    announcement.value = data.data.content || ''
    announcementEnabled.value = data.data.enabled === true
    announcementLoaded.value = true
  } catch (error) { toast.error(getApiErrorMessage(error, '加载公告失败')) }
}

async function saveAnnouncement(enabled: boolean) {
  if (announcementBusy.value) return
  announcementBusy.value = true
  try {
    const { data } = await api.put('/api/admin/announcement', { content: announcement.value, enabled })
    if (!data?.ok) throw new Error(getApiErrorMessage(data, '保存公告失败'))
    announcement.value = data.data.content
    announcementEnabled.value = data.data.enabled
    toast.success(enabled ? '公告已发布' : '公告已隐藏')
  } catch (error) { toast.error(getApiErrorMessage(error, '保存公告失败')) }
  finally { announcementBusy.value = false }
}

onMounted(() => { void load(); void loadAnnouncement() })
</script>

<template>
  <div class="admin-home space-y-5">
    <section class="admin-welcome farm-card rounded-2xl p-5 sm:p-7">
      <div class="flex flex-wrap items-end justify-between gap-5">
        <div class="max-w-xl">
          <p class="admin-eyebrow">管理中心</p>
          <h1 class="mt-2 text-2xl text-gray-900 font-bold dark:text-gray-100 sm:text-3xl">管理用户和托管</h1>
          <p class="mt-2 text-sm leading-6 text-gray-600 dark:text-gray-300">创建激活码邀请用户，查看用户状态，也可以进入农场管理游戏账号。</p>
        </div>
        <BaseButton variant="primary" to="/admin/tenants?tab=codes&issue=new">
          <span class="i-carbon-add" /> 生成激活码
        </BaseButton>
      </div>
    </section>

    <div v-if="loadError" role="alert" class="farm-card flex flex-wrap items-center justify-between gap-3 rounded-xl p-4 text-sm">
      <span>概览加载失败，{{ loadError }}</span>
      <BaseButton variant="secondary" size="sm" :loading="loading" @click="load">重试</BaseButton>
    </div>

    <section aria-labelledby="admin-actions-title">
      <div class="mb-3 flex items-center justify-between">
        <h2 id="admin-actions-title" class="text-base font-bold">常用操作</h2>
        <BaseButton variant="text" size="sm" :loading="loading" @click="load">刷新数据</BaseButton>
      </div>
      <div class="grid gap-3 md:grid-cols-3">
        <RouterLink class="action-card farm-card rounded-xl p-4" to="/admin/tenants?tab=codes">
          <span class="action-card__icon"><span class="i-carbon-ticket" /></span>
          <span class="min-w-0 flex-1"><strong>管理激活码</strong><small>生成、复制、停用和查看使用情况</small></span>
          <span class="i-carbon-arrow-right action-card__arrow" />
        </RouterLink>
        <RouterLink class="action-card farm-card rounded-xl p-4" to="/admin/tenants">
          <span class="action-card__icon"><span class="i-carbon-user-multiple" /></span>
          <span class="min-w-0 flex-1"><strong>管理用户</strong><small>查看账号、有效期和配额</small></span>
          <span class="i-carbon-arrow-right action-card__arrow" />
        </RouterLink>
        <RouterLink class="action-card farm-card rounded-xl p-4" to="/">
          <span class="action-card__icon"><span class="i-carbon-sprout" /></span>
          <span class="min-w-0 flex-1"><strong>进入农场</strong><small>管理游戏账号和查看托管状态</small></span>
          <span class="i-carbon-arrow-right action-card__arrow" />
        </RouterLink>
      </div>
    </section>

    <details class="farm-card rounded-xl p-4">
      <summary class="cursor-pointer text-sm font-semibold">用户公告 <span class="ml-2 text-xs text-gray-500">{{ announcementEnabled ? '已发布' : '未发布' }}</span></summary>
      <p class="mt-3 text-xs text-gray-500">发布后会显示在用户首页，可用于通知维护或登录变化。</p>
      <BaseTextarea v-model="announcement" class="mt-3" label="公告内容" :rows="3" :maxlength="2000" placeholder="输入想告诉用户的内容" />
      <div class="mt-3 flex flex-wrap gap-2">
        <BaseButton variant="primary" size="sm" :loading="announcementBusy" :disabled="!announcementLoaded || !announcement.trim()" @click="saveAnnouncement(true)">发布公告</BaseButton>
        <BaseButton variant="secondary" size="sm" :disabled="!announcementLoaded || !announcementEnabled || announcementBusy" @click="saveAnnouncement(false)">隐藏公告</BaseButton>
      </div>
    </details>

    <section v-if="loaded" aria-labelledby="admin-overview-title">
      <h2 id="admin-overview-title" class="mb-3 text-base font-bold">运行概览</h2>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div v-for="card in cards" :key="card.label" class="farm-card rounded-xl p-4">
          <div class="flex items-start justify-between gap-2">
            <div>
              <div class="text-xs text-gray-500 dark:text-gray-400">{{ card.label }}</div>
              <div class="mt-1 text-2xl text-gray-900 font-bold dark:text-gray-100">{{ card.value }}</div>
              <div class="mt-1 text-xs text-gray-500 dark:text-gray-400">{{ card.hint }}</div>
            </div>
            <span class="stat-card__icon" :class="card.icon" />
          </div>
        </div>
      </div>
    </section>

    <div v-if="loaded" class="grid grid-cols-1 items-start gap-4 xl:grid-cols-[0.8fr_1.2fr]">
      <section class="farm-card rounded-xl p-4">
        <div class="flex items-center justify-between gap-2">
          <h2 class="text-base font-bold">需要关注</h2>
          <span class="text-xs text-gray-500">{{ alerts.length }} 项</span>
        </div>
        <div v-if="alerts.length" class="mt-3 space-y-2">
          <div v-for="alert in alerts" :key="alert.key" class="alert-row" :class="`alert-row--${alert.tone}`">
            <span class="alert-row__dot" />
            <span class="min-w-0 flex-1 text-sm">{{ alert.text }}</span>
            <BaseButton variant="text" size="sm" :to="alert.to">{{ alert.action }}</BaseButton>
          </div>
        </div>
        <p v-else class="mt-4 text-sm text-gray-500">目前没有到期或停用提醒</p>
      </section>

      <section class="overflow-hidden farm-card rounded-xl">
        <div class="flex items-center justify-between gap-2 border-b border-gray-200/60 px-4 py-3 dark:border-gray-700/60">
          <h2 class="text-base font-bold">最近用户</h2>
          <BaseButton variant="text" size="sm" to="/admin/tenants">查看全部</BaseButton>
        </div>
        <div class="overflow-x-auto">
          <table class="admin-table">
            <thead><tr><th>用户名</th><th>状态</th><th>有效期</th><th>账号</th><th>最近登录</th></tr></thead>
            <tbody>
              <tr v-for="tenant in tenants.slice(0, 8)" :key="tenant.id">
                <td class="font-medium">
                  <RouterLink class="text-[var(--ui-primary)]" :to="{ path: '/admin/tenants', query: { manage: tenant.id } }">{{ tenant.username }}</RouterLink>
                </td>
                <td><span class="status-pill" :class="tenantStatus(tenant).className">{{ tenantStatus(tenant).label }}</span></td>
                <td class="whitespace-nowrap text-xs">{{ formatDate(tenant.expiresAt) }}</td>
                <td class="whitespace-nowrap text-xs">{{ tenant.accountCount }} / {{ tenant.maxAccounts }}</td>
                <td class="whitespace-nowrap text-xs">{{ tenant.lastLoginAt ? formatDate(tenant.lastLoginAt) : '从未登录' }}</td>
              </tr>
              <tr v-if="!tenants.length"><td colspan="5" class="py-8 text-center text-sm text-gray-500">暂无用户，生成激活码后即可邀请用户。</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>

    <nav class="flex flex-wrap gap-x-5 gap-y-2 px-1 text-sm" aria-label="其他管理入口">
      <RouterLink class="admin-secondary-link" to="/ranch">进入牧场</RouterLink>
      <RouterLink class="admin-secondary-link" to="/admin/tenants?tab=audit">操作记录</RouterLink>
      <RouterLink class="admin-secondary-link" to="/admin/appearance">外观设置</RouterLink>
      <RouterLink class="admin-secondary-link" to="/settings?tab=system">系统设置</RouterLink>
    </nav>
  </div>
</template>

<style scoped>
.admin-home {
  max-width: 1480px;
  margin-inline: auto;
}

.admin-welcome {
  background: linear-gradient(120deg, color-mix(in srgb, var(--ui-primary) 10%, var(--ui-surface)), var(--ui-surface) 72%);
}

.admin-eyebrow {
  color: var(--ui-primary);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.action-card {
  display: flex;
  align-items: center;
  gap: 12px;
  color: inherit;
  text-decoration: none;
  transition: transform 160ms ease, box-shadow 160ms ease;
}

.action-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 24px rgba(40, 55, 45, 0.1);
}

.action-card:focus-visible, .admin-secondary-link:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 3px;
}

.action-card__icon {
  display: grid;
  width: 42px;
  height: 42px;
  flex: none;
  place-items: center;
  border-radius: 12px;
  background: color-mix(in srgb, var(--ui-primary) 12%, transparent);
  color: var(--ui-primary);
  font-size: 21px;
}

.action-card strong, .action-card small { display: block; }
.action-card strong { font-size: 14px; }
.action-card small { margin-top: 4px; color: var(--ui-muted); font-size: 12px; line-height: 1.5; }
.action-card__arrow { color: var(--ui-muted); font-size: 18px; }
.admin-secondary-link { color: var(--ui-muted); text-decoration: none; }
.admin-secondary-link:hover { color: var(--ui-primary); }

.stat-card__icon {
  color: var(--ui-primary);
  font-size: 26px;
  opacity: 0.8;
}

.alert-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 10px;
  border-radius: 9px;
  background: var(--ui-surface-soft);
}

.alert-row__dot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: var(--ui-primary);
}

.alert-row--danger .alert-row__dot {
  background: var(--ui-danger);
}

.alert-row--warning .alert-row__dot {
  background: var(--ui-warning);
}

.admin-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.admin-table th {
  padding: 9px 12px;
  border-bottom: 1px solid var(--ui-border);
  color: var(--ui-muted);
  font-size: 11px;
  font-weight: 600;
  text-align: left;
  white-space: nowrap;
}

.admin-table td {
  padding: 9px 12px;
  border-bottom: 1px solid var(--ui-border);
  color: var(--ui-ink);
}

.admin-table tbody tr:last-child td {
  border-bottom: 0;
}

.status-pill {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

.status-active {
  color: #1d7a4b;
  background: rgba(45, 164, 102, 0.12);
}

.status-disabled {
  color: #a5464c;
  background: rgba(201, 95, 102, 0.12);
}

.status-expired {
  color: #9a6a1b;
  background: rgba(210, 154, 46, 0.14);
}
</style>
