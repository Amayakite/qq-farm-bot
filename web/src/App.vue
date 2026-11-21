<script setup lang="ts">
import { NConfigProvider } from 'naive-ui/es/config-provider'
import { NDialogProvider } from 'naive-ui/es/dialog'
import { NGlobalStyle } from 'naive-ui/es/global-style'
import { dateZhCN, zhCN } from 'naive-ui/es/locales'
import { NMessageProvider } from 'naive-ui/es/message'
import { NNotificationProvider } from 'naive-ui/es/notification'
import { darkTheme } from 'naive-ui/es/themes'
import { storeToRefs } from 'pinia'
import { computed, onMounted } from 'vue'
import { RouterView } from 'vue-router'
import ToastContainer from '@/components/ToastContainer.vue'
import { useAppStore } from '@/stores/app'
import { usePublicConfigStore } from '@/stores/public-config'
import { createNaiveThemeOverrides } from '@/ui/naive-theme'

const appStore = useAppStore()
const publicConfig = usePublicConfigStore()
const { isDark, brandColor } = storeToRefs(appStore)
const themeOverrides = computed(() => createNaiveThemeOverrides(isDark.value, brandColor.value))

onMounted(() => {
  publicConfig.fetchConfig()
})
</script>

<template>
  <NConfigProvider
    :theme="isDark ? darkTheme : null"
    :theme-overrides="themeOverrides"
    :locale="zhCN"
    :date-locale="dateZhCN"
  >
    <NGlobalStyle />
    <NMessageProvider placement="top-right" :max="4" keep-alive-on-hover>
      <NDialogProvider>
        <NNotificationProvider placement="top-right" :max="4">
          <div class="app-shell h-screen w-screen overflow-hidden">
            <RouterView />
            <ToastContainer />
          </div>
        </NNotificationProvider>
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>
