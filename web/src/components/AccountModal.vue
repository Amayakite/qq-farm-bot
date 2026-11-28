<script setup lang="ts">
import { NCard } from 'naive-ui/es/card'
import { NModal } from 'naive-ui/es/modal'
import { NRadio, NRadioGroup } from 'naive-ui/es/radio'
import { NTab, NTabs } from 'naive-ui/es/tabs'
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseTextarea from '@/components/ui/BaseTextarea.vue'

type Platform = 'qq' | 'wx'
type ScanStatus = 'queued' | 'creating' | 'waiting_scan' | 'scanned' | 'authorizing' | 'releasing' | 'completed' | 'cancelled' | 'expired' | 'failed'
interface ScanTask {
  id: string
  status: ScanStatus
  qrImage?: string
  error?: string
}

const props = defineProps<{
  show: boolean
  editData?: { id?: string | number, name?: string, platform?: string } | null
}>()

const emit = defineEmits(['close', 'saved'])
const taskPath = '/api/account-scan/tasks'
const terminal = new Set<ScanStatus>(['completed', 'cancelled', 'failed', 'expired'])
const messages: Record<ScanStatus, string> = {
  queued: '正在等待扫码通道',
  creating: '正在生成二维码',
  waiting_scan: '请打开手机应用扫码',
  scanned: '已扫码，请在手机上确认',
  authorizing: '正在获取授权并保存账号',
  releasing: '正在释放扫码通道',
  completed: '账号已保存',
  cancelled: '扫码已取消',
  expired: '扫码任务已过期，请重新获取',
  failed: '',
}

const form = reactive({ name: '', code: '', platform: 'qq' as Platform })
const loading = ref(false)
const errorMessage = ref('')
const activeLoginTab = ref<'code' | Platform>('code')
const loginSettingsLoaded = ref(false)
const loginSettings = ref({ qqQrLogin: false, wechatQrLogin: false })
let settingsVersion = 0
const editPlatform = computed<Platform>(() => props.editData?.platform === 'wx' ? 'wx' : 'qq')
const availablePlatforms = computed(() => ({
  qq: loginSettings.value.qqQrLogin && (!props.editData || editPlatform.value === 'qq'),
  wx: loginSettings.value.wechatQrLogin && (!props.editData || editPlatform.value === 'wx'),
}))

const scan = ref<ScanTask | null>(null)
const scanStarting = ref(false)
const scanError = ref('')
const scanInProgress = computed(() => scanStarting.value || (!!scan.value && !terminal.has(scan.value.status)))
const finishingScan = computed(() => scan.value?.status === 'authorizing' || scan.value?.status === 'releasing')
const scanMessage = computed(() => scanStarting.value ? '正在申请扫码' : scan.value ? messages[scan.value.status] : '')
const scanLabel = computed(() => activeLoginTab.value === 'wx' ? '微信扫码登录' : 'QQ扫码登录')
const scanImageLabel = computed(() => activeLoginTab.value === 'wx' ? '微信登录二维码' : 'QQ登录二维码')
let scanVersion = 0
let pollTimer: ReturnType<typeof setTimeout> | undefined
let lastRequest: { id: string, intent: string } | undefined

async function loadLoginSettings() {
  const version = ++settingsVersion
  loginSettingsLoaded.value = false
  try {
    const response = await api.get('/api/settings/login-config', { skipErrorToast: true } as any)
    if (version !== settingsVersion)
      return
    const data = response.data?.data
    loginSettings.value = { qqQrLogin: data?.qqQrLogin === true, wechatQrLogin: data?.wechatQrLogin === true }
  }
  catch {
    if (version === settingsVersion)
      loginSettings.value = { qqQrLogin: false, wechatQrLogin: false }
  }
  finally {
    if (version === settingsVersion)
      loginSettingsLoaded.value = true
  }
}

async function submitManual() {
  errorMessage.value = ''
  const name = form.name.trim()
  if (!name) {
    errorMessage.value = '请输入账号备注'
    return
  }
  let code = form.code.trim()
  if (!code) {
    errorMessage.value = '请输入 Code'
    return
  }
  loading.value = true
  try {
    const match = code.match(/[?&]code=([^&]+)/i)
    if (match?.[1])
      code = decodeURIComponent(match[1]).trim()
    const response = await api.post('/api/accounts', {
      name,
      code,
      platform: props.editData ? editPlatform.value : form.platform,
      loginType: 'manual',
      ...(props.editData?.id ? { id: props.editData.id } : {}),
    }, { skipErrorToast: true } as any)
    if (!response.data?.ok)
      throw new Error(getApiErrorMessage(response.data))
    emit('saved')
    close()
  }
  catch (error) {
    errorMessage.value = getApiErrorMessage(error, '保存账号失败')
  }
  finally {
    loading.value = false
  }
}

function cancelScan(id: string) {
  return api.delete(`${taskPath}/${id}`, { skipErrorToast: true } as any).catch(() => undefined)
}

function resetScan() {
  scanVersion++
  clearTimeout(pollTimer)
  const previous = scan.value
  scan.value = null
  scanStarting.value = false
  scanError.value = ''
  lastRequest = undefined
  if (previous && !terminal.has(previous.status) && previous.status !== 'authorizing' && previous.status !== 'releasing')
    void cancelScan(previous.id)
}

function applyTask(task: ScanTask, version: number) {
  scan.value = task
  scanError.value = task.error || ''
  if (task.status === 'completed') {
    emit('saved')
    close()
  }
  else if (!terminal.has(task.status)) {
    pollTimer = setTimeout(() => void pollScan(task.id, version), 1200)
  }
}

async function pollScan(id: string, version: number) {
  try {
    const response = await api.get(`${taskPath}/${id}`, { skipErrorToast: true } as any)
    if (version === scanVersion)
      applyTask(response.data.data, version)
  }
  catch (error: any) {
    if (version !== scanVersion)
      return
    if (!error.response || error.response.status >= 500) {
      scanError.value = '连接暂时中断，正在重新获取扫码状态'
      pollTimer = setTimeout(() => void pollScan(id, version), 3000)
    }
    else {
      if (scan.value)
        scan.value = { id, status: 'failed' }
      scanError.value = getApiErrorMessage(error, '扫码任务已失效')
    }
  }
}

async function startScan() {
  const platform = activeLoginTab.value
  if (platform === 'code' || !availablePlatforms.value[platform] || scanInProgress.value)
    return
  const name = form.name.trim()
  const accountId = props.editData?.id === undefined ? undefined : String(props.editData.id)
  const intent = JSON.stringify([platform, accountId, name])
  if (scan.value || lastRequest?.intent !== intent) {
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('')
    lastRequest = { id, intent }
  }
  const version = ++scanVersion
  scan.value = null
  scanError.value = ''
  scanStarting.value = true
  try {
    const response = await api.post(taskPath, { platform, accountId, name, requestId: lastRequest!.id }, { skipErrorToast: true } as any)
    const task = response.data.data as ScanTask
    if (version !== scanVersion) {
      if (!terminal.has(task.status))
        void cancelScan(task.id)
      return
    }
    applyTask(task, version)
  }
  catch (error) {
    if (version === scanVersion)
      scanError.value = getApiErrorMessage(error, '无法提交扫码，请重试')
  }
  finally {
    if (version === scanVersion)
      scanStarting.value = false
  }
}

function close() {
  resetScan()
  emit('close')
}

watch(() => props.show, (show) => {
  resetScan()
  if (show) {
    errorMessage.value = ''
    activeLoginTab.value = 'code'
    form.name = props.editData?.name || ''
    form.code = ''
    form.platform = editPlatform.value
    void loadLoginSettings()
  }
}, { immediate: true })

watch(activeLoginTab, () => {
  errorMessage.value = ''
  resetScan()
})
onBeforeUnmount(resetScan)
</script>

<template>
  <NModal
    :show="show"
    :mask-closable="!loading"
    :close-on-esc="!loading"
    @update:show="value => !value && close()"
  >
    <NCard
      class="account-modal-card"
      :title="editData ? '编辑账号' : '添加账号'"
      :bordered="false"
      :closable="!loading"
      @close="close"
    >
      <div class="account-modal-content dialog-scroll overflow-y-auto">
        <!-- 错误信息 -->
        <div v-if="errorMessage" class="mb-4 rounded-xl p-3 text-sm" style="background: rgba(239, 68, 68, 0.1); color: #ef4444">
          {{ errorMessage }}
        </div>

        <NTabs v-if="loginSettingsLoaded" v-model:value="activeLoginTab" class="mb-4" type="line">
          <NTab name="code">
            输入 Code 登录
          </NTab>
          <NTab v-if="availablePlatforms.wx" name="wx">
            微信扫码登录
          </NTab>
          <NTab v-if="availablePlatforms.qq" name="qq">
            QQ扫码登录
          </NTab>
        </NTabs>

        <div v-if="activeLoginTab === 'code'" class="space-y-4">
          <BaseInput
            v-if="!editData"
            v-model="form.name"
            label="账号备注（必填）"
            placeholder="请输入账号备注"
            class="farm-input"
          />

          <BaseTextarea
            v-model="form.code"
            label="Code"
            placeholder="请输入登录 Code"
            :rows="3"
            class="farm-input"
          />

          <NRadioGroup v-if="!editData" v-model:value="form.platform" name="account-platform">
            <div class="flex gap-5">
              <NRadio value="qq">
                QQ 小程序
              </NRadio>
              <NRadio value="wx">
                微信小程序
              </NRadio>
            </div>
          </NRadioGroup>

          <div class="flex justify-end gap-2 pt-4">
            <BaseButton variant="outline" @click="close">
              取消
            </BaseButton>
            <BaseButton variant="primary" :loading="loading" @click="submitManual">
              {{ editData ? '保存' : '添加' }}
            </BaseButton>
          </div>
        </div>
        <div v-else class="space-y-4" role="tabpanel" :aria-label="scanLabel">
          <BaseInput
            v-model="form.name"
            label="账号备注（可留空）"
            :placeholder="editData ? '留空时保留原备注' : '留空时使用账号昵称'"
            :maxlength="120"
            :disabled="scanInProgress"
            class="farm-input"
          />
          <p v-if="activeLoginTab === 'wx'" class="text-xs leading-5 text-gray-500 dark:text-gray-400">
            扫码后如取得可续期授权，服务器会加密保存以恢复托管；授权失效时仍需重新扫码。
          </p>
          <div v-if="scan || scanStarting || scanError" class="min-h-64 flex flex-col items-center justify-center gap-3">
            <div v-if="scan?.qrImage" class="bg-white p-2">
              <img :src="scan.qrImage" :alt="scanImageLabel" class="h-52 w-52">
            </div>
            <p v-if="scanMessage" role="status" class="text-center text-sm" :style="{ color: 'var(--theme-text)' }">
              {{ scanMessage }}
            </p>
            <p v-if="scanError" role="alert" class="text-center text-sm text-red-500">
              {{ scanError }}
            </p>
          </div>
          <div class="flex justify-end gap-2">
            <BaseButton variant="outline" @click="close">
              {{ finishingScan ? '关闭' : '取消' }}
            </BaseButton>
            <BaseButton v-if="!scan || !scanInProgress" variant="primary" :loading="scanStarting" @click="startScan">
              {{ scan ? '重新获取二维码' : '获取二维码' }}
            </BaseButton>
          </div>
        </div>
      </div>
    </NCard>
  </NModal>
</template>

<style scoped>
.account-modal-card {
  width: min(448px, calc(100vw - 32px));
}

.account-modal-content {
  max-height: calc(90vh - 100px);
}
</style>
