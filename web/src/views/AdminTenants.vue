<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import ConfirmModal from '@/components/ConfirmModal.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import { useToastStore } from '@/stores/toast'

interface Tenant {
  id: string
  username: string
  status: 'active' | 'disabled'
  createdAt: number
  expiresAt: number | null
  maxAccounts: number
  accountCount: number
  runningCount: number
  note?: string
  lastLoginAt?: number | null
}

interface CodeRecord {
  id: string
  codeHint: string
  type: 'new' | 'renew'
  days: number
  maxAccounts: number
  redeemBefore: number | null
  createdAt: number
  batchId: string
  note: string
  status: 'unused' | 'redeemed' | 'revoked' | 'expired'
  redeemedAt: number | null
  redeemedBy: string | null
}

interface GeneratedCode {
  code: string
  codeHint: string
  type: 'new' | 'renew'
  days: number
  maxAccounts: number
}

const toast = useToastStore()
const activeTab = ref<'tenants' | 'codes'>('tenants')
const loading = ref(false)
const tenants = ref<Tenant[]>([])
const codes = ref<CodeRecord[]>([])
const stats = ref<any>({})
const codeFilterStatus = ref('')
const codeFilterType = ref('')

const codeForm = ref({
  count: 10,
  days: 30,
  type: 'new',
  maxAccounts: 3,
  redeemBefore: '',
  note: '',
})
const generating = ref(false)
const generatedCodes = ref<GeneratedCode[]>([])
const generatedBatchId = ref('')

const tenantModal = ref({
  show: false,
  mode: 'extend' as 'extend' | 'quota' | 'password' | 'delete',
  tenant: null as Tenant | null,
  days: 30,
  maxAccounts: 3,
  password: '',
  confirm: '',
  loading: false,
})

const statusOptions = [
  { label: '全部状态', value: '' },
  { label: '未使用', value: 'unused' },
  { label: '已兑换', value: 'redeemed' },
  { label: '已吊销', value: 'revoked' },
  { label: '已过期', value: 'expired' },
]
const typeOptions = [
  { label: '全部类型', value: '' },
  { label: '新用户激活码', value: 'new' },
  { label: '续费码', value: 'renew' },
]
const codeTypeOptions = [
  { label: '新用户激活码', value: 'new' },
  { label: '续费码', value: 'renew' },
]

const generatedText = computed(() => generatedCodes.value.map(item => item.code).join('\n'))
const activeTenantCount = computed(() => tenants.value.filter(tenant => tenant.status === 'active' && (!tenant.expiresAt || tenant.expiresAt > Date.now())).length)

function formatDate(value: number | null | undefined): string {
  if (!value)
    return '—'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function remainingDays(value: number | null | undefined): string {
  if (!value)
    return '永久'
  const days = Math.ceil((value - Date.now()) / 86_400_000)
  return days > 0 ? `${days} 天` : '已到期'
}

function tenantStatus(tenant: Tenant): { label: string, className: string } {
  if (tenant.status === 'disabled')
    return { label: '已停用', className: 'status-disabled' }
  if (tenant.expiresAt && tenant.expiresAt <= Date.now())
    return { label: '已到期', className: 'status-expired' }
  return { label: '正常', className: 'status-active' }
}

function codeStatus(code: CodeRecord): { label: string, className: string } {
  if (code.status === 'redeemed')
    return { label: '已兑换', className: 'status-active' }
  if (code.status === 'revoked')
    return { label: '已吊销', className: 'status-disabled' }
  if (code.status === 'expired')
    return { label: '已过期', className: 'status-expired' }
  return { label: '未使用', className: 'status-unused' }
}

async function loadOverview() {
  const { data } = await api.get('/api/admin/overview')
  if (data?.ok) {
    tenants.value = data.data.tenants || []
    stats.value = data.data.codes || {}
  }
}

async function loadCodes() {
  const params: Record<string, string> = {}
  if (codeFilterStatus.value)
    params.status = codeFilterStatus.value
  if (codeFilterType.value)
    params.type = codeFilterType.value
  const { data } = await api.get('/api/admin/codes', { params })
  if (data?.ok)
    codes.value = data.data || []
}

async function reload() {
  loading.value = true
  try {
    await Promise.all([loadOverview(), loadCodes()])
  }
  catch (error: any) {
    toast.error(getApiErrorMessage(error, '加载失败'))
  }
  finally {
    loading.value = false
  }
}

function parseRedeemBefore(): number | null {
  const raw = codeForm.value.redeemBefore.trim()
  if (!raw)
    return null
  const value = new Date(raw.replace(' ', 'T')).getTime()
  return Number.isFinite(value) ? value : null
}

async function handleGenerate() {
  generating.value = true
  try {
    const { data } = await api.post('/api/admin/codes', {
      count: Number(codeForm.value.count) || 1,
      days: Number(codeForm.value.days) || 30,
      type: codeForm.value.type,
      maxAccounts: Number(codeForm.value.maxAccounts) || 3,
      redeemBefore: parseRedeemBefore(),
      note: codeForm.value.note,
    })
    if (!data?.ok) {
      toast.error(getApiErrorMessage(data, '生成失败'))
      return
    }
    generatedCodes.value = data.data.codes || []
    generatedBatchId.value = data.data.batchId || ''
    toast.success(`已生成 ${generatedCodes.value.length} 个激活码`)
    await Promise.all([loadCodes(), loadOverview()])
  }
  catch (error: any) {
    toast.error(getApiErrorMessage(error, '生成失败'))
  }
  finally {
    generating.value = false
  }
}

async function copyGenerated() {
  if (!generatedText.value)
    return
  try {
    await navigator.clipboard.writeText(generatedText.value)
    toast.success('已复制全部激活码')
  }
  catch {
    toast.error('复制失败，请手动选择')
  }
}

function downloadGenerated() {
  if (!generatedCodes.value.length)
    return
  const lines = ['激活码,类型,天数,账号配额']
  for (const item of generatedCodes.value)
    lines.push(`${item.code},${item.type === 'renew' ? '续费码' : '新用户激活码'},${item.days},${item.maxAccounts}`)
  const blob = new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `activation-codes-${generatedBatchId.value || Date.now()}.csv`
  link.click()
  URL.revokeObjectURL(url)
}

function openTenantModal(tenant: Tenant, mode: 'extend' | 'quota' | 'password' | 'delete') {
  tenantModal.value = {
    show: true,
    mode,
    tenant,
    days: 30,
    maxAccounts: tenant.maxAccounts,
    password: '',
    confirm: '',
    loading: false,
  }
}

async function submitTenantAction() {
  const modal = tenantModal.value
  const tenant = modal.tenant
  if (!tenant)
    return
  modal.loading = true
  try {
    if (modal.mode === 'extend') {
      const { data } = await api.post(`/api/admin/tenants/${tenant.id}/extend`, { days: Number(modal.days) || 1 })
      if (data?.ok) {
        toast.success(`已为 ${tenant.username} 延期 ${modal.days} 天`)
        modal.show = false
      }
      else {
        toast.error(getApiErrorMessage(data, '延期失败'))
      }
    }
    else if (modal.mode === 'quota') {
      const { data } = await api.post(`/api/admin/tenants/${tenant.id}/quota`, { maxAccounts: Number(modal.maxAccounts) || 1 })
      if (data?.ok) {
        toast.success(`已将 ${tenant.username} 的账号配额设为 ${modal.maxAccounts}`)
        modal.show = false
      }
      else {
        toast.error(getApiErrorMessage(data, '配额修改失败'))
      }
    }
    else if (modal.mode === 'password') {
      const { data } = await api.post(`/api/admin/tenants/${tenant.id}/password`, { password: modal.password })
      if (data?.ok) {
        toast.success(`已重置 ${tenant.username} 的密码`)
        modal.show = false
      }
      else {
        toast.error(getApiErrorMessage(data, '重置失败'))
      }
    }
    else {
      const { data } = await api.delete(`/api/admin/tenants/${tenant.id}`, { data: { confirm: modal.confirm } })
      if (data?.ok) {
        toast.success(`已删除 ${tenant.username} 及其账号`)
        modal.show = false
      }
      else {
        toast.error(getApiErrorMessage(data, '删除失败'))
      }
    }
    await reload()
  }
  catch (error: any) {
    toast.error(getApiErrorMessage(error, '操作失败'))
  }
  finally {
    modal.loading = false
  }
}

async function toggleTenantStatus(tenant: Tenant) {
  const next = tenant.status === 'active' ? 'disabled' : 'active'
  try {
    const { data } = await api.post(`/api/admin/tenants/${tenant.id}/status`, { status: next })
    if (data?.ok) {
      toast.success(next === 'disabled' ? '已停用并停止挂机' : '已恢复租户')
      await reload()
    }
    else {
      toast.error(getApiErrorMessage(data, '操作失败'))
    }
  }
  catch (error: any) {
    toast.error(getApiErrorMessage(error, '操作失败'))
  }
}

async function kickTenant(tenant: Tenant) {
  try {
    const { data } = await api.post(`/api/admin/tenants/${tenant.id}/kick`)
    if (data?.ok) {
      toast.success(`已强制 ${tenant.username} 下线`)
      await reload()
    }
  }
  catch (error: any) {
    toast.error(getApiErrorMessage(error, '操作失败'))
  }
}

async function revokeCode(code: CodeRecord) {
  try {
    const { data } = await api.post(`/api/admin/codes/${code.id}/revoke`)
    if (data?.ok) {
      toast.success('激活码已吊销')
      await Promise.all([loadCodes(), loadOverview()])
    }
    else {
      toast.error(getApiErrorMessage(data, '吊销失败'))
    }
  }
  catch (error: any) {
    toast.error(getApiErrorMessage(error, '吊销失败'))
  }
}

onMounted(reload)
</script>

<template>
  <div class="admin-page space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 class="text-lg text-gray-900 font-bold dark:text-gray-100">
          用户与激活码
        </h2>
        <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
          管理租户有效期、账号配额和卡密批次。激活码只在生成时展示一次。
        </p>
      </div>
      <BaseButton variant="secondary" size="sm" :loading="loading" @click="reload">
        <span class="i-carbon-renew" />
        刷新
      </BaseButton>
    </div>

    <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <div class="farm-card rounded-lg p-4">
        <div class="text-xs text-gray-500 dark:text-gray-400">
          租户总数
        </div>
        <div class="mt-1 text-2xl text-gray-900 font-bold dark:text-gray-100">
          {{ tenants.length }}
        </div>
        <div class="mt-1 text-xs text-emerald-600 dark:text-emerald-400">
          有效 {{ activeTenantCount }}
        </div>
      </div>
      <div class="farm-card rounded-lg p-4">
        <div class="text-xs text-gray-500 dark:text-gray-400">
          租户账号
        </div>
        <div class="mt-1 text-2xl text-gray-900 font-bold dark:text-gray-100">
          {{ tenants.reduce((sum, tenant) => sum + tenant.accountCount, 0) }}
        </div>
        <div class="mt-1 text-xs text-gray-500 dark:text-gray-400">
          运行中 {{ tenants.reduce((sum, tenant) => sum + tenant.runningCount, 0) }}
        </div>
      </div>
      <div class="farm-card rounded-lg p-4">
        <div class="text-xs text-gray-500 dark:text-gray-400">
          激活码
        </div>
        <div class="mt-1 text-2xl text-gray-900 font-bold dark:text-gray-100">
          {{ stats.total || 0 }}
        </div>
        <div class="mt-1 text-xs text-gray-500 dark:text-gray-400">
          未使用 {{ stats.unused || 0 }} · 已兑换 {{ stats.redeemed || 0 }}
        </div>
      </div>
      <div class="farm-card rounded-lg p-4">
        <div class="text-xs text-gray-500 dark:text-gray-400">
          批次
        </div>
        <div class="mt-1 text-2xl text-gray-900 font-bold dark:text-gray-100">
          {{ stats.batchCount || 0 }}
        </div>
        <div class="mt-1 text-xs text-gray-500 dark:text-gray-400">
          新开 {{ stats.newCodes || 0 }} · 续费 {{ stats.renewCodes || 0 }}
        </div>
      </div>
    </div>

    <div class="flex gap-2">
      <button
        type="button"
        class="tab-btn"
        :class="{ 'tab-btn--active': activeTab === 'tenants' }"
        @click="activeTab = 'tenants'"
      >
        租户列表
      </button>
      <button
        type="button"
        class="tab-btn"
        :class="{ 'tab-btn--active': activeTab === 'codes' }"
        @click="activeTab = 'codes'"
      >
        激活码
      </button>
    </div>

    <template v-if="activeTab === 'tenants'">
      <div class="overflow-hidden farm-card rounded-lg">
        <div class="overflow-x-auto">
          <table class="data-table">
            <thead>
              <tr>
                <th>用户名</th>
                <th>状态</th>
                <th>到期时间</th>
                <th>剩余</th>
                <th>账号 / 配额</th>
                <th>最近登录</th>
                <th class="text-right">
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="tenant in tenants" :key="tenant.id">
                <td>
                  <div class="font-medium">
                    {{ tenant.username }}
                  </div>
                  <div v-if="tenant.note" class="text-xs text-gray-500">
                    {{ tenant.note }}
                  </div>
                </td>
                <td>
                  <span class="status-pill" :class="tenantStatus(tenant).className">{{ tenantStatus(tenant).label }}</span>
                </td>
                <td class="whitespace-nowrap">
                  {{ formatDate(tenant.expiresAt) }}
                </td>
                <td class="whitespace-nowrap">
                  {{ remainingDays(tenant.expiresAt) }}
                </td>
                <td class="whitespace-nowrap">
                  {{ tenant.accountCount }} / {{ tenant.maxAccounts }}
                  <span v-if="tenant.runningCount" class="ml-1 text-xs text-emerald-600 dark:text-emerald-400">(运行 {{ tenant.runningCount }})</span>
                </td>
                <td class="whitespace-nowrap text-xs">
                  {{ formatDate(tenant.lastLoginAt) }}
                </td>
                <td>
                  <div class="flex flex-wrap justify-end gap-1.5">
                    <BaseButton variant="secondary" size="sm" @click="openTenantModal(tenant, 'extend')">
                      延期
                    </BaseButton>
                    <BaseButton variant="secondary" size="sm" @click="openTenantModal(tenant, 'password')">
                      改密
                    </BaseButton>
                    <BaseButton variant="secondary" size="sm" @click="kickTenant(tenant)">
                      踢下线
                    </BaseButton>
                    <BaseButton
                      :variant="tenant.status === 'active' ? 'danger' : 'success'"
                      size="sm"
                      @click="toggleTenantStatus(tenant)"
                    >
                      {{ tenant.status === 'active' ? '停用' : '恢复' }}
                    </BaseButton>
                    <BaseButton variant="text" size="sm" @click="openTenantModal(tenant, 'delete')">
                      删除
                    </BaseButton>
                  </div>
                </td>
              </tr>
              <tr v-if="!tenants.length">
                <td colspan="7" class="empty-cell">
                  暂无租户。先在激活码页生成新用户激活码。
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <template v-else>
      <div class="farm-card rounded-lg p-4">
        <div class="flex items-center justify-between gap-3">
          <div>
            <h3 class="text-base text-gray-900 font-bold dark:text-gray-100">
              生成激活码
            </h3>
            <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              新用户码用于注册，续费码用于给已有租户延期。
            </p>
          </div>
        </div>
        <div class="grid grid-cols-1 mt-4 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <BaseSelect v-model="codeForm.type" label="类型" :options="codeTypeOptions" />
          <BaseInput v-model="codeForm.count" label="数量" type="number" :min="1" :max="100" />
          <BaseInput v-model="codeForm.days" label="有效天数" type="number" :min="1" :max="3650" />
          <BaseInput v-model="codeForm.maxAccounts" label="账号配额" type="number" :min="1" :max="100" />
          <BaseInput v-model="codeForm.redeemBefore" label="兑换截止（可选）" type="text" placeholder="2026-12-31 23:59" />
          <BaseInput v-model="codeForm.note" label="备注（可选）" type="text" placeholder="例如：老用户续费批次" />
        </div>
        <div class="mt-4 flex justify-end">
          <BaseButton variant="primary" size="sm" :loading="generating" @click="handleGenerate">
            <span class="i-carbon-add-alt" />
            生成
          </BaseButton>
        </div>

        <div v-if="generatedCodes.length" class="generated-box mt-4">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="text-sm font-medium">
              本批次 {{ generatedCodes.length }} 个码（只展示这一次）
              <span class="ml-1 text-xs text-gray-500">批次 {{ generatedBatchId }}</span>
            </div>
            <div class="flex gap-2">
              <BaseButton variant="secondary" size="sm" @click="copyGenerated">
                复制全部
              </BaseButton>
              <BaseButton variant="secondary" size="sm" @click="downloadGenerated">
                导出 CSV
              </BaseButton>
            </div>
          </div>
          <pre class="code-list">{{ generatedText }}</pre>
        </div>
      </div>

      <div class="overflow-hidden farm-card rounded-lg">
        <div class="flex flex-wrap items-center gap-2 border-b border-gray-200/60 p-3 dark:border-gray-700/60">
          <BaseSelect v-model="codeFilterStatus" :options="statusOptions" class="w-40" @change="loadCodes" />
          <BaseSelect v-model="codeFilterType" :options="typeOptions" class="w-44" @change="loadCodes" />
          <BaseButton variant="secondary" size="sm" :loading="loading" @click="loadCodes">
            筛选
          </BaseButton>
        </div>
        <div class="overflow-x-auto">
          <table class="data-table">
            <thead>
              <tr>
                <th>末四位</th>
                <th>类型</th>
                <th>天数</th>
                <th>配额</th>
                <th>状态</th>
                <th>生成时间</th>
                <th>兑换人</th>
                <th>批次</th>
                <th class="text-right">
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="code in codes" :key="code.id">
                <td class="font-mono">
                  ••••{{ code.codeHint }}
                </td>
                <td>{{ code.type === 'renew' ? '续费码' : '新用户码' }}</td>
                <td>{{ code.days }}</td>
                <td>{{ code.maxAccounts }}</td>
                <td><span class="status-pill" :class="codeStatus(code).className">{{ codeStatus(code).label }}</span></td>
                <td class="whitespace-nowrap text-xs">
                  {{ formatDate(code.createdAt) }}
                </td>
                <td class="text-xs">
                  {{ code.redeemedBy || '—' }}
                </td>
                <td class="text-xs">
                  {{ code.batchId }}
                </td>
                <td>
                  <div class="flex justify-end">
                    <BaseButton
                      v-if="code.status === 'unused'"
                      variant="text"
                      size="sm"
                      @click="revokeCode(code)"
                    >
                      吊销
                    </BaseButton>
                  </div>
                </td>
              </tr>
              <tr v-if="!codes.length">
                <td colspan="9" class="empty-cell">
                  没有符合条件的激活码。
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <ConfirmModal
      :show="tenantModal.show"
      :title="tenantModal.mode === 'extend' ? '租户延期' : tenantModal.mode === 'quota' ? '账号配额' : tenantModal.mode === 'password' ? '重置密码' : '删除租户'"
      :message="tenantModal.mode === 'delete'
        ? `将删除 ${tenantModal.tenant?.username || ''} 及其名下所有账号，操作不可撤销。请输入用户名确认。`
        : tenantModal.mode === 'quota'
          ? `调整 ${tenantModal.tenant?.username || ''} 可添加的游戏账号数量。`
          : tenantModal.mode === 'password'
            ? `为 ${tenantModal.tenant?.username || ''} 设置新的登录密码。`
            : `为 ${tenantModal.tenant?.username || ''} 延长有效期。`"
      :confirm-text="tenantModal.mode === 'delete' ? '确认删除' : '确认'"
      :type="tenantModal.mode === 'delete' ? 'danger' : 'primary'"
      :loading="tenantModal.loading"
      @confirm="submitTenantAction"
      @cancel="tenantModal.show = false"
    >
      <div v-if="tenantModal.mode === 'extend'" class="mt-3">
        <BaseInput v-model="tenantModal.days" label="延长天数" type="number" :min="1" :max="3650" />
      </div>
      <div v-else-if="tenantModal.mode === 'quota'" class="mt-3">
        <BaseInput v-model="tenantModal.maxAccounts" label="账号配额" type="number" :min="1" :max="100" />
      </div>
      <div v-else-if="tenantModal.mode === 'password'" class="mt-3">
        <BaseInput v-model="tenantModal.password" label="新密码" type="password" placeholder="至少 6 位，包含字母和数字" />
      </div>
      <div v-else class="mt-3">
        <BaseInput v-model="tenantModal.confirm" label="确认用户名" type="text" :placeholder="tenantModal.tenant?.username || ''" />
      </div>
    </ConfirmModal>
  </div>
</template>

<style scoped>
.admin-page {
  max-width: 1580px;
  margin-inline: auto;
}

.tab-btn {
  padding: 7px 14px;
  border: 1px solid var(--ui-border);
  border-radius: 9px;
  color: var(--ui-muted);
  background: transparent;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.16s ease;
}

.tab-btn--active {
  border-color: var(--ui-primary);
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.data-table th {
  padding: 10px 12px;
  border-bottom: 1px solid var(--ui-border);
  color: var(--ui-muted);
  font-size: 11px;
  font-weight: var(--fw-600);
  text-align: left;
  white-space: nowrap;
}

.data-table td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--ui-border);
  color: var(--ui-ink);
  vertical-align: middle;
}

.data-table tbody tr:last-child td {
  border-bottom: 0;
}

.data-table tbody tr:hover {
  background: var(--ui-surface-soft);
}

.empty-cell {
  padding: 28px 12px !important;
  color: var(--ui-muted) !important;
  text-align: center;
}

.status-pill {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: var(--fw-600);
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

.status-unused {
  color: #40536b;
  background: rgba(98, 124, 158, 0.13);
}

.generated-box {
  padding: 14px;
  border: 1px solid rgba(67, 141, 99, 0.2);
  border-radius: 10px;
  background: var(--ui-primary-soft);
}

.code-list {
  max-height: 220px;
  margin: 10px 0 0;
  padding: 10px;
  border-radius: 8px;
  overflow: auto;
  color: var(--ui-ink);
  background: var(--ui-surface-strong);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.7;
}
</style>
