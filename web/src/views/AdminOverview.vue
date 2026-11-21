<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import { useAppStore } from '@/stores/app'
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

const appStore = useAppStore()
const toast = useToastStore()
const loading = ref(false)
const tenants = ref<TenantSummary[]>([])
const stats = ref<any>({})
const codeStats = ref<any>({})

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
  if (Number(codeStats.value.unused) > 0)
    list.push({ key: 'codes', text: `${codeStats.value.unused} 个激活码未使用`, tone: 'info', to: '/admin/tenants?tab=codes', action: '查看' })
  return list
})

const cards = computed(() => [
  { label: '租户', value: stats.value.tenantCount || 0, hint: `有效 ${stats.value.activeTenantCount || 0}`, icon: 'i-carbon-user-multiple' },
  { label: '激活码', value: codeStats.value.total || 0, hint: `未使用 ${codeStats.value.unused || 0}`, icon: 'i-carbon-ticket' },
  { label: '游戏账号', value: stats.value.accountCount || 0, hint: `运行中 ${stats.value.runningCount || 0}`, icon: 'i-carbon-game-console' },
  { label: '批次', value: codeStats.value.batchCount || 0, hint: `续费码 ${codeStats.value.renewCodes || 0}`, icon: 'i-carbon-catalog' },
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
  try {
    const { data } = await api.get('/api/admin/overview')
    if (data?.ok) {
      tenants.value = data.data.tenants || []
      stats.value = data.data
      codeStats.value = data.data.codes || {}
    }
    else {
      toast.error(getApiErrorMessage(data, '加载失败'))
    }
  }
  catch (error: any) {
    toast.error(getApiErrorMessage(error, '加载失败'))
  }
  finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="admin-home space-y-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p class="text-xs text-gray-500 dark:text-gray-400">
          租户、激活码和服务状态概览。游戏功能放在下方“游戏控制台”中。
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <BaseButton variant="primary" size="sm" to="/admin/tenants?tab=codes&issue=new">
          <span class="i-carbon-add" />
          生成激活码
        </BaseButton>
        <BaseButton variant="secondary" size="sm" :loading="loading" @click="load">
          刷新
        </BaseButton>
      </div>
    </div>

    <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
      <div v-for="card in cards" :key="card.label" class="stat-card farm-card rounded-xl p-4">
        <div class="flex items-start justify-between gap-2">
          <div>
            <div class="text-xs text-gray-500 dark:text-gray-400">
              {{ card.label }}
            </div>
            <div class="mt-1 text-2xl text-gray-900 font-bold dark:text-gray-100">
              {{ card.value }}
            </div>
            <div class="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
              {{ card.hint }}
            </div>
          </div>
          <span class="stat-card__icon" :class="card.icon" />
        </div>
      </div>
    </div>

    <div class="grid grid-cols-1 items-start gap-4 xl:grid-cols-[1.15fr_0.85fr]">
      <section class="farm-card rounded-xl p-4">
        <div class="flex items-center justify-between gap-2">
          <h2 class="text-base text-gray-900 font-bold dark:text-gray-100">
            需要处理
          </h2>
          <span class="text-xs text-gray-500">{{ alerts.length }} 项</span>
        </div>
        <div v-if="alerts.length" class="mt-3 space-y-2">
          <div v-for="alert in alerts" :key="alert.key" class="alert-row" :class="`alert-row--${alert.tone}`">
            <span class="alert-row__dot" />
            <span class="min-w-0 flex-1 text-sm">{{ alert.text }}</span>
            <BaseButton variant="text" size="sm" :to="alert.to">
              {{ alert.action }}
            </BaseButton>
          </div>
        </div>
        <div v-else class="mt-3 border rounded-lg border-dashed p-6 text-center text-sm text-gray-500 dark:border-gray-700">
          当前没有需要处理的提醒
        </div>
      </section>

      <section class="farm-card rounded-xl p-4">
        <div class="flex items-center justify-between gap-2">
          <h2 class="text-base text-gray-900 font-bold dark:text-gray-100">
            快捷操作
          </h2>
        </div>
        <div class="grid grid-cols-2 mt-3 gap-2">
          <BaseButton variant="secondary" size="sm" to="/admin/tenants">
            用户列表
          </BaseButton>
          <BaseButton variant="secondary" size="sm" to="/admin/appearance">
            外观设置
          </BaseButton>
          <BaseButton variant="secondary" size="sm" to="/settings">
            系统设置
          </BaseButton>
          <BaseButton variant="secondary" size="sm" to="/admin/tenants?tab=codes">
            激活码管理
          </BaseButton>
          <BaseButton variant="secondary" size="sm" to="/admin/tenants?tab=audit">
            管理员操作记录
          </BaseButton>
        </div>
        <div class="mt-4 flex items-center gap-3 rounded-lg p-3" style="background: var(--ui-surface-soft);">
          <span class="brand-dot" :style="{ background: appStore.brandColor }" />
          <div class="min-w-0 flex-1">
            <div class="text-xs text-gray-500">
              当前品牌色
            </div>
            <div class="text-sm font-medium">
              {{ appStore.brandColor }}
            </div>
          </div>
          <BaseButton variant="text" size="sm" to="/admin/appearance">
            调整
          </BaseButton>
        </div>
      </section>
    </div>

    <section class="overflow-hidden farm-card rounded-xl">
      <div class="flex items-center justify-between gap-2 border-b border-gray-200/60 px-4 py-3 dark:border-gray-700/60">
        <div>
          <h2 class="text-base text-gray-900 font-bold dark:text-gray-100">
            租户概览
          </h2>
          <p class="mt-0.5 text-xs text-gray-500">
            按创建时间倒序显示最近租户
          </p>
        </div>
        <BaseButton variant="text" size="sm" to="/admin/tenants">
          全部用户
        </BaseButton>
      </div>
      <div class="overflow-x-auto">
        <table class="admin-table">
          <thead>
            <tr>
              <th>用户名</th>
              <th>状态</th>
              <th>到期</th>
              <th>剩余</th>
              <th>账号</th>
              <th>最近登录</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="tenant in tenants.slice(0, 8)" :key="tenant.id">
              <td class="font-medium">
                <RouterLink class="text-[var(--ui-primary)]" :to="{ path: '/admin/tenants', query: { manage: tenant.id } }">
                  {{ tenant.username }}
                </RouterLink>
              </td>
              <td><span class="status-pill" :class="tenantStatus(tenant).className">{{ tenantStatus(tenant).label }}</span></td>
              <td class="whitespace-nowrap text-xs">
                {{ formatDate(tenant.expiresAt) }}
              </td>
              <td class="whitespace-nowrap text-xs">
                {{ remainingDays(tenant.expiresAt) }}
              </td>
              <td class="whitespace-nowrap text-xs">
                {{ tenant.accountCount }} / {{ tenant.maxAccounts }}
              </td>
              <td class="whitespace-nowrap text-xs">
                {{ formatDate(tenant.lastLoginAt) }}
              </td>
            </tr>
            <tr v-if="!tenants.length">
              <td colspan="6" class="py-10 text-center text-sm text-gray-500">
                还没有租户，先生成一个激活码吧。
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="farm-card rounded-xl p-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 class="text-base text-gray-900 font-bold dark:text-gray-100">
            游戏控制台
          </h2>
          <p class="mt-0.5 text-xs text-gray-500">
            管理员也需要查看游戏时使用，日常管理不需要进入这里。
          </p>
        </div>
        <div class="flex flex-wrap gap-2">
          <BaseButton variant="secondary" size="sm" to="/">
            进入农场
          </BaseButton>
          <BaseButton variant="secondary" size="sm" to="/ranch">
            进入牧场
          </BaseButton>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.admin-home {
  max-width: 1480px;
  margin-inline: auto;
}

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

.brand-dot {
  width: 26px;
  height: 26px;
  flex: none;
  border-radius: 9px;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.08);
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
