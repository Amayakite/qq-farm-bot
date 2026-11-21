<script setup lang="ts">
import type { Account, HostingStatus } from '@/stores/account'
import { useNow } from '@vueuse/core'
import { NCard } from 'naive-ui/es/card'
import { NModal } from 'naive-ui/es/modal'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AccountModal from '@/components/AccountModal.vue'
import ConfirmModal from '@/components/ConfirmModal.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { hostingLabel, useAccountStore } from '@/stores/account'
import { useFarmStore } from '@/stores/farm'
import { useRanchStore } from '@/stores/ranch'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'
import { useUserStore } from '@/stores/user'

const router = useRouter()
const accountStore = useAccountStore()
const statusStore = useStatusStore()
const farmStore = useFarmStore()
const ranchStore = useRanchStore()
const userStore = useUserStore()
const toast = useToastStore()

const { accounts, currentAccountId, currentAccount } = storeToRefs(accountStore)
const { status, logs, realtimeConnected, currentAccountConnected } = storeToRefs(statusStore)
const { lands, summary } = storeToRefs(farmStore)
const { state: ranchState, loading: ranchLoading } = storeToRefs(ranchStore)

const showAccountModal = ref(false)
const editingAccount = ref<Account | null>(null)
const welcomeVisible = ref(false)
const storageKey = (name: string) => `${name}:${userStore.userInfo?.id || 'guest'}`
const checklistDismissed = ref(localStorage.getItem(storageKey('home_checklist_dismissed_v1')) === '1')
const visitedFarm = ref(localStorage.getItem(storageKey('visited_farm_v1')) === '1')
const visitedRanch = ref(localStorage.getItem(storageKey('visited_ranch_v1')) === '1')
const actionLoading = ref(false)
const confirmConfig = ref({
  show: false,
  title: '',
  message: '',
  accountId: '',
})

const hasAccount = computed(() => accounts.value.length > 0)
const now = useNow({ interval: 60_000 })
const currentHosting = computed<HostingStatus | undefined>(() =>
  (String(status.value?.accountId || '') === currentAccountId.value ? status.value?.hosting : undefined) || currentAccount.value?.hosting,
)
const currentPhase = computed<HostingStatus['phase']>(() =>
  currentHosting.value?.phase || (currentAccountConnected.value ? 'online' : currentAccount.value?.running ? 'connecting' : 'stopped'),
)
const isRunning = computed(() => currentPhase.value === 'online' || currentPhase.value === 'connecting' || currentPhase.value === 'queued')
const showStart = computed(() => hasAccount.value && currentPhase.value !== 'suspended' && !isRunning.value)
const needsCode = computed(() => currentHosting.value?.needsCode || currentPhase.value === 'relogin_required')
const issueLabels: Record<NonNullable<HostingStatus['issue']>['reason'], string> = {
  login_required: '游戏拒绝了当前登录码，请扫码或输入新的 Code。',
  kicked: '游戏账号被踢下线，请重新登录。',
  session_lost: '游戏连接已断开，恢复托管需要新的登录 Code。',
  disconnected: '上次连接游戏网关失败。',
  worker_failed: '托管进程启动失败或异常退出。',
}
const lastIssue = computed(() => currentHosting.value?.issue)
const expiresAt = computed(() => userStore.expiresAt)
const remaining = computed(() => expiresAt.value ? expiresAt.value - now.value.getTime() : Number.POSITIVE_INFINITY)
const showExpiry = computed(() => remaining.value <= 7 * 86_400_000)
function formatTime(value: number) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}
const currentStatus = computed(() => String(status.value?.accountId || '') === currentAccountId.value ? status.value?.status : null)
const accountName = computed(() => {
  return currentStatus.value?.name || currentAccount.value?.nick || currentAccount.value?.name || '我的农场'
})
const level = computed(() => Number(currentStatus.value?.level) || 0)
const gold = computed(() => Number(currentStatus.value?.gold) || 0)
const diamond = computed(() => Number(statusStore.diamondBalance) || 0)
const harvestable = computed(() => Number(summary.value?.harvestable) || 0)
const growing = computed(() => Number(summary.value?.growing) || 0)
const emptyLands = computed(() => Number(summary.value?.empty) || 0)
const landCount = computed(() => lands.value.length)

const ranchAnimals = computed(() => {
  const facilities = Array.isArray(ranchState.value?.facilities) ? ranchState.value.facilities : []
  return facilities
    .filter((facility: any) => facility?.ranch)
    .flatMap((facility: any) => (facility.ranch.animals || []).map((animal: any) => ({ animal, pen: facility.name })))
})
const ranchCanFeed = computed(() => ranchAnimals.value.filter(({ animal }: any) => animal.canFeed).length)
const ranchCanHarvest = computed(() => ranchAnimals.value.filter(({ animal }: any) => animal.canHarvest).length)
const ranchHazards = computed(() => {
  const facilities = Array.isArray(ranchState.value?.facilities) ? ranchState.value.facilities : []
  return facilities.reduce((sum: number, facility: any) => sum + (facility?.ranch?.hazards?.length || 0), 0)
})

const greeting = computed(() => {
  const hour = new Date().getHours()
  if (hour < 6)
    return '夜深了'
  if (hour < 11)
    return '早上好'
  if (hour < 14)
    return '中午好'
  if (hour < 18)
    return '下午好'
  return '晚上好'
})

const todayLabel = computed(() => new Date().toLocaleDateString('zh-CN', {
  month: 'long',
  day: 'numeric',
  weekday: 'long',
}))

const checklist = computed(() => [
  {
    key: 'account',
    title: '添加游戏账号',
    description: '支持 QQ / 微信扫码登录，也可以粘贴 Code',
    done: hasAccount.value,
    action: 'account',
    actionLabel: '添加账号',
  },
  {
    key: 'start',
    title: '启动自动托管',
    description: '账号在线后，收菜、浇水和好友巡查会自动进行',
    done: hasAccount.value && currentPhase.value === 'online',
    action: 'start',
    actionLabel: '启动托管',
  },
  {
    key: 'farm',
    title: '去农场收菜',
    description: '查看成熟土地，一键收获当前作物',
    done: visitedFarm.value || harvestable.value > 0,
    action: 'farm',
    actionLabel: '进入农场',
  },
  {
    key: 'ranch',
    title: '去牧场看看',
    description: '喂养动物、清理牧场、领取产出',
    done: visitedRanch.value,
    action: 'ranch',
    actionLabel: '进入牧场',
  },
])
const checklistDone = computed(() => checklist.value.filter(step => step.done).length)
const showChecklist = computed(() => !checklistDismissed.value && checklistDone.value < checklist.value.length)

const tasks = computed(() => {
  const list: Array<{ key: string, text: string, action: string, label: string }> = []
  if (harvestable.value > 0)
    list.push({ key: 'harvest', text: `${harvestable.value} 块土地可以收获`, action: 'harvest', label: '去收菜' })
  if (ranchCanFeed.value > 0)
    list.push({ key: 'feed', text: `${ranchCanFeed.value} 只动物可以喂养`, action: 'ranch', label: '去牧场' })
  if (ranchHazards.value > 0)
    list.push({ key: 'clean', text: `牧场有 ${ranchHazards.value} 处需要清理`, action: 'ranch', label: '去清理' })
  if (ranchCanHarvest.value > 0)
    list.push({ key: 'ranch-harvest', text: `${ranchCanHarvest.value} 只动物可以收获`, action: 'ranch', label: '去收获' })
  if (!hasAccount.value)
    list.push({ key: 'add', text: '还没有添加游戏账号', action: 'account', label: '去添加' })
  if (list.length === 0)
    list.push({ key: 'ok', text: '当前没有紧急任务，可以去农场或牧场逛逛', action: 'farm', label: '去农场' })
  return list
})

const recentLogs = computed(() => logs.value
  .filter(log => String(log.accountId || '') === currentAccountId.value)
  .sort((a, b) => (Number(b.ts) || Date.parse(b.time) || 0) - (Number(a.ts) || Date.parse(a.time) || 0))
  .slice(0, 3))

function formatNumber(value: unknown): string {
  const number = Number(value) || 0
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(number)
}

function markVisited(key: 'farm' | 'ranch') {
  if (key === 'farm') {
    localStorage.setItem(storageKey('visited_farm_v1'), '1')
    visitedFarm.value = true
  }
  else {
    localStorage.setItem(storageKey('visited_ranch_v1'), '1')
    visitedRanch.value = true
  }
}

function goFarm() {
  markVisited('farm')
  router.push('/personal')
}

function goFarmOverview() {
  router.push('/')
}

function goRanch() {
  markVisited('ranch')
  router.push('/ranch')
}

function openAccountModal() {
  editingAccount.value = null
  showAccountModal.value = true
}

function reloginAccount() {
  if (!currentAccount.value)
    return
  editingAccount.value = currentAccount.value
  showAccountModal.value = true
}

async function handleAccountSaved() {
  showAccountModal.value = false
  editingAccount.value = null
  await accountStore.fetchAccounts()
  if (currentAccountId.value)
    await refreshCurrentAccount()
}

async function startAccount() {
  if (!currentAccount.value?.id)
    return openAccountModal()
  if (actionLoading.value)
    return
  if (needsCode.value)
    return reloginAccount()
  const id = String(currentAccount.value.id)
  actionLoading.value = true
  try {
    await accountStore.startAccount(id)
    if (id === currentAccountId.value)
      toast.success('账号已启动，正在连接游戏')
  }
  catch (error: any) {
    if (error?.response?.data?.errorType === 'relogin_required') {
      await accountStore.fetchAccounts()
      if (id === currentAccountId.value)
        reloginAccount()
      return
    }
    toast.error(error?.message || '启动失败')
  }
  finally {
    actionLoading.value = false
  }
}

async function stopAccount() {
  if (!currentAccountId.value || actionLoading.value)
    return
  actionLoading.value = true
  try {
    await accountStore.stopAccount(currentAccountId.value)
    toast.success('已停止托管')
  }
  catch (error: any) {
    toast.error(error?.message || '停止托管失败')
  }
  finally {
    actionLoading.value = false
  }
}

function requestHarvest() {
  if (!currentAccount.value?.id)
    return openAccountModal()
  confirmConfig.value = {
    show: true,
    title: '一键收菜',
    message: `确定要收获 ${accountName.value} 当前所有成熟作物吗？`,
    accountId: String(currentAccount.value.id),
  }
}

async function confirmAction() {
  const id = confirmConfig.value.accountId
  if (actionLoading.value || !id || id !== currentAccountId.value)
    return
  actionLoading.value = true
  try {
    const result = await farmStore.operate(id, 'harvest')
    if (id === currentAccountId.value && result)
      toast.success(result.hadWork ? '成熟作物已收获' : '当前没有可收获的作物')
  }
  catch (error: any) {
    toast.error(error?.message || '收获失败')
  }
  finally {
    actionLoading.value = false
    confirmConfig.value.show = false
  }
}

function handleTask(action: string) {
  if (action === 'account')
    return openAccountModal()
  if (action === 'start')
    return startAccount()
  if (action === 'ranch')
    return goRanch()
  if (action === 'harvest')
    return requestHarvest()
  return goFarm()
}

function handleChecklistAction(action: string) {
  if (action === 'account')
    return openAccountModal()
  if (action === 'start')
    return startAccount()
  if (action === 'ranch')
    return goRanch()
  return goFarm()
}

function dismissChecklist() {
  checklistDismissed.value = true
  localStorage.setItem(storageKey('home_checklist_dismissed_v1'), '1')
}

function finishWelcome() {
  welcomeVisible.value = false
  localStorage.setItem(storageKey('welcome_v1_done'), '1')
}

async function refreshCurrentAccount() {
  const id = String(currentAccountId.value || '')
  if (!id || !currentAccountConnected.value)
    return
  await Promise.allSettled([
    farmStore.fetchLands(id),
    ranchStore.load(id, 'animals'),
    statusStore.fetchDiamond(id),
  ])
}

watch(currentAccountId, () => {
  confirmConfig.value.show = false
  farmStore.resetLandState()
  ranchStore.reset()
}, { immediate: true, flush: 'sync' })
watch(currentAccountConnected, (connected) => {
  if (connected)
    void refreshCurrentAccount()
}, { immediate: true })

onMounted(() => {
  if (userStore.isTenant && localStorage.getItem(storageKey('welcome_v1_done')) !== '1')
    welcomeVisible.value = true
})
</script>

<template>
  <div class="home-page page-stack flex flex-col gap-4">
    <section class="hero-card farm-card rounded-2xl p-5 sm:p-6">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div class="text-xs text-gray-500 dark:text-gray-400">
            {{ todayLabel }}
          </div>
          <h1 class="mt-1 text-2xl text-gray-900 font-bold dark:text-gray-100">
            {{ greeting }}，{{ userStore.username || '朋友' }}
          </h1>
          <div class="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span class="hero-pill">{{ hasAccount ? accountName : '还没有添加游戏账号' }}</span>
            <span v-if="hasAccount" class="hero-pill" :class="{ 'hero-pill--on': currentPhase === 'online' }">
              {{ hostingLabel(currentPhase) }}
            </span>
            <span v-if="realtimeConnected" class="hero-pill">实时连接正常</span>
          </div>
        </div>
        <div class="flex flex-wrap gap-2">
          <BaseButton variant="primary" size="sm" @click="openAccountModal">
            <span class="i-carbon-add" />
            添加账号
          </BaseButton>
          <BaseButton v-if="showStart" variant="secondary" size="sm" :loading="actionLoading" @click="startAccount">
            {{ needsCode ? '重新登录' : currentPhase === 'offline' ? '重试连接' : '启动托管' }}
          </BaseButton>
          <BaseButton v-if="currentHosting?.runEnabled" variant="ghost" size="sm" :loading="actionLoading" @click="stopAccount">
            停止托管
          </BaseButton>
        </div>
      </div>
    </section>

    <section v-if="showExpiry && expiresAt" class="flex flex-wrap items-center justify-between gap-3 farm-card rounded-xl p-4" aria-label="租户有效期">
      <div>
        <div class="text-sm font-semibold">
          {{ remaining <= 0 ? '使用期限已到期' : '使用期限即将到期' }}
        </div>
        <div class="mt-1 text-xs text-gray-500">
          到期时间 {{ formatTime(expiresAt) }}
        </div>
      </div>
      <BaseButton variant="secondary" size="sm" :to="remaining <= 0 ? '/renew?expired=1' : '/renew'">
        使用续费码
      </BaseButton>
    </section>

    <section v-if="showChecklist" class="farm-card rounded-2xl p-4 sm:p-5">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 class="text-base text-gray-900 font-bold dark:text-gray-100">
            开始使用
          </h2>
          <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            完成这几步，农场和牧场就会自动运转起来
          </p>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-xs text-gray-500">{{ checklistDone }} / {{ checklist.length }}</span>
          <button type="button" class="text-xs text-gray-400 hover:text-gray-600" @click="dismissChecklist">
            不再显示
          </button>
        </div>
      </div>
      <div class="grid grid-cols-1 mt-4 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <div
          v-for="(step, index) in checklist"
          :key="step.key"
          class="checklist-step"
          :class="{ 'checklist-step--done': step.done }"
        >
          <div class="checklist-step__index">
            <span v-if="step.done" class="i-carbon-checkmark" />
            <span v-else>{{ index + 1 }}</span>
          </div>
          <div class="min-w-0 flex-1">
            <div class="checklist-step__title">
              {{ step.title }}
            </div>
            <p class="checklist-step__desc">
              {{ step.description }}
            </p>
            <button
              v-if="!step.done"
              type="button"
              class="checklist-step__action"
              @click="handleChecklistAction(step.action)"
            >
              {{ step.actionLabel }} →
            </button>
          </div>
        </div>
      </div>
    </section>

    <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <section class="game-card farm-card rounded-2xl p-5">
        <div class="flex items-start justify-between gap-3">
          <div>
            <div class="game-card__kicker">
              农场
            </div>
            <h2 class="mt-1 text-xl text-gray-900 font-bold dark:text-gray-100">
              {{ !hasAccount ? '添加账号后开始' : harvestable > 0 ? `${harvestable} 块地可以收获` : '农场正在生长' }}
            </h2>
            <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {{ landCount ? `${landCount} 块土地 · ${growing} 块生长中 · ${emptyLands} 块空闲` : '添加账号后会自动读取土地状态' }}
            </p>
          </div>
          <div class="game-card__icon i-carbon-sprout" />
        </div>
        <div class="mt-4 flex flex-wrap gap-2">
          <BaseButton variant="primary" size="sm" :disabled="!hasAccount || !harvestable" :loading="actionLoading" @click="requestHarvest">
            一键收菜
          </BaseButton>
          <BaseButton variant="secondary" size="sm" @click="goFarm">
            进入农场
          </BaseButton>
        </div>
      </section>

      <section class="game-card game-card--ranch farm-card rounded-2xl p-5">
        <div class="flex items-start justify-between gap-3">
          <div>
            <div class="game-card__kicker">
              牧场
            </div>
            <h2 class="mt-1 text-xl text-gray-900 font-bold dark:text-gray-100">
              {{ !hasAccount ? '添加账号后开始' : ranchCanFeed > 0 ? `${ranchCanFeed} 只动物可以喂养` : '牧场状态平稳' }}
            </h2>
            <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {{ ranchLoading ? '正在读取牧场状态…' : ranchAnimals.length ? `${ranchAnimals.length} 只动物 · ${ranchCanHarvest} 只可收获` : '进入牧场查看动物与设施' }}
            </p>
          </div>
          <div class="game-card__icon i-carbon-pet-image-o" />
        </div>
        <div class="mt-4 flex flex-wrap gap-2">
          <BaseButton variant="secondary" size="sm" @click="goRanch">
            进入牧场
          </BaseButton>
        </div>
      </section>
    </div>

    <div class="grid grid-cols-1 gap-4 xl:grid-cols-[1.1fr_0.9fr]">
      <section class="farm-card rounded-2xl p-5">
        <div class="flex items-center justify-between gap-2">
          <h2 class="text-base text-gray-900 font-bold dark:text-gray-100">
            今日待办
          </h2>
          <span class="text-xs text-gray-500">{{ tasks.length }} 项</span>
        </div>
        <div class="mt-3 space-y-2">
          <div v-for="task in tasks" :key="task.key" class="todo-row">
            <span class="todo-row__dot" />
            <span class="min-w-0 flex-1 text-sm">{{ task.text }}</span>
            <button type="button" class="todo-row__action" @click="handleTask(task.action)">
              {{ task.label }}
            </button>
          </div>
        </div>
      </section>

      <section class="farm-card rounded-2xl p-5">
        <div class="flex items-center justify-between gap-2">
          <h2 class="text-base text-gray-900 font-bold dark:text-gray-100">
            我的账号
          </h2>
          <BaseButton variant="text" size="sm" @click="openAccountModal">
            添加
          </BaseButton>
        </div>
        <div v-if="hasAccount" class="mt-3">
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              <div class="truncate text-sm font-medium">
                {{ accountName }}
              </div>
              <div class="mt-0.5 text-xs text-gray-500">
                <span v-if="level">Lv.{{ level }} · </span>{{ hostingLabel(currentPhase) }}
              </div>
            </div>
            <BaseButton v-if="showStart" variant="secondary" size="sm" :loading="actionLoading" @click="startAccount">
              {{ needsCode ? '重新登录' : currentPhase === 'offline' ? '重试' : '启动' }}
            </BaseButton>
          </div>
          <p v-if="lastIssue || needsCode" class="mt-3 border rounded-lg px-3 py-2 text-xs text-gray-600 dark:text-gray-300">
            {{ lastIssue ? issueLabels[lastIssue.reason] : '当前没有可用的登录 Code，请重新扫码或输入新的 Code。' }}
            <span v-if="needsCode && (lastIssue?.reason === 'disconnected' || lastIssue?.reason === 'worker_failed')"> 请更新登录 Code 后重试。</span>
            <time v-if="lastIssue" class="block pt-1 text-gray-500">{{ formatTime(lastIssue.at) }}</time>
          </p>
          <div class="grid grid-cols-2 mt-4 gap-2">
            <div class="stat-tile">
              <span class="stat-tile__label">金币</span>
              <strong class="stat-tile__value">{{ formatNumber(gold) }}</strong>
            </div>
            <div class="stat-tile">
              <span class="stat-tile__label">钻石</span>
              <strong class="stat-tile__value">{{ formatNumber(diamond) }}</strong>
            </div>
          </div>
        </div>
        <div v-else class="mt-4 border rounded-xl border-dashed p-6 text-center dark:border-gray-700">
          <div class="text-sm text-gray-500">
            还没有游戏账号
          </div>
          <BaseButton class="mt-3" variant="primary" size="sm" @click="openAccountModal">
            添加游戏账号
          </BaseButton>
        </div>
      </section>
    </div>

    <section v-if="recentLogs.length" class="farm-card rounded-2xl p-5">
      <div class="flex items-center justify-between gap-2">
        <h2 class="text-base text-gray-900 font-bold dark:text-gray-100">
          最近动态
        </h2>
        <button type="button" class="text-xs text-gray-400 hover:text-gray-600" @click="goFarmOverview">
          查看全部
        </button>
      </div>
      <div class="mt-3 space-y-2">
        <div v-for="(log, index) in recentLogs" :key="index" class="log-row">
          <span class="log-row__time">{{ log.time }}</span>
          <span class="min-w-0 flex-1 truncate">{{ log.msg }}</span>
        </div>
      </div>
    </section>

    <AccountModal :show="showAccountModal" :edit-data="editingAccount" @close="showAccountModal = false" @saved="handleAccountSaved" />
    <ConfirmModal
      :show="confirmConfig.show"
      :title="confirmConfig.title"
      :message="confirmConfig.message"
      confirm-text="确认收获"
      :loading="actionLoading"
      @confirm="confirmAction"
      @cancel="confirmConfig.show = false"
    />

    <NModal :show="welcomeVisible" :mask-closable="false" @update:show="value => !value && finishWelcome()">
      <NCard class="welcome-card" role="dialog" aria-modal="true" :bordered="false">
        <div class="text-center">
          <div class="welcome-icon i-carbon-sprout" />
          <h2 class="mt-3 text-xl text-gray-900 font-bold dark:text-gray-100">
            欢迎使用农场助手
          </h2>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            三步就能开始：添加账号 → 启动托管 → 去收菜
          </p>
        </div>
        <div class="mt-5 space-y-2">
          <div class="welcome-step">
            <span class="welcome-step__num">1</span>
            <div>
              <strong>添加游戏账号</strong>
              <p>支持 QQ / 微信扫码，也可以粘贴 Code</p>
            </div>
          </div>
          <div class="welcome-step">
            <span class="welcome-step__num">2</span>
            <div>
              <strong>启动自动托管</strong>
              <p>加入账号后自动启动，收菜和好友巡查会按策略执行</p>
            </div>
          </div>
          <div class="welcome-step">
            <span class="welcome-step__num">3</span>
            <div>
              <strong>去农场和牧场</strong>
              <p>首页会显示成熟土地和待喂养动物，点一下就能处理</p>
            </div>
          </div>
        </div>
        <div class="mt-5 flex justify-end gap-2">
          <BaseButton variant="secondary" size="sm" @click="finishWelcome">
            先看看
          </BaseButton>
          <BaseButton variant="primary" size="sm" @click="finishWelcome(); openAccountModal()">
            开始添加账号
          </BaseButton>
        </div>
      </NCard>
    </NModal>
  </div>
</template>

<style scoped>
.home-page {
  max-width: 1480px;
  margin-inline: auto;
}

.hero-card {
  position: relative;
  overflow: hidden;
  background:
    radial-gradient(120% 150% at 100% 0%, rgba(var(--ui-primary-rgb), 0.12), transparent 55%), var(--ui-surface);
}

.hero-card::after {
  position: absolute;
  right: -40px;
  bottom: -70px;
  width: 210px;
  height: 210px;
  border-radius: 50%;
  background: rgba(var(--ui-primary-rgb), 0.08);
  content: '';
}

.hero-pill {
  display: inline-flex;
  align-items: center;
  padding: 3px 9px;
  border-radius: 999px;
  color: var(--ui-muted);
  background: var(--ui-surface-soft);
  font-size: 11px;
}

.hero-pill--on {
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
}

.checklist-step {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--ui-border);
  border-radius: 12px;
  background: var(--ui-surface-soft);
}

.checklist-step--done {
  opacity: 0.68;
}

.checklist-step__index {
  display: grid;
  width: 24px;
  height: 24px;
  flex: none;
  place-items: center;
  border-radius: 8px;
  color: var(--ui-primary-on-fill);
  background: var(--ui-primary-fill);
  font-size: 12px;
  font-weight: 700;
}

.checklist-step--done .checklist-step__index {
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
}

.checklist-step__title {
  color: var(--ui-ink);
  font-size: 13px;
  font-weight: 600;
}

.checklist-step__desc {
  margin: 3px 0 0;
  color: var(--ui-muted);
  font-size: 11px;
  line-height: 1.5;
}

.checklist-step__action {
  margin-top: 6px;
  padding: 0;
  border: 0;
  color: var(--ui-primary);
  background: transparent;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}

.game-card {
  position: relative;
  overflow: hidden;
}

.game-card--ranch {
  background:
    radial-gradient(120% 120% at 100% 0%, rgba(var(--ui-teal-rgb, 47, 133, 124), 0.12), transparent 55%),
    var(--ui-surface);
}

.game-card__kicker {
  color: var(--ui-primary);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.game-card__icon {
  color: var(--ui-primary);
  font-size: 34px;
  opacity: 0.85;
}

.todo-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 10px;
  border-radius: 9px;
  background: var(--ui-surface-soft);
}

.todo-row__dot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: var(--ui-primary);
}

.todo-row__action {
  padding: 0;
  border: 0;
  color: var(--ui-primary);
  background: transparent;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}

.stat-tile {
  padding: 10px;
  border-radius: 10px;
  background: var(--ui-surface-soft);
}

.stat-tile__label {
  display: block;
  color: var(--ui-muted);
  font-size: 11px;
}

.stat-tile__value {
  display: block;
  margin-top: 2px;
  color: var(--ui-ink);
  font-size: 18px;
}

.log-row {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--ui-muted);
  font-size: 12px;
}

.log-row__time {
  flex: none;
  color: var(--ui-subtle);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
}

.welcome-card {
  width: min(460px, calc(100vw - 32px));
}

.welcome-icon {
  display: inline-grid;
  width: 54px;
  height: 54px;
  place-items: center;
  border-radius: 18px;
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
  font-size: 28px;
}

.welcome-step {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--ui-surface-soft);
}

.welcome-step__num {
  display: grid;
  width: 22px;
  height: 22px;
  flex: none;
  place-items: center;
  border-radius: 7px;
  color: var(--ui-primary-on-fill);
  background: var(--ui-primary-fill);
  font-size: 11px;
  font-weight: 700;
}

.welcome-step strong {
  color: var(--ui-ink);
  font-size: 13px;
}

.welcome-step p {
  margin: 2px 0 0;
  color: var(--ui-muted);
  font-size: 11px;
  line-height: 1.5;
}
</style>
