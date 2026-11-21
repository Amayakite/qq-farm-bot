<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BrandMark from '@/components/ui/BrandMark.vue'
import { usePublicConfigStore } from '@/stores/public-config'
import { useUserStore } from '@/stores/user'

const props = defineProps<{
  mode: 'redeem' | 'renew'
}>()

const userStore = useUserStore()
const publicConfig = usePublicConfigStore()
const route = useRoute()

const code = ref('')
const username = ref('')
const password = ref('')
const confirmPassword = ref('')
const loading = ref(false)
const error = ref('')
const success = ref('')
const expiredNotice = computed(() => route.query.expired === '1')

const subtitle = computed(() => props.mode === 'redeem'
  ? '使用激活码创建你的独立账号'
  : '续费码会累加到当前到期时间')
const submitText = computed(() => props.mode === 'redeem' ? '激活并登录' : '续费并登录')

function validate(): boolean {
  if (!code.value.trim()) {
    error.value = props.mode === 'redeem' ? '请输入激活码' : '请输入续费码'
    return false
  }
  if (!username.value.trim()) {
    error.value = '请输入用户名'
    return false
  }
  if (username.value.trim().length < 3) {
    error.value = '用户名至少 3 位'
    return false
  }
  if (!/^\w+$/.test(username.value.trim())) {
    error.value = '用户名只能包含字母、数字和下划线'
    return false
  }
  if (!password.value) {
    error.value = '请输入密码'
    return false
  }
  if (props.mode === 'redeem') {
    if (password.value.length < 6) {
      error.value = '密码至少 6 位'
      return false
    }
    if (!/[A-Z]/i.test(password.value) || !/\d/.test(password.value)) {
      error.value = '密码需同时包含字母和数字'
      return false
    }
    if (password.value !== confirmPassword.value) {
      error.value = '两次输入的密码不一致'
      return false
    }
  }
  return true
}

async function handleSubmit() {
  if (!validate())
    return
  loading.value = true
  error.value = ''
  success.value = ''
  const action = props.mode === 'redeem'
    ? userStore.redeem(code.value.trim(), username.value.trim(), password.value)
    : userStore.renew(code.value.trim(), username.value.trim(), password.value)
  const result = await action
  loading.value = false
  if (!result.ok) {
    error.value = result.error || (props.mode === 'redeem' ? '激活失败' : '续费失败')
    return
  }
  success.value = props.mode === 'redeem' ? '激活成功，正在进入面板…' : '续费成功，正在进入面板…'
  setTimeout(() => {
    window.location.href = '/'
  }, 600)
}

onMounted(() => {
  publicConfig.fetchConfig()
})
</script>

<template>
  <main class="credential-page">
    <section class="credential-card">
      <header class="logo-area">
        <BrandMark class="logo-icon" :size="56" />
        <div>
          <span class="logo-kicker">QQ FARM</span>
          <h1 class="logo-title">
            {{ publicConfig.siteName }}
          </h1>
          <p class="logo-subtitle">
            {{ subtitle }}
          </p>
        </div>
      </header>

      <div v-if="mode === 'redeem'" class="notice">
        激活码有效期从兑换成功时开始计算；请牢记用户名和密码。
      </div>
      <div v-if="expiredNotice && mode === 'renew'" class="notice">
        当前账号已到期，续费后会立即恢复访问。
      </div>

      <form class="form-area" @submit.prevent="handleSubmit">
        <BaseInput
          v-model="code"
          :label="mode === 'redeem' ? '激活码' : '续费码'"
          type="text"
          :placeholder="mode === 'redeem' ? 'QF-XXXX-XXXX-XXXX-XXXX' : '请输入续费码'"
          autocomplete="off"
          required
        />
        <BaseInput
          v-model="username"
          label="用户名"
          type="text"
          placeholder="3-32 位字母、数字或下划线"
          autocomplete="username"
          required
        />
        <BaseInput
          v-model="password"
          label="密码"
          type="password"
          :placeholder="mode === 'redeem' ? '至少 6 位，需包含字母和数字' : '当前登录密码'"
          :autocomplete="mode === 'redeem' ? 'new-password' : 'current-password'"
          required
        />
        <BaseInput
          v-if="mode === 'redeem'"
          v-model="confirmPassword"
          label="确认密码"
          type="password"
          placeholder="再次输入密码"
          autocomplete="new-password"
          required
        />

        <div v-if="error" class="message error-message" role="alert">
          <span class="i-carbon-warning-alt" />
          <div>{{ error }}</div>
        </div>
        <div v-if="success" class="message success-message" role="status">
          <span class="i-carbon-checkmark-filled" />
          {{ success }}
        </div>

        <BaseButton type="submit" variant="primary" block :loading="loading">
          <span v-if="!loading" class="inline-flex items-center gap-2">
            <span class="i-carbon-password" />
            {{ submitText }}
          </span>
        </BaseButton>
      </form>

      <footer class="card-footer">
        <RouterLink class="back-link" to="/login">
          返回登录
        </RouterLink>
        <RouterLink v-if="mode === 'redeem'" class="back-link" to="/renew">
          已有续费码
        </RouterLink>
        <RouterLink v-else class="back-link" to="/redeem">
          使用激活码注册
        </RouterLink>
      </footer>
    </section>
  </main>
</template>

<style scoped>
.credential-page {
  position: relative;
  display: grid;
  width: 100%;
  min-height: 100dvh;
  place-items: center;
  overflow: hidden;
  padding: 28px 18px;
  color: var(--ui-ink);
  background-color: var(--ui-bg);
  background-image:
    linear-gradient(rgba(67, 141, 99, 0.045) 1px, transparent 1px),
    linear-gradient(90deg, rgba(67, 141, 99, 0.045) 1px, transparent 1px);
  background-size: 42px 42px;
}

.credential-page::before {
  position: absolute;
  inset: 8% 7%;
  border: 1px solid rgba(67, 141, 99, 0.08);
  border-radius: 36px;
  background: color-mix(in srgb, var(--ui-surface-strong) 22%, transparent);
  content: '';
}

.credential-card {
  position: relative;
  z-index: 1;
  width: min(430px, 100%);
  padding: 30px;
  border: 1px solid var(--ui-border);
  border-radius: 20px;
  background: var(--ui-surface-strong);
  box-shadow: 0 24px 70px rgba(27, 45, 34, 0.16);
}

.logo-area {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 20px;
}

.logo-kicker {
  color: var(--ui-primary);
  font-size: 10px;
  font-weight: var(--fw-700);
  letter-spacing: 0.18em;
}

.logo-title {
  margin: 2px 0 0;
  font-size: 20px;
  line-height: 1.25;
}

.logo-subtitle {
  margin: 4px 0 0;
  color: var(--ui-muted);
  font-size: 12px;
}

.notice {
  margin-bottom: 14px;
  padding: 10px 12px;
  border: 1px solid rgba(67, 141, 99, 0.16);
  border-radius: 10px;
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
  font-size: 12px;
  line-height: 1.6;
}

.form-area {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.message {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid transparent;
  border-radius: 9px;
  font-size: 12px;
  line-height: 1.6;
}

.error-message {
  border-color: rgba(201, 95, 102, 0.18);
  color: var(--ui-danger);
  background: var(--ui-danger-soft);
}

.success-message {
  border-color: rgba(67, 141, 99, 0.18);
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
}

.card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 20px;
  padding-top: 15px;
  border-top: 1px solid var(--ui-border);
}

.back-link {
  color: var(--ui-muted);
  font-size: 12px;
  text-decoration: none;
}

.back-link:hover {
  color: var(--ui-primary);
}

@media (max-width: 480px) {
  .credential-page {
    padding: 16px 12px;
  }

  .credential-page::before {
    inset: 4%;
    border-radius: 24px;
  }

  .credential-card {
    padding: 24px 20px;
    border-radius: 16px;
  }
}
</style>
