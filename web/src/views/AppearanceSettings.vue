<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import { useAppStore } from '@/stores/app'
import { useToastStore } from '@/stores/toast'
import { BRAND_PRESETS, DEFAULT_BRAND_COLOR, deriveBrandPalette, normalizeHex, presetIdForColor } from '@/utils/brand-color'

const appStore = useAppStore()
const toast = useToastStore()
const selected = ref(normalizeHex(appStore.brandColor))
const customDraft = ref(selected.value)
const saving = ref(false)
const editing = ref(false)
const showCustom = ref(!BRAND_PRESETS.some(preset => preset.color.toLowerCase() === selected.value.toLowerCase()))
const invalidColor = computed(() => showCustom.value && !/^#?(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(customDraft.value))

const palette = computed(() => deriveBrandPalette(selected.value, appStore.isDark))
const selectedPreset = computed(() => presetIdForColor(selected.value))

function choosePreset(color: string) {
  editing.value = true
  selected.value = color
  showCustom.value = false
}

function chooseCustom() {
  editing.value = true
  showCustom.value = true
  customDraft.value = selected.value
}

function updateCustom(value: string | number | undefined) {
  const raw = String(value || '').trim()
  customDraft.value = raw
  if (!invalidColor.value)
    selected.value = normalizeHex(`#${raw.replace(/^#/, '')}`)
}

function resetDefault() {
  choosePreset(DEFAULT_BRAND_COLOR)
}

async function save() {
  if (saving.value || invalidColor.value)
    return
  saving.value = true
  try {
    const { data } = await api.post('/api/settings/appearance', {
      brandColor: selected.value,
      brandPreset: selectedPreset.value,
    })
    if (data?.ok) {
      appStore.applyBrand(data.data.brandColor, data.data.brandPreset)
      editing.value = false
      toast.success('主题色已应用到所有用户')
    }
    else {
      toast.error(getApiErrorMessage(data, '保存失败'))
    }
  }
  catch (error: any) {
    toast.error(getApiErrorMessage(error, '保存失败'))
  }
  finally {
    saving.value = false
  }
}

watch(() => appStore.brandColor, (color) => {
  if (!editing.value) {
    selected.value = normalizeHex(color)
    customDraft.value = selected.value
    showCustom.value = presetIdForColor(selected.value) === 'custom'
  }
})
</script>

<template>
  <div class="appearance-page space-y-4">
    <div>
      <p class="text-xs text-gray-500 dark:text-gray-400">
        品牌色会应用到所有用户的面板、按钮、链接和强调色；明暗模式仍由每个用户自己选择。
      </p>
    </div>

    <div class="grid grid-cols-1 gap-4 xl:grid-cols-[1.15fr_0.85fr]">
      <section class="farm-card rounded-lg p-5">
        <h3 class="text-base text-gray-900 font-bold dark:text-gray-100">
          主题色
        </h3>
        <div class="grid grid-cols-2 mt-4 gap-2 sm:grid-cols-4">
          <button
            v-for="preset in BRAND_PRESETS"
            :key="preset.id"
            type="button"
            :disabled="saving"
            class="palette-swatch"
            :class="{ 'palette-swatch--active': !showCustom && selectedPreset === preset.id }"
            :aria-pressed="!showCustom && selectedPreset === preset.id"
            @click="choosePreset(preset.color)"
          >
            <span class="palette-swatch__dot" :style="{ background: preset.color }" />
            <span class="palette-swatch__label">{{ preset.label }}</span>
          </button>
          <button
            type="button"
            :disabled="saving"
            class="palette-swatch"
            :class="{ 'palette-swatch--active': showCustom }"
            :aria-pressed="showCustom"
            @click="chooseCustom"
          >
            <span class="palette-swatch__dot palette-swatch__dot--custom" />
            <span class="palette-swatch__label">自定义</span>
          </button>
        </div>

        <div v-if="showCustom" class="mt-4 flex flex-wrap items-end gap-3">
          <input
            type="color"
            :disabled="saving"
            class="h-10 w-14 cursor-pointer border-0 rounded-lg bg-transparent p-0"
            :value="selected"
            aria-label="选择自定义颜色"
            @input="updateCustom(($event.target as HTMLInputElement).value)"
          >
          <div class="min-w-40 flex-1">
            <BaseInput
              :model-value="customDraft"
              :disabled="saving"
              label="Hex 颜色"
              type="text"
              placeholder="#2f6f9f"
              @update:model-value="updateCustom"
            />
            <p v-if="invalidColor" class="mt-1 text-xs text-red-600 dark:text-red-400" role="alert">
              请输入 3 位或 6 位 Hex 颜色，例如 #2f6f9f。
            </p>
          </div>
        </div>

        <div class="mt-5 flex flex-wrap items-center justify-between gap-2 border-t pt-4 dark:border-gray-700">
          <BaseButton variant="secondary" size="sm" :disabled="saving" @click="resetDefault">
            恢复默认
          </BaseButton>
          <BaseButton variant="primary" size="sm" :loading="saving" :disabled="invalidColor" @click="save">
            应用到所有用户
          </BaseButton>
        </div>
      </section>

      <section class="farm-card rounded-lg p-5">
        <h3 class="text-base text-gray-900 font-bold dark:text-gray-100">
          实时预览
        </h3>
        <div class="mt-4 space-y-3">
          <div class="preview-card rounded-xl p-4">
            <div class="text-xs text-gray-500">
              品牌主色
            </div>
            <div class="mt-1 text-xl font-bold" :style="{ color: palette.primary }">
              今日农场概览
            </div>
            <div class="mt-3 flex flex-wrap gap-2">
              <button type="button" class="preview-button" :style="{ background: palette.fill, color: palette.onFill }">
                一键收菜
              </button>
              <button type="button" class="preview-button preview-button--soft" :style="{ color: palette.primary, background: palette.soft }">
                进入牧场
              </button>
            </div>
            <div class="mt-4 space-y-2">
              <div class="preview-progress">
                <div class="preview-progress__bar" :style="{ background: palette.primary, width: '64%' }" />
              </div>
              <div class="flex items-center justify-between text-xs">
                <span :style="{ color: palette.primary }">自动托管已开启</span>
                <span class="text-gray-500">64%</span>
              </div>
            </div>
          </div>
          <div class="border rounded-xl p-3 text-xs leading-relaxed dark:border-gray-700">
            <div :style="{ color: palette.primary }">
              链接和强调文字
            </div>
            <div class="mt-1 text-gray-500">
              白色文字与主色的对比度：{{ palette.onFill === '#ffffff' ? '适合白字' : '自动切换深色文字' }}
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.appearance-page {
  max-width: 1100px;
  margin-inline: auto;
}

.palette-swatch {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  color: var(--ui-ink);
  background: var(--ui-surface);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition:
    border-color 0.16s ease,
    box-shadow 0.16s ease;
}

.palette-swatch:hover {
  border-color: var(--ui-primary);
}

.palette-swatch--active {
  border-color: var(--ui-primary);
  box-shadow: 0 0 0 3px var(--ui-primary-soft);
}

.palette-swatch__dot {
  width: 20px;
  height: 20px;
  flex: none;
  border-radius: 7px;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.08);
}

.palette-swatch__dot--custom {
  background: conic-gradient(#ef4444, #f59e0b, #22c55e, #3b82f6, #a855f7, #ef4444);
}

.palette-swatch__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-card {
  border: 1px solid var(--ui-border);
  background: var(--ui-surface-soft);
}

.preview-button {
  padding: 8px 14px;
  border: 0;
  border-radius: 9px;
  font-size: 13px;
  font-weight: 600;
  cursor: default;
}

.preview-button--soft {
  box-shadow: inset 0 0 0 1px var(--ui-border);
}

.preview-progress {
  overflow: hidden;
  height: 8px;
  border-radius: 999px;
  background: var(--ui-surface-solid);
}

.preview-progress__bar {
  height: 100%;
  border-radius: inherit;
}
</style>
