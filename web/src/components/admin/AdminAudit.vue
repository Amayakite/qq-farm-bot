<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'

interface AuditEntry {
  id: string
  at: number
  actor: string
  action: string
  tenantId?: string
  username?: string
  codeId?: string
  batchId?: string
  count?: number
}

const labels: Record<string, string> = {
  'code.generate': '生成激活码',
  'code.update': '修改激活码',
  'code.reveal': '读取完整激活码',
  'code.reveal_batch': '读取批次待兑换码',
  'code.replace': '换发激活码',
  'code.revoke': '吊销激活码',
  'code.revoke_batch': '吊销批次',
  'tenant.create': '创建租户',
  'tenant.extend': '延长有效期',
  'tenant.quota': '调整账号配额',
  'tenant.password': '重置密码',
  'tenant.kick': '强制下线',
  'tenant.disable': '停用租户',
  'tenant.enable': '恢复租户',
  'tenant.delete': '删除租户',
}
const categories = [
  { label: '全部操作', value: '' },
  { label: '激活码', value: 'code' },
  { label: '租户', value: 'tenant' },
]
const records = ref<AuditEntry[]>([])
const page = ref(1)
const pageSize = ref(25)
const total = ref(0)
const loading = ref(false)
const error = ref('')
const search = ref('')
const category = ref('')
let sequence = 0
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))

async function refresh(target = page.value) {
  const request = ++sequence
  loading.value = true
  error.value = ''
  try {
    const { data } = await api.get('/api/admin/audit', {
      params: { page: target, search: search.value, category: category.value },
      skipErrorToast: true,
    } as any)
    if (!data?.ok)
      throw new Error(getApiErrorMessage(data, '操作记录读取失败'))
    if (request !== sequence)
      return
    records.value = data.data.items
    total.value = data.data.total
    page.value = data.data.page
    pageSize.value = data.data.pageSize
  }
  catch (cause) {
    if (request === sequence)
      error.value = getApiErrorMessage(cause, '操作记录读取失败')
  }
  finally {
    if (request === sequence)
      loading.value = false
  }
}

function formatTime(value: number) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

watch([search, category], (_value, _old, onCleanup) => {
  sequence++
  loading.value = true
  const timer = window.setTimeout(() => refresh(1), 150)
  onCleanup(() => clearTimeout(timer))
})
onMounted(() => refresh())
</script>

<template>
  <section class="farm-card rounded-xl" aria-labelledby="audit-title">
    <div class="flex items-center justify-between gap-3">
      <div>
        <h2 id="audit-title" class="font-semibold">
          管理员操作记录
        </h2>
        <p class="audit-muted mt-1 text-xs">
          {{ total }} 条记录
        </p>
      </div>
      <BaseButton variant="secondary" size="sm" :loading="loading" @click="refresh()">
        刷新
      </BaseButton>
    </div>

    <div class="grid grid-cols-1 mt-4 gap-2 sm:grid-cols-[1fr_10rem]">
      <BaseInput v-model="search" placeholder="搜索操作者、用户名、码 ID 或批次" clearable />
      <BaseSelect v-model="category" :options="categories" aria-label="操作类型" />
    </div>

    <p v-if="error" class="mt-4 text-sm text-red-700 dark:text-red-300" role="alert">
      {{ error }}
    </p>
    <ul v-if="records.length" aria-label="管理员操作记录" class="m-0 mt-4 list-none p-0">
      <li v-for="record in records" :key="record.id" class="audit-row">
        <div>
          <div class="font-semibold">
            {{ labels[record.action] || record.action }}
          </div>
          <div class="audit-muted mt-1 text-xs">
            操作者 {{ record.actor }}<span v-if="record.count !== undefined"> · 数量 {{ record.count }}</span>
          </div>
        </div>
        <div class="min-w-0 break-all text-sm">
          <span v-if="record.action === 'tenant.delete'">{{ record.username || record.tenantId }}</span>
          <RouterLink v-else-if="record.tenantId" class="audit-link" :to="{ query: { manage: record.tenantId } }">
            {{ record.username || record.tenantId }}
          </RouterLink>
          <RouterLink v-else-if="record.codeId" class="audit-link" :to="{ query: { tab: 'codes', record: record.codeId } }">
            查看激活码
          </RouterLink>
          <RouterLink v-else-if="record.batchId" class="audit-link" :to="{ query: { tab: 'codes', batch: record.batchId } }">
            {{ record.batchId }}
          </RouterLink>
        </div>
        <time class="audit-muted text-xs" :datetime="new Date(record.at).toISOString()">{{ formatTime(record.at) }}</time>
      </li>
    </ul>
    <p v-else-if="!error" class="audit-muted py-8 text-center text-sm">
      {{ loading ? '正在读取操作记录…' : '没有符合条件的操作记录' }}
    </p>

    <div v-if="totalPages > 1" class="flex items-center justify-center gap-3 border-t pt-3 text-sm">
      <BaseButton variant="ghost" size="sm" :disabled="page <= 1 || loading" @click="refresh(page - 1)">
        上一页
      </BaseButton>
      <span class="audit-muted">{{ page }} / {{ totalPages }}</span>
      <BaseButton variant="ghost" size="sm" :disabled="page >= totalPages || loading" @click="refresh(page + 1)">
        下一页
      </BaseButton>
    </div>
  </section>
</template>

<style scoped>
.audit-row {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.8fr) max-content;
  align-items: center;
  gap: 10px;
  padding: 12px 0;
  border-top: 1px solid var(--ui-border);
  font-size: 13px;
}
.audit-muted {
  color: var(--ui-muted);
}
.audit-link {
  color: var(--ui-primary);
}
@media (max-width: 560px) {
  .audit-row {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
