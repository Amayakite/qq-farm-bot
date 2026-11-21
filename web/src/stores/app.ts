import { usePreferredDark, useStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { DEFAULT_BRAND_COLOR, deriveBrandPalette, normalizeHex } from '@/utils/brand-color'

export type ThemeMode = 'system' | 'light' | 'dark'

export const useAppStore = defineStore('app', () => {
  const sidebarOpen = ref(false)
  // 活动详情有自己的标题栏，打开时布局隐藏通用页头并让活动外壳撑满内容区。
  const activityDetailOpen = ref(false)
  const spaceSwitching = ref(false)
  const sidebarCollapsed = useStorage('sidebar_collapsed', false)
  // 默认跟随系统；index.html 中的内联脚本在首屏渲染前读取同一个键，避免闪烁。
  const themeMode = useStorage<ThemeMode>('theme_mode', 'system')
  // 品牌色由 owner 统一配置，缓存到本地用于首屏和无网启动。
  const brandColor = useStorage('brand_color', DEFAULT_BRAND_COLOR)
  const brandPreset = useStorage('brand_preset', 'ocean')
  const preferredDark = usePreferredDark()
  const isDark = computed(() => themeMode.value === 'dark' || (themeMode.value === 'system' && preferredDark.value))

  function applyBrand(color: unknown, preset?: unknown) {
    brandColor.value = normalizeHex(color)
    if (preset)
      brandPreset.value = String(preset)
  }

  function applyPaletteToDocument() {
    if (typeof document === 'undefined')
      return
    const palette = deriveBrandPalette(brandColor.value, isDark.value)
    const root = document.documentElement
    root.style.setProperty('--ui-primary', palette.primary)
    root.style.setProperty('--ui-primary-hover', palette.primaryHover)
    root.style.setProperty('--ui-primary-pressed', palette.primaryPressed)
    root.style.setProperty('--ui-primary-soft', palette.soft)
    root.style.setProperty('--ui-primary-fill', palette.fill)
    root.style.setProperty('--ui-primary-rgb', palette.rgb)
    root.style.setProperty('--ui-primary-on-fill', palette.onFill)
    root.style.setProperty('--theme-primary', palette.primary)
    root.style.setProperty('--theme-primary-rgb', palette.rgb)
    root.style.setProperty('--theme-secondary', palette.secondary)
    root.style.setProperty('--theme-secondary-rgb', palette.secondaryRgb)
    root.style.setProperty('--ui-teal', palette.secondary)
    root.style.setProperty('--ui-teal-rgb', palette.secondaryRgb)
  }

  watch(isDark, (dark) => {
    const root = document.documentElement
    root.classList.toggle('dark', dark)
    root.style.colorScheme = dark ? 'dark' : 'light'
    applyPaletteToDocument()
  }, { immediate: true })

  watch(brandColor, () => {
    applyPaletteToDocument()
  })

  function setThemeMode(mode: ThemeMode) {
    themeMode.value = mode
  }

  function toggleSidebar() {
    sidebarOpen.value = !sidebarOpen.value
  }

  function closeSidebar() {
    sidebarOpen.value = false
  }

  function openSidebar() {
    sidebarOpen.value = true
  }

  function toggleSidebarCollapsed() {
    sidebarCollapsed.value = !sidebarCollapsed.value
  }

  return {
    themeMode,
    isDark,
    brandColor,
    brandPreset,
    applyBrand,
    applyPaletteToDocument,
    setThemeMode,
    sidebarOpen,
    sidebarCollapsed,
    activityDetailOpen,
    spaceSwitching,
    toggleSidebar,
    closeSidebar,
    openSidebar,
    toggleSidebarCollapsed,
  }
})
