<script setup lang="ts">
import { NInput } from 'naive-ui/es/input'
import { NInputNumber } from 'naive-ui/es/input-number'
import { computed, useAttrs, useId } from 'vue'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  id?: string
  type?: string
  placeholder?: string
  label?: string
  autocomplete?: string
  required?: boolean
  disabled?: boolean
  clearable?: boolean
  min?: string | number
  max?: string | number
  step?: string | number
}>()

const emit = defineEmits<{
  (e: 'clear'): void
}>()

const attrs = useAttrs()
const model = defineModel<string | number>()
const generatedId = useId()
const inputProps = computed(() => ({
  id: props.id || (props.label ? generatedId : undefined),
  autocomplete: props.autocomplete,
  required: props.required,
}))

const textValue = computed({
  get: () => model.value === undefined || model.value === null ? '' : String(model.value),
  set: (value: string) => {
    model.value = value
  },
})

const numberValue = computed<number | null>({
  get: () => {
    if (model.value === undefined || model.value === null || model.value === '')
      return null
    const value = Number(model.value)
    return Number.isFinite(value) ? value : null
  },
  set: (value) => {
    model.value = value === null ? '' : value
  },
})
</script>

<template>
  <div class="base-field">
    <label v-if="label" class="base-field__label" :for="inputProps.id">
      {{ label }}
    </label>
    <NInputNumber
      v-if="type === 'number'"
      v-model:value="numberValue"
      v-bind="attrs"
      :input-props="inputProps"
      class="w-full"
      :placeholder="placeholder"
      :disabled="disabled"
      :clearable="clearable"
      :min="min"
      :max="max"
      :step="step"
      @clear="emit('clear')"
    />
    <NInput
      v-else
      v-model:value="textValue"
      v-bind="attrs"
      :input-props="inputProps"
      :type="type === 'password' ? 'password' : 'text'"
      :placeholder="placeholder"
      :disabled="disabled"
      :clearable="clearable"
      :show-password-on="type === 'password' ? 'click' : undefined"
      @clear="emit('clear')"
    />
  </div>
</template>
