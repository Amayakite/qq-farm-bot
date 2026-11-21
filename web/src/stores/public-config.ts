import axios from 'axios'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useAppStore } from '@/stores/app'

export interface PublicConfig {
  hideUpstreamLinks: boolean
  siteName: string
  registrationEnabled: boolean
  redeemEnabled: boolean
  brandColor: string
  brandPreset: string
}

let inflight: Promise<void> | null = null

export const usePublicConfigStore = defineStore('public-config', () => {
  const hideUpstreamLinks = ref(false)
  const siteName = ref('QQ农场智能助手')
  const registrationEnabled = ref(true)
  const redeemEnabled = ref(true)
  const brandColor = ref('#2f6f9f')
  const brandPreset = ref('ocean')
  const loaded = ref(false)

  function apply(data: Partial<PublicConfig> | undefined) {
    if (!data)
      return
    hideUpstreamLinks.value = data.hideUpstreamLinks === true
    if (data.siteName) {
      siteName.value = String(data.siteName)
      document.title = siteName.value
    }
    registrationEnabled.value = data.registrationEnabled !== false
    redeemEnabled.value = data.redeemEnabled !== false
    if (data.brandColor) {
      brandColor.value = data.brandColor
      brandPreset.value = data.brandPreset || 'custom'
      useAppStore().applyBrand(data.brandColor, brandPreset.value)
    }
  }

  async function fetchConfig(force = false) {
    if (loaded.value && !force)
      return
    if (inflight)
      return inflight
    inflight = axios.get('/api/public-config', { timeout: 6000 })
      .then((res) => {
        if (res.data?.ok)
          apply(res.data.data)
      })
      .catch(() => {
        // 面板配置读取失败时保留默认品牌，不阻塞登录。
      })
      .finally(() => {
        loaded.value = true
        inflight = null
      })
    return inflight
  }

  return {
    hideUpstreamLinks,
    siteName,
    registrationEnabled,
    redeemEnabled,
    brandColor,
    brandPreset,
    loaded,
    fetchConfig,
    apply,
  }
})
