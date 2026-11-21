<script setup lang="ts">
import { NDrawer, NDrawerContent } from 'naive-ui/es/drawer'
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api, { getApiErrorMessage } from '@/api'
import AdminCodes from '@/components/admin/AdminCodes.vue'
import ConfirmModal from '@/components/ConfirmModal.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import { useToastStore } from '@/stores/toast'

interface Tenant {
  id: string
  username: string
  status: 'active' | 'disabled'
  expiresAt: number | null
  maxAccounts: number
  accountCount: number
  runningCount: number
  note?: string
  lastLoginAt?: number | null
}

type TenantAction = 'extend' | 'quota' | 'password' | 'delete' | 'kick' | 'status'
const actionLabels: Record<Exclude<TenantAction, 'status'>, string> = {
  extend: '延长有效期',
  quota: '调整账号配额',
  password: '重置密码',
  delete: '删除租户',
  kick: '强制下线',
}

const toast = useToastStore()
const route = useRoute()
const router = useRouter()
const activeTab = computed(() => route.query.tab === 'codes' ? 'codes' : 'tenants')
const loading = ref(false)
const tenants = ref<Tenant[]>([])
const stats = ref({ total: 0, unused: 0, redeemed: 0, batchCount: 0 })
const selectedTenant = ref('')
const managed = computed(() => tenants.value.find(tenant => tenant.id === selectedTenant.value))
let loadSequence = 0

const tenantModal = ref({
  mode: '' as TenantAction | '',
  tenant: null as Tenant | null,
  days: 30 as number | string,
  maxAccounts: 3 as number | string,
  password: '',
  confirm: '',
  loading: false,
})
const modalTitle = computed(() => {
  const { mode, tenant } = tenantModal.value
  if (mode === 'status')
    return tenant?.status === 'active' ? '停用租户' : '恢复租户'
  return mode ? actionLabels[mode] : ''
})
const modalMessage = computed(() => {
  const { mode, tenant } = tenantModal.value
  if (!tenant)
    return ''
  if (mode === 'delete')
    return `将删除 ${tenant.username} 及其名下所有账号。请输入完整用户名确认。`
  if (mode === 'kick')
    return `${tenant.username} 的登录会话将失效，后台挂机照常运行。`
  if (mode === 'status') {
    return tenant.status === 'active'
      ? `停用后，${tenant.username} 将无法登录，名下的挂机账号会停止。`
      : `恢复 ${tenant.username} 的登录权限。账号有效期以当前设置为准。`
  }
  return `当前租户 ${tenant.username}`
})

const summary = computed(() => {
  const activeTenantCount = tenants.value.filter(tenant => tenant.status === 'active' && (!tenant.expiresAt || tenant.expiresAt > Date.now())).length
  const totalAccounts = tenants.value.reduce((sum, tenant) => sum + tenant.accountCount, 0)
  const runningAccounts = tenants.value.reduce((sum, tenant) => sum + tenant.runningCount, 0)
  return [
    { label: '租户', value: tenants.value.length, detail: `有效 ${activeTenantCount}`, icon: 'i-carbon-user-multiple' },
    { label: '游戏账号', value: totalAccounts, detail: `运行中 ${runningAccounts}`, icon: 'i-carbon-game-console' },
    { label: '激活码', value: stats.value.total, detail: `待兑换\u00A0${stats.value.unused} · 已兑换\u00A0${stats.value.redeemed}`, icon: 'i-carbon-ticket' },
    { label: '生成批次', value: stats.value.batchCount, detail: '', icon: 'i-carbon-catalog' },
  ]
})

function formatDate(value: number | null | undefined) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'
}

function tenantStatus(tenant: Tenant) {
  if (tenant.status === 'disabled')
    return { label: '已停用', tone: 'disabled' }
  if (tenant.expiresAt && tenant.expiresAt <= Date.now())
    return { label: '已到期', tone: 'expired' }
  return { label: '正常', tone: 'active' }
}

async function loadOverview() {
  const sequence = ++loadSequence
  loading.value = true
  try {
    const { data } = await api.get('/api/admin/overview', { skipErrorToast: true } as any)
    if (!data?.ok)
      throw new Error(getApiErrorMessage(data, '管理员概览加载失败'))
    if (sequence === loadSequence) {
      tenants.value = data.data.tenants || []
      stats.value = data.data.codes
    }
  }
  catch (error) {
    if (sequence === loadSequence)
      toast.error(getApiErrorMessage(error, '加载失败'))
  }
  finally {
    if (sequence === loadSequence)
      loading.value = false
  }
}

function goToTenantCodes(tenant: Tenant, renew = false) {
  selectedTenant.value = ''
  void router.push({ query: { tab: 'codes', tenant: tenant.id, ...(renew ? { issue: 'renew', target: tenant.id } : {}) } })
}

function openTenantModal(tenant: Tenant, mode: TenantAction) {
  tenantModal.value = { mode, tenant, days: 30, maxAccounts: tenant.maxAccounts, password: '', confirm: '', loading: false }
}

async function submitTenantAction() {
  const modal = tenantModal.value
  const { tenant, mode } = modal
  if (!tenant || !mode || modal.loading)
    return
  if ((mode === 'extend' && !Number(modal.days)) || (mode === 'quota' && !Number(modal.maxAccounts))) {
    toast.error('请输入有效的数字')
    return
  }
  if (mode === 'delete' && modal.confirm !== tenant.username) {
    toast.error('请输入完整用户名确认删除')
    return
  }

  modal.loading = true
  try {
    const path = `/api/admin/tenants/${tenant.id}`
    const payloads = {
      extend: { days: Number(modal.days) },
      quota: { maxAccounts: Number(modal.maxAccounts) },
      password: { password: modal.password },
      status: { status: tenant.status === 'active' ? 'disabled' : 'active' },
      kick: undefined,
    }
    const config = { skipErrorToast: true } as any
    const { data } = mode === 'delete'
      ? await api.delete(path, { ...config, data: { confirm: modal.confirm } })
      : await api.post(`${path}/${mode}`, payloads[mode], config)
    if (!data?.ok)
      throw new Error(getApiErrorMessage(data, '操作失败'))
    const label = modalTitle.value
    if (mode === 'delete')
      selectedTenant.value = ''
    if (mode !== 'delete' && mode !== 'kick')
      tenants.value = tenants.value.map(other => other.id === tenant.id ? { ...other, ...data.data } : other)
    modal.mode = ''
    modal.password = ''
    toast.success(`${label}成功`)
    await loadOverview()
  }
  catch (error) {
    toast.error(getApiErrorMessage(error, '操作失败'))
  }
  finally {
    modal.loading = false
  }
}

onMounted(loadOverview)
</script>

<template>
  <div class="admin-page space-y-4">
    <div class="summary-grid">
      <div v-for="item in summary" :key="item.label" class="summary-card farm-card rounded-xl">
        <div>
          <div class="muted text-xs">
            {{ item.label }}
          </div>
          <div class="mt-1 text-2xl font-semibold">
            {{ item.value }}
          </div>
          <div v-if="item.detail" class="muted mt-1 text-xs">
            {{ item.detail }}
          </div>
        </div>
        <span class="summary-icon" :class="item.icon" aria-hidden="true" />
      </div>
    </div>

    <nav class="admin-tabs" aria-label="用户与激活码">
      <RouterLink :to="{ query: {} }" class="tab-btn" :class="{ 'tab-btn--active': activeTab === 'tenants' }" :aria-current="activeTab === 'tenants' ? 'page' : undefined">
        租户列表
      </RouterLink>
      <RouterLink :to="{ query: { tab: 'codes' } }" class="tab-btn" :class="{ 'tab-btn--active': activeTab === 'codes' }" :aria-current="activeTab === 'codes' ? 'page' : undefined">
        激活码
      </RouterLink>
    </nav>

    <AdminCodes v-if="activeTab === 'codes'" :tenants="tenants" @manage-tenant="selectedTenant = $event" @changed="loadOverview" />
    <section v-else class="farm-card rounded-xl" aria-labelledby="tenants-title">
      <div class="flex items-center justify-between gap-3 p-4">
        <h2 id="tenants-title" class="font-semibold">
          租户列表
        </h2>
        <BaseButton variant="secondary" size="sm" :loading="loading" @click="loadOverview">
          刷新
        </BaseButton>
      </div>
      <ul v-if="tenants.length" class="m-0 list-none p-0">
        <li v-for="tenant in tenants" :key="tenant.id" class="tenant-row">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <button type="button" class="tenant-link break-all font-semibold" @click="selectedTenant = tenant.id">
                {{ tenant.username }}
              </button>
              <span class="tenant-status" :data-tone="tenantStatus(tenant).tone">{{ tenantStatus(tenant).label }}</span>
            </div>
            <p v-if="tenant.note" class="muted mt-1 break-words text-xs">
              {{ tenant.note }}
            </p>
          </div>
          <div>
            <div>{{ formatDate(tenant.expiresAt) }}</div>
            <div class="muted text-xs">
              到期时间
            </div>
          </div>
          <div>
            <div>{{ tenant.accountCount }} / {{ tenant.maxAccounts }}</div>
            <div class="muted text-xs">
              游戏账号 / 配额
            </div>
          </div>
          <BaseButton variant="secondary" size="sm" class="tenant-action" :aria-label="`管理租户 ${tenant.username}`" @click="selectedTenant = tenant.id">
            管理
          </BaseButton>
        </li>
      </ul>
      <p v-else class="muted border-t p-7 text-center text-sm">
        {{ loading ? '正在读取租户…' : '暂无租户。可到激活码页面生成新用户码。' }}
      </p>
    </section>

    <NDrawer :show="!!managed" width="min(500px, 100vw)" placement="right" @update:show="value => !value && (selectedTenant = '')">
      <NDrawerContent title="租户管理" closable>
        <div v-if="managed" class="space-y-5">
          <div class="tenant-profile">
            <div class="flex flex-wrap items-center gap-3">
              <h2 class="break-all text-lg font-semibold">
                {{ managed.username }}
              </h2>
              <span class="tenant-status" :data-tone="tenantStatus(managed).tone">{{ tenantStatus(managed).label }}</span>
            </div>
            <p v-if="managed.note" class="muted mt-2 break-words text-sm">
              {{ managed.note }}
            </p>
            <dl class="grid grid-cols-2 mt-4 gap-3 text-sm">
              <div>
                <dt class="muted text-xs">
                  到期时间
                </dt><dd class="m-0">
                  {{ formatDate(managed.expiresAt) }}
                </dd>
              </div>
              <div>
                <dt class="muted text-xs">
                  最近登录
                </dt><dd class="m-0">
                  {{ formatDate(managed.lastLoginAt) }}
                </dd>
              </div>
              <div>
                <dt class="muted text-xs">
                  游戏账号 / 配额
                </dt><dd class="m-0">
                  {{ managed.accountCount }} / {{ managed.maxAccounts }}
                </dd>
              </div>
              <div>
                <dt class="muted text-xs">
                  正在挂机
                </dt><dd class="m-0">
                  {{ managed.runningCount }}
                </dd>
              </div>
            </dl>
          </div>

          <section class="space-y-2">
            <h3 class="text-sm font-semibold">
              激活码与续费
            </h3>
            <div class="flex flex-wrap gap-2">
              <BaseButton variant="primary" size="sm" @click="goToTenantCodes(managed, true)">
                发放续费码
              </BaseButton>
              <BaseButton variant="secondary" size="sm" @click="goToTenantCodes(managed)">
                查看关联激活码
              </BaseButton>
              <BaseButton variant="secondary" size="sm" @click="openTenantModal(managed, 'extend')">
                延长有效期
              </BaseButton>
            </div>
          </section>

          <section class="space-y-2">
            <h3 class="text-sm font-semibold">
              账号与访问权限
            </h3>
            <div class="flex flex-wrap gap-2">
              <BaseButton variant="secondary" size="sm" @click="openTenantModal(managed, 'quota')">
                调整配额
              </BaseButton>
              <BaseButton variant="secondary" size="sm" @click="openTenantModal(managed, 'password')">
                重置密码
              </BaseButton>
              <BaseButton variant="secondary" size="sm" @click="openTenantModal(managed, 'kick')">
                强制下线
              </BaseButton>
              <BaseButton :variant="managed.status === 'active' ? 'danger' : 'secondary'" size="sm" @click="openTenantModal(managed, 'status')">
                {{ managed.status === 'active' ? '停用租户' : '恢复租户' }}
              </BaseButton>
              <BaseButton variant="text" size="sm" @click="openTenantModal(managed, 'delete')">
                删除租户
              </BaseButton>
            </div>
          </section>
        </div>
      </NDrawerContent>
    </NDrawer>

    <ConfirmModal
      :show="!!tenantModal.mode"
      :title="modalTitle"
      :message="modalMessage"
      :confirm-text="tenantModal.mode === 'delete' ? '确认删除' : '确认'"
      :type="tenantModal.mode === 'delete' || tenantModal.mode === 'kick' || (tenantModal.mode === 'status' && tenantModal.tenant?.status === 'active') ? 'danger' : 'primary'"
      :loading="tenantModal.loading"
      @confirm="submitTenantAction"
      @cancel="tenantModal.mode = ''; tenantModal.password = ''"
    >
      <div v-if="tenantModal.mode === 'extend'" class="mt-3">
        <BaseInput v-model="tenantModal.days" label="延长天数" type="number" :min="1" :max="3650" />
      </div>
      <div v-else-if="tenantModal.mode === 'quota'" class="mt-3">
        <BaseInput v-model="tenantModal.maxAccounts" label="账号配额" type="number" :min="1" :max="100" />
      </div>
      <div v-else-if="tenantModal.mode === 'password'" class="mt-3">
        <BaseInput v-model="tenantModal.password" label="新密码" type="password" autocomplete="new-password" />
      </div>
      <div v-else-if="tenantModal.mode === 'delete'" class="mt-3">
        <BaseInput v-model="tenantModal.confirm" label="确认用户名" :placeholder="tenantModal.tenant?.username" />
      </div>
    </ConfirmModal>
  </div>
</template>

<style scoped>
.admin-page {
  width: 100%;
  max-width: 1480px;
  margin-inline: auto;
  color: var(--ui-ink);
}
.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.summary-card {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 14px;
}
.summary-icon {
  color: var(--ui-primary);
  font-size: 20px;
}
.muted {
  color: var(--ui-muted);
}
.admin-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.tab-btn {
  padding: 7px 14px;
  border: 1px solid var(--ui-border);
  border-radius: 9px;
  color: var(--ui-muted);
  font-size: 13px;
}
.tab-btn--active {
  border-color: var(--ui-primary);
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
}
.tenant-row {
  display: grid;
  grid-template-columns: minmax(130px, 1.4fr) minmax(125px, 1fr) minmax(105px, 0.8fr) auto;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-top: 1px solid var(--ui-border);
  font-size: 13px;
}
.tenant-link {
  color: var(--ui-primary);
  text-align: left;
  text-underline-offset: 3px;
}
.tenant-link:hover {
  text-decoration: underline;
}
.tenant-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border-radius: 99px;
  background: var(--ui-surface-soft);
  padding: 3px 7px;
  font-size: 11px;
  white-space: nowrap;
}
.tenant-status::before {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #2f9e6e;
  content: '';
}
.tenant-status[data-tone='disabled']::before {
  background: var(--ui-danger);
}
.tenant-status[data-tone='expired']::before {
  background: var(--ui-warning);
}
.tenant-action {
  justify-self: end;
}
.tenant-profile {
  padding: 14px;
  border: 1px solid var(--ui-border);
  border-radius: 12px;
  background: var(--ui-surface-soft);
}
@media (max-width: 760px) {
  .summary-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .tenant-row {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .tenant-action {
    grid-column: 2;
    grid-row: 1;
  }
}
@media (max-width: 480px) {
  .summary-card {
    padding: 10px;
  }
}
</style>
