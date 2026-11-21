<script setup lang="ts">
import { NDrawer, NDrawerContent } from 'naive-ui/es/drawer'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api, { getApiErrorMessage } from '@/api'
import ConfirmModal from '@/components/ConfirmModal.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import { useToastStore } from '@/stores/toast'

type CodeType = 'new' | 'renew'
type CodeStatus = 'unused' | 'redeemed' | 'expired' | 'revoked'

interface CodeRecord {
  id: string
  codeHint: string
  hasFullCode: boolean
  type: CodeType
  days: number
  maxAccounts: number
  redeemBefore: number | null
  createdAt: number
  batchId: string
  note: string
  status: CodeStatus
  redeemedAt: number | null
  redeemedBy: string | null
  targetTenantId: string | null
  replacesId: string | null
  replacedBy: string | null
}

interface Delivery {
  batchId: string
  codes: { id: string, code: string, type: CodeType, days: number, maxAccounts: number }[]
  unavailable?: number
}

const props = defineProps<{
  tenants: { id: string, username: string, maxAccounts: number }[]
}>()
const emit = defineEmits<{
  changed: []
  manageTenant: [id: string]
}>()

const route = useRoute()
const router = useRouter()
const toast = useToastStore()
const records = ref<CodeRecord[]>([])
const loading = ref(false)
const loadError = ref('')
const search = ref('')
const filterStatus = ref('')
const filterType = ref('')
const visibleCount = ref(25)
const panel = ref<'generate' | 'details' | 'delivery' | ''>('')
const selectedId = ref('')
const delivery = ref<Delivery | null>(null)
const isBatchDelivery = computed(() => delivery.value?.unavailable !== undefined)
const deliveryText = ref<HTMLTextAreaElement | null>(null)
const fullCode = ref('')
const fullCodeInput = ref<HTMLInputElement | null>(null)
const revealing = ref('')
const busy = ref(false)
const formError = ref('')
const confirmation = ref<'revoke' | 'replace' | 'batch' | ''>('')
const confirmationBatch = ref('')
let listSequence = 0
let revealSequence = 0

const statuses = {
  unused: '待兑换',
  redeemed: '已兑换',
  expired: '已过期',
  revoked: '已吊销',
}
const types = { new: '新用户码', renew: '续费码' }
const typeOptions = Object.entries(types).map(([value, label]) => ({ value, label }))
const statusOptions = [{ value: '', label: '全部状态' }, ...Object.entries(statuses).map(([value, label]) => ({ value, label }))]
const tenantOptions = computed(() => [
  { label: '不指定租户', value: '' },
  ...props.tenants.map(tenant => ({ label: tenant.username, value: tenant.id })),
])
const tenantNames = computed(() => new Map(props.tenants.map(tenant => [tenant.id, tenant.username])))
const selected = computed(() => records.value.find(record => record.id === selectedId.value))
const canEditTerms = computed(() => !!selected.value && ['unused', 'expired'].includes(selected.value.status))
const canReplace = computed(() => !!selected.value && selected.value.status !== 'redeemed' && !selected.value.replacedBy
  && (!selected.value.targetTenantId || tenantNames.value.has(selected.value.targetTenantId)))
const batchFilter = computed(() => typeof route.query.batch === 'string' ? route.query.batch : '')
const tenantFilter = computed(() => typeof route.query.tenant === 'string' ? route.query.tenant : '')
const batchCodes = computed(() => batchFilter.value ? records.value.filter(record => record.batchId === batchFilter.value) : [])
const batchRevocable = computed(() => batchCodes.value.filter(record => record.status === 'unused' || record.status === 'expired').length)
const batchHasUnused = computed(() => batchCodes.value.some(record => record.status === 'unused'))
const filtered = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  return records.value.filter((record) => {
    if ((filterStatus.value && record.status !== filterStatus.value)
      || (filterType.value && record.type !== filterType.value)
      || (batchFilter.value && record.batchId !== batchFilter.value)
      || (tenantFilter.value && record.redeemedBy !== tenantFilter.value && record.targetTenantId !== tenantFilter.value)) {
      return false
    }
    return !keyword || [record.codeHint, record.note, record.batchId, tenantName(record.redeemedBy), tenantName(record.targetTenantId)]
      .some(value => value.toLowerCase().includes(keyword))
  })
})
const generatedText = computed(() => delivery.value?.codes.map(record => record.code).join('\n') || '')

function formDefaults() {
  return { type: 'new' as CodeType, count: 1 as number | string, days: 30 as number | string, maxAccounts: 3 as number | string, redeemBefore: '', note: '', targetTenantId: '' }
}
const form = ref(formDefaults())

function tenantName(id: string | null) {
  return id ? (tenantNames.value.get(id) || '租户已删除') : ''
}

function formatTime(value: number | null) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '不限'
}

function localDateInput(value: number | null) {
  if (!value)
    return ''
  const date = new Date(value)
  return new Date(value - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function viewBatch(id: string) {
  if (id) {
    search.value = ''
    filterStatus.value = ''
    filterType.value = ''
  }
  void router.push({ query: { tab: 'codes', ...(id ? { batch: id } : {}) } })
}

function clearTenantFilter() {
  const { tenant: _tenant, ...query } = route.query
  void router.push({ query })
}

async function loadCodes() {
  const sequence = ++listSequence
  loading.value = true
  loadError.value = ''
  try {
    const { data } = await api.get('/api/admin/codes', { skipErrorToast: true } as any)
    if (!data?.ok)
      throw new Error(getApiErrorMessage(data, '激活码加载失败'))
    if (sequence === listSequence)
      records.value = data.data
  }
  catch (error) {
    if (sequence === listSequence)
      loadError.value = getApiErrorMessage(error, '激活码加载失败')
  }
  finally {
    if (sequence === listSequence)
      loading.value = false
  }
}

function startIssue(target = '') {
  clearReveal()
  form.value = formDefaults()
  formError.value = ''
  if (target) {
    form.value.type = 'renew'
    form.value.targetTenantId = target
    form.value.maxAccounts = props.tenants.find(tenant => tenant.id === target)?.maxAccounts ?? 1
  }
  panel.value = 'generate'
}

function openDetails(record: CodeRecord) {
  clearReveal()
  selectedId.value = record.id
  form.value = {
    type: record.type,
    count: 1,
    days: record.days,
    maxAccounts: record.maxAccounts,
    redeemBefore: localDateInput(record.redeemBefore),
    note: record.note,
    targetTenantId: record.targetTenantId || '',
  }
  formError.value = ''
  panel.value = 'details'
}

function openRelated(id: string) {
  const record = records.value.find(item => item.id === id)
  if (record)
    openDetails(record)
}

function closePanel() {
  if (busy.value)
    return
  panel.value = ''
  delivery.value = null
  formError.value = ''
  clearReveal()
}

function showDelivery(result: Delivery) {
  clearReveal()
  delivery.value = result
  panel.value = 'delivery'
}

function clearReveal() {
  revealSequence++
  revealing.value = ''
  fullCode.value = ''
}

async function revealCode(record: CodeRecord, copy = false) {
  if (revealing.value)
    return
  const sequence = ++revealSequence
  revealing.value = record.id
  try {
    const { data } = await api.get(`/api/admin/codes/${encodeURIComponent(record.id)}/value`, { skipErrorToast: true } as any)
    if (sequence !== revealSequence)
      return
    if (!data?.ok)
      throw new Error(getApiErrorMessage(data, '无法读取完整激活码'))
    const value: string = data.data.code
    if (copy) {
      try {
        await navigator.clipboard.writeText(value)
        toast.success('已复制激活码')
        return
      }
      catch {
        if (sequence !== revealSequence)
          return
      }
    }
    if (panel.value !== 'details' || selectedId.value !== record.id)
      openDetails(record)
    fullCode.value = value
    if (copy) {
      await nextTick()
      fullCodeInput.value?.select()
      toast.info('已选中完整码，可手动复制')
    }
  }
  catch (error) {
    if (sequence === revealSequence)
      toast.error(getApiErrorMessage(error, '无法读取完整激活码'))
  }
  finally {
    if (sequence === revealSequence)
      revealing.value = ''
  }
}

async function openBatchDelivery() {
  const batch = batchFilter.value
  if (revealing.value || !batch)
    return
  const sequence = ++revealSequence
  revealing.value = 'batch'
  try {
    const { data } = await api.get(`/api/admin/codes/batch/${encodeURIComponent(batch)}/values`, { skipErrorToast: true } as any)
    if (sequence !== revealSequence || batch !== batchFilter.value)
      return
    if (!data?.ok)
      throw new Error(getApiErrorMessage(data, '无法读取批次激活码'))
    showDelivery(data.data)
  }
  catch (error) {
    if (sequence === revealSequence)
      toast.error(getApiErrorMessage(error, '无法读取批次激活码'))
  }
  finally {
    if (sequence === revealSequence)
      revealing.value = ''
  }
}

function termPayload() {
  const date = form.value.redeemBefore
  const original = panel.value === 'details' ? selected.value : undefined
  return {
    days: Number(form.value.days),
    maxAccounts: Number(form.value.maxAccounts),
    redeemBefore: original && localDateInput(original.redeemBefore) === date
      ? original.redeemBefore
      : date ? new Date(date).getTime() : null,
    targetTenantId: form.value.type === 'renew' ? form.value.targetTenantId || null : null,
  }
}

async function saveForm() {
  if (busy.value || (panel.value === 'details' && !selected.value))
    return

  const creating = panel.value === 'generate'
  const payload = {
    note: form.value.note,
    ...(creating || canEditTerms.value ? termPayload() : {}),
  }
  busy.value = true
  formError.value = ''
  try {
    const { data } = creating
      ? await api.post('/api/admin/codes', { ...payload, type: form.value.type, count: Number(form.value.count) }, { skipErrorToast: true } as any)
      : await api.put(`/api/admin/codes/${selectedId.value}`, payload, { skipErrorToast: true } as any)
    if (!data?.ok)
      throw new Error(getApiErrorMessage(data, '保存失败'))
    if (creating) {
      showDelivery(data.data)
    }
    else {
      records.value = records.value.map(record => record.id === data.data.id ? data.data : record)
      toast.success('已保存激活码设置')
    }
    emit('changed')
    await loadCodes()
  }
  catch (error) {
    formError.value = getApiErrorMessage(error, '保存失败')
    if (!creating)
      await loadCodes()
  }
  finally {
    busy.value = false
  }
}

async function handleConfirmation() {
  if (busy.value || !confirmation.value)
    return
  const action = confirmation.value
  const batch = action === 'batch'
  const pathname = batch
    ? `batch/${encodeURIComponent(confirmationBatch.value)}/revoke`
    : `${selectedId.value}/${action}`
  busy.value = true
  try {
    const { data } = await api.post(`/api/admin/codes/${pathname}`, undefined, { skipErrorToast: true } as any)
    if (!data?.ok)
      throw new Error(getApiErrorMessage(data, '操作失败'))
    confirmation.value = ''
    if (action === 'replace')
      showDelivery(data.data)
    else
      toast.success(batch ? `已吊销 ${data.data.revoked} 个未兑换的码` : '激活码已吊销')
    emit('changed')
    await loadCodes()
  }
  catch (error) {
    confirmation.value = ''
    toast.error(getApiErrorMessage(error, '操作失败'))
    await loadCodes()
  }
  finally {
    busy.value = false
  }
}

async function copyDelivery() {
  try {
    await navigator.clipboard.writeText(generatedText.value)
    toast.success('已复制激活码')
  }
  catch {
    deliveryText.value?.select()
    toast.info('已选中激活码，可手动复制')
  }
}

function exportDelivery() {
  if (!delivery.value)
    return
  const lines = ['激活码,类型,有效天数,账号配额']
  for (const item of delivery.value.codes)
    lines.push(`${item.code},${types[item.type]},${item.days},${item.maxAccounts}`)
  const link = document.createElement('a')
  const url = URL.createObjectURL(new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' }))
  link.href = url
  link.download = `activation-codes-${delivery.value.batchId}.csv`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function manageTenant(id: string) {
  closePanel()
  emit('manageTenant', id)
}

watch([search, filterStatus, filterType, batchFilter, tenantFilter], () => {
  visibleCount.value = 25
})
watch(() => route.query.issue, (issue) => {
  if (issue !== 'new' && issue !== 'renew')
    return
  const { issue: _issue, target, ...query } = route.query
  startIssue(issue === 'renew' && typeof target === 'string' ? target : '')
  void router.replace({ query })
}, { immediate: true })
onMounted(loadCodes)
onBeforeUnmount(clearReveal)
</script>

<template>
  <section class="codes-workspace farm-card rounded-xl" aria-labelledby="codes-title">
    <div class="codes-toolbar">
      <div>
        <h2 id="codes-title" class="text-base font-semibold">
          激活码
        </h2>
        <p class="codes-muted mt-1 text-xs">
          {{ filtered.length }} 条记录<span v-if="filtered.length !== records.length"> / 共 {{ records.length }} 条</span>
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <BaseButton variant="secondary" size="sm" :loading="loading" @click="loadCodes">
          刷新
        </BaseButton>
        <BaseButton variant="primary" size="sm" @click="startIssue()">
          <span class="i-carbon-add" /> 生成激活码
        </BaseButton>
      </div>
    </div>

    <div class="codes-filters">
      <BaseInput v-model="search" placeholder="搜索末四位、批次、租户或备注" aria-label="搜索激活码" clearable />
      <BaseSelect v-model="filterStatus" :options="statusOptions" aria-label="筛选激活码状态" />
      <BaseSelect v-model="filterType" :options="[{ value: '', label: '全部类型' }, ...typeOptions]" aria-label="筛选激活码类型" />
    </div>
    <div v-if="batchFilter || tenantFilter" class="codes-scope">
      <button v-if="batchFilter" type="button" class="scope-chip" @click="viewBatch('')">
        批次 {{ batchFilter }} <span class="i-carbon-close" aria-hidden="true" /><span class="sr-only">清除批次筛选</span>
      </button>
      <button v-if="tenantFilter" type="button" class="scope-chip" @click="clearTenantFilter">
        租户 {{ tenantName(tenantFilter) }} <span class="i-carbon-close" aria-hidden="true" /><span class="sr-only">清除租户筛选</span>
      </button>
      <BaseButton
        v-if="batchHasUnused"
        variant="secondary"
        size="sm"
        :loading="revealing === 'batch'"
        @click="openBatchDelivery"
      >
        查看批次完整码
      </BaseButton>
      <BaseButton
        v-if="batchRevocable"
        variant="danger"
        size="sm"
        class="scope-action"
        @click="confirmationBatch = batchFilter; confirmation = 'batch'"
      >
        吊销批次未兑换码（{{ batchRevocable }}）
      </BaseButton>
    </div>

    <p v-if="loadError" class="px-4 py-2 text-sm text-red-700 dark:text-red-300" role="alert">
      {{ loadError }}
    </p>
    <div v-if="filtered.length" class="codes-list">
      <div class="code-row code-head" aria-hidden="true">
        <span>激活码</span><span>权益与截止</span><span>关联租户</span><span>批次</span><span>操作</span>
      </div>
      <ul aria-label="激活码列表" class="m-0 list-none p-0">
        <li v-for="record in filtered.slice(0, visibleCount)" :key="record.id" class="code-row">
          <div class="code-identity min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <span class="code-hint">•••• {{ record.codeHint }}</span>
              <span class="code-status" :data-status="record.status">{{ statuses[record.status] }}</span>
            </div>
            <p class="codes-muted mt-1 text-xs">
              {{ types[record.type] }}<span v-if="record.note" class="break-words"> · {{ record.note }}</span>
            </p>
          </div>
          <div class="code-terms">
            <div>{{ record.days }} 天 · {{ record.maxAccounts }} 个账号</div>
            <div class="codes-muted text-xs">
              {{ record.redeemBefore ? `截止 ${formatTime(record.redeemBefore)}` : '兑换时间不限' }}
            </div>
          </div>
          <div class="code-tenant">
            <template v-if="record.redeemedBy || record.targetTenantId">
              <button
                v-if="tenantNames.has((record.redeemedBy || record.targetTenantId)!)"
                type="button"
                class="code-link"
                @click="manageTenant((record.redeemedBy || record.targetTenantId)!)"
              >
                {{ tenantName(record.redeemedBy || record.targetTenantId) }}
              </button>
              <span v-else class="codes-muted">租户已删除</span>
              <div class="codes-muted text-xs">
                {{ record.redeemedBy ? '兑换人' : '指定续费' }}
              </div>
            </template>
            <span v-else class="codes-muted">—</span>
          </div>
          <div class="code-batch min-w-0">
            <button v-if="record.batchId" type="button" class="code-link break-all text-xs font-mono" @click="viewBatch(record.batchId)">
              {{ record.batchId }}
            </button>
          </div>
          <div class="code-action flex flex-wrap justify-end gap-1">
            <BaseButton
              v-if="record.hasFullCode"
              variant="ghost"
              size="sm"
              :aria-label="`复制激活码 ${record.codeHint}`"
              :loading="revealing === record.id"
              @click="revealCode(record, true)"
            >
              <span class="i-carbon-copy" aria-hidden="true" /> 复制
            </BaseButton>
            <BaseButton variant="secondary" size="sm" :aria-label="`管理激活码 ${record.codeHint}`" @click="openDetails(record)">
              管理
            </BaseButton>
          </div>
        </li>
      </ul>
      <div v-if="visibleCount < filtered.length" class="border-t p-3 text-center">
        <BaseButton variant="ghost" size="sm" @click="visibleCount += 25">
          显示更多
        </BaseButton>
      </div>
    </div>
    <div v-else class="codes-empty">
      <span class="i-carbon-ticket text-3xl" aria-hidden="true" />
      <p>{{ loading ? '正在读取激活码…' : records.length ? '没有匹配的激活码' : '还没有激活码' }}</p>
    </div>
  </section>

  <NDrawer :show="!!panel" width="min(520px, 100vw)" placement="right" :mask-closable="!busy" :close-on-esc="!busy" @update:show="value => !value && closePanel()">
    <NDrawerContent :title="panel === 'generate' ? '生成激活码' : panel === 'delivery' ? (isBatchDelivery ? '批次待兑换码' : '激活码已生成') : '管理激活码'" :closable="!busy">
      <template v-if="panel === 'delivery' && delivery">
        <p class="codes-muted text-sm">
          {{ isBatchDelivery ? `本批有 ${delivery.codes.length} 个待兑换码可复制。` : `已生成 ${delivery.codes.length} 个码，之后也可从列表复制或从批次导出。` }}
        </p>
        <p v-if="delivery.unavailable" class="codes-muted mt-2 text-xs">
          {{ delivery.unavailable }} 个旧版激活码仅保存了哈希，可逐个换发。
        </p>
        <textarea v-if="generatedText" ref="deliveryText" aria-label="完整激活码" class="delivery-text" readonly :value="generatedText" />
        <div v-if="generatedText" class="flex flex-wrap gap-2">
          <BaseButton variant="primary" size="sm" @click="copyDelivery">
            复制全部
          </BaseButton>
          <BaseButton variant="secondary" size="sm" @click="exportDelivery">
            导出 CSV
          </BaseButton>
          <BaseButton v-if="!isBatchDelivery" variant="ghost" size="sm" @click="viewBatch(delivery.batchId); closePanel()">
            查看本批次
          </BaseButton>
        </div>
      </template>

      <form v-else-if="panel === 'generate' || selected" class="space-y-4" @submit.prevent="saveForm">
        <div v-if="panel === 'details' && selected" class="code-detail">
          <div class="flex flex-wrap items-center gap-3">
            <strong class="code-hint text-xl">•••• {{ selected.codeHint }}</strong>
            <span class="code-status" :data-status="selected.status">{{ statuses[selected.status] }}</span>
            <span class="codes-muted text-sm">{{ types[selected.type] }}</span>
          </div>
          <div v-if="selected.redeemedBy || selected.targetTenantId" class="mt-3 flex items-center gap-2 text-sm">
            <span class="codes-muted">{{ selected.redeemedBy ? '兑换人' : '指定租户' }}</span>
            <button
              v-if="tenantNames.has((selected.redeemedBy || selected.targetTenantId)!)"
              type="button"
              class="code-link"
              @click="manageTenant((selected.redeemedBy || selected.targetTenantId)!)"
            >
              管理 {{ tenantName(selected.redeemedBy || selected.targetTenantId) }}
            </button>
            <span v-else>租户已删除</span>
          </div>
          <div class="codes-muted mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <span>生成于 {{ formatTime(selected.createdAt) }}</span>
            <span v-if="selected.redeemedAt">兑换于 {{ formatTime(selected.redeemedAt) }}</span>
            <button v-if="selected.batchId" type="button" class="code-link" @click="viewBatch(selected.batchId); closePanel()">
              查看批次
            </button>
          </div>
          <div v-if="selected.replacedBy || selected.replacesId" class="mt-2 flex flex-wrap gap-3 text-xs">
            <button v-if="selected.replacesId" type="button" class="code-link" @click="openRelated(selected.replacesId)">
              查看原码
            </button>
            <button v-if="selected.replacedBy" type="button" class="code-link" @click="openRelated(selected.replacedBy)">
              查看换发后的码
            </button>
          </div>
          <div v-if="selected.hasFullCode" class="mt-3 flex flex-wrap items-center gap-2">
            <input v-if="fullCode" ref="fullCodeInput" class="full-code" aria-label="完整激活码" readonly :value="fullCode">
            <BaseButton v-else variant="secondary" size="sm" :loading="revealing === selected.id" @click="revealCode(selected)">
              显示完整码
            </BaseButton>
            <BaseButton variant="ghost" size="sm" :loading="revealing === selected.id" @click="revealCode(selected, true)">
              复制完整码
            </BaseButton>
          </div>
          <p v-else class="codes-muted mt-2 text-xs">
            此码由旧版本生成，仅保留末四位。
          </p>
        </div>

        <div v-if="panel === 'generate'" class="form-grid">
          <BaseSelect v-model="form.type" label="类型" :options="typeOptions" :disabled="busy" />
          <BaseInput v-model="form.count" label="生成数量" type="number" :min="1" :max="100" :disabled="busy" />
        </div>
        <div v-if="panel === 'generate' || canEditTerms" class="form-grid">
          <BaseInput v-model="form.days" label="有效天数" type="number" :min="1" :max="3650" :disabled="busy" />
          <BaseInput v-model="form.maxAccounts" label="账号配额" type="number" :min="1" :max="100" :disabled="busy" />
          <label class="date-field">
            <span>兑换截止 <small>可选</small></span>
            <input v-model="form.redeemBefore" type="datetime-local" :disabled="busy">
          </label>
          <div v-if="form.type === 'renew'" class="flex flex-col gap-1">
            <BaseSelect v-model="form.targetTenantId" label="指定租户" :options="tenantOptions" :disabled="busy" filterable />
            <span class="codes-muted text-xs">指定后仅该租户可兑换。续费时配额只升不降。</span>
          </div>
        </div>
        <p v-else-if="selected" class="codes-muted text-sm">
          {{ selected.days }} 天 · {{ selected.maxAccounts }} 个账号 · 兑换截止 {{ formatTime(selected.redeemBefore) }}
        </p>
        <BaseInput v-model="form.note" label="备注" placeholder="可用于查找这张码" :disabled="busy" />
        <p v-if="formError" class="text-sm text-red-700 dark:text-red-300" role="alert">
          {{ formError }}
        </p>
        <div class="flex flex-wrap justify-between gap-2">
          <div v-if="panel === 'details'" class="flex flex-wrap gap-2">
            <BaseButton v-if="canReplace" variant="secondary" size="sm" :disabled="busy" @click="confirmation = 'replace'">
              换发新码
            </BaseButton>
            <BaseButton v-if="canEditTerms" variant="danger" size="sm" :disabled="busy" @click="confirmation = 'revoke'">
              吊销
            </BaseButton>
          </div>
          <BaseButton variant="primary" size="sm" type="submit" :loading="busy" class="ml-auto">
            {{ panel === 'generate' ? '生成' : '保存修改' }}
          </BaseButton>
        </div>
      </form>
    </NDrawerContent>
  </NDrawer>

  <ConfirmModal
    :show="!!confirmation"
    :title="confirmation === 'replace' ? '换发激活码' : confirmation === 'batch' ? '吊销批次未兑换码' : '吊销激活码'"
    :message="confirmation === 'replace' ? '旧码将失效，新码沿用已保存的权益与租户。已过期的兑换截止时间会清除。'
      : confirmation === 'batch' ? `将吊销批次 ${confirmationBatch} 内所有未兑换的码，已兑换的权益继续生效。` : '吊销后此码无法兑换。'"
    :confirm-text="confirmation === 'replace' ? '确认换发' : '确认吊销'"
    :loading="busy"
    :type="confirmation === 'replace' ? 'primary' : 'danger'"
    @confirm="handleConfirmation"
    @cancel="confirmation = ''"
  />
</template>

<style scoped>
.codes-workspace {
  container-type: inline-size;
  min-width: 0;
  color: var(--ui-ink);
}
.codes-toolbar,
.codes-filters,
.codes-scope {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
}
.codes-toolbar {
  flex-wrap: wrap;
  justify-content: space-between;
}
.codes-filters {
  display: grid;
  grid-template-columns: minmax(0, 1fr) repeat(2, minmax(130px, 0.34fr));
  padding-top: 0;
}
.codes-scope {
  flex-wrap: wrap;
  padding-top: 0;
}
.scope-action {
  margin-left: auto;
}
.codes-muted {
  color: var(--ui-muted);
}
.scope-chip,
.code-link {
  color: var(--ui-primary);
  text-align: left;
}
.scope-chip {
  border: 1px solid var(--ui-border);
  border-radius: 99px;
  padding: 4px 9px;
  background: var(--ui-primary-soft);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.code-link {
  text-underline-offset: 3px;
}
.code-link:hover {
  text-decoration: underline;
}
.code-row {
  display: grid;
  grid-template-columns: minmax(135px, 1.45fr) minmax(145px, 1.2fr) minmax(95px, 0.85fr) minmax(116px, 0.9fr) 120px;
  align-items: center;
  gap: 10px 14px;
  min-width: 0;
  padding: 12px 16px;
  border-top: 1px solid var(--ui-border);
  font-size: 13px;
}
.code-row:hover {
  background: var(--ui-surface-soft);
}
.code-head {
  color: var(--ui-muted);
  background: var(--ui-surface-soft);
  font-size: 11px;
  font-weight: 600;
}
.code-head > :last-child {
  text-align: right;
}
.code-hint {
  font-family: ui-monospace, monospace;
  font-weight: 600;
  letter-spacing: 0.04em;
}
.code-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  width: max-content;
  padding: 3px 7px;
  border-radius: 99px;
  background: var(--ui-surface-soft);
  font-size: 11px;
}
.code-status::before {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ui-primary);
  content: '';
}
.code-status[data-status='redeemed']::before {
  background: #2f9e6e;
}
.code-status[data-status='expired']::before {
  background: var(--ui-warning);
}
.code-status[data-status='revoked']::before {
  background: var(--ui-danger);
}
.code-action {
  justify-self: end;
}
.codes-empty {
  display: grid;
  gap: 10px;
  place-items: center;
  padding: 40px 12px;
  border-top: 1px solid var(--ui-border);
  color: var(--ui-muted);
}
.code-detail {
  padding: 14px;
  border: 1px solid var(--ui-border);
  border-radius: 12px;
  background: var(--ui-surface-soft);
  color: var(--ui-ink);
}
.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.date-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  color: var(--ui-muted);
  font-size: 12px;
}
.date-field input,
.delivery-text {
  box-sizing: border-box;
  color: var(--ui-ink);
  border: 1px solid var(--ui-border-strong);
  border-radius: 10px;
  background: var(--ui-surface-strong);
}
.full-code {
  flex: 1 1 15ch;
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: var(--ui-surface-strong);
  font:
    13px ui-monospace,
    monospace;
}
.date-field input {
  height: 38px;
  width: 100%;
  min-width: 0;
  padding: 0 9px;
  font: inherit;
}
.delivery-text {
  width: 100%;
  min-height: 118px;
  resize: vertical;
  margin: 12px 0;
  padding: 12px;
  font:
    13px/1.7 ui-monospace,
    monospace;
}
@container (max-width: 715px) {
  .code-head {
    display: none;
  }
  .code-row {
    grid-template-columns: minmax(0, 1fr) minmax(0, 0.85fr);
  }
  .code-identity,
  .code-terms,
  .code-batch {
    grid-column: 1;
  }
  .code-tenant {
    grid-column: 2;
    grid-row: 2;
  }
  .code-action {
    grid-column: 2;
    grid-row: 1;
  }
}
@media (max-width: 520px) {
  .codes-filters {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .codes-filters > :first-child {
    grid-column: 1 / -1;
  }
  .form-grid {
    grid-template-columns: 1fr;
  }
}
</style>
