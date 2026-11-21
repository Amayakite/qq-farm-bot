<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

export interface TourStep {
  selector: string
  title: string
  body: string
}

const props = withDefaults(defineProps<{
  storageKey: string
  steps: TourStep[]
  enabled?: boolean
  delay?: number
}>(), {
  enabled: true,
  delay: 900,
})

const active = ref(false)
const index = ref(0)
const visibleSteps = ref<TourStep[]>([])
const tooltip = ref<HTMLElement | null>(null)
const rect = ref<{ top: number, left: number, width: number, height: number } | null>(null)
const viewport = ref({ width: 0, height: 0 })
const tooltipHeight = ref(0)
let retryTimer = 0
let retryCount = 0
let focusBeforeTour: HTMLElement | null = null

const current = computed(() => visibleSteps.value[index.value])
const isLast = computed(() => index.value === visibleSteps.value.length - 1)
const tooltipStyle = computed(() => {
  const target = rect.value
  const margin = 12
  const width = Math.min(320, viewport.value.width - margin * 2)
  const center = target ? target.left + target.width / 2 : viewport.value.width / 2
  const maxTop = Math.max(margin, viewport.value.height - tooltipHeight.value - margin)
  const below = target ? target.top + target.height + margin : maxTop / 2
  const above = target ? target.top - tooltipHeight.value - margin : below
  const left = Math.min(Math.max(margin, center - width / 2), viewport.value.width - width - margin)
  const top = Math.max(margin, Math.min(maxTop, below <= maxTop ? below : above))
  return { left: `${left}px`, top: `${top}px`, width: `${width}px` }
})

const highlightStyle = computed(() => {
  const target = rect.value
  if (!target)
    return { display: 'none' }
  return {
    top: `${target.top - 6}px`,
    left: `${target.left - 6}px`,
    width: `${target.width + 12}px`,
    height: `${target.height + 12}px`,
  }
})

function findTarget(step: TourStep | undefined) {
  const element = step && document.querySelector<HTMLElement>(step.selector)
  return element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden'
    ? element
    : null
}

function measure() {
  viewport.value = { width: window.innerWidth, height: window.innerHeight }
  const box = findTarget(current.value)?.getBoundingClientRect()
  rect.value = box && box.bottom > 0 && box.top < viewport.value.height ? box : null
  tooltipHeight.value = tooltip.value?.offsetHeight || 0
}

function stopTour() {
  active.value = false
  window.clearTimeout(retryTimer)
  window.removeEventListener('resize', measure)
  window.removeEventListener('scroll', measure, true)
  focusBeforeTour?.focus({ preventScroll: true })
  focusBeforeTour = null
}

function finish() {
  localStorage.setItem(props.storageKey, '1')
  stopTour()
}

async function showStep() {
  viewport.value = { width: window.innerWidth, height: window.innerHeight }
  await nextTick()
  if (!active.value)
    return
  findTarget(current.value)?.scrollIntoView({ block: 'center', inline: 'nearest' })
  measure()
  tooltip.value?.focus({ preventScroll: true })
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    finish()
  }
  if (event.key === 'Tab') {
    const buttons = Array.from(tooltip.value?.querySelectorAll('button') || [])
    const first = buttons[0]
    const last = buttons[buttons.length - 1]
    if (!first || !last)
      return
    const focused = document.activeElement
    if (event.shiftKey && (focused === first || focused === tooltip.value)) {
      event.preventDefault()
      last.focus()
    }
    else if (!event.shiftKey && focused === last) {
      event.preventDefault()
      first.focus()
    }
  }
}

function next() {
  if (isLast.value) {
    finish()
    return
  }
  index.value += 1
  void showStep()
}

function previous() {
  if (index.value <= 0)
    return
  index.value -= 1
  void showStep()
}

function scheduleBegin() {
  if (!props.enabled || localStorage.getItem(props.storageKey) === '1')
    return
  retryTimer = window.setTimeout(() => {
    const steps = props.steps.filter(step => findTarget(step))
    if (steps.length) {
      visibleSteps.value = steps
      focusBeforeTour = document.activeElement as HTMLElement | null
      index.value = 0
      active.value = true
      window.addEventListener('resize', measure)
      window.addEventListener('scroll', measure, true)
      void showStep()
      return
    }
    retryCount += 1
    if (retryCount < 12)
      scheduleBegin()
  }, props.delay)
}

onMounted(scheduleBegin)
onBeforeUnmount(stopTour)
watch(() => [props.enabled, props.storageKey], () => {
  stopTour()
  retryCount = 0
  scheduleBegin()
})
</script>

<template>
  <Teleport to="body">
    <div v-if="active" class="tour-root" :class="{ 'tour-root--no-target': !rect }" role="dialog" aria-modal="true" :aria-label="current?.title" @keydown="handleKeydown">
      <div class="tour-blocker" />
      <div class="tour-highlight" :style="highlightStyle" />
      <div ref="tooltip" class="tour-tooltip" tabindex="-1" :style="tooltipStyle">
        <div class="tour-tooltip__step">
          {{ index + 1 }} / {{ visibleSteps.length }}
        </div>
        <h3 class="tour-tooltip__title">
          {{ current?.title }}
        </h3>
        <p class="tour-tooltip__body">
          {{ current?.body }}
        </p>
        <div class="tour-tooltip__actions">
          <button type="button" class="tour-btn tour-btn--ghost" @click="finish">
            跳过
          </button>
          <div class="flex gap-2">
            <button v-if="index > 0" type="button" class="tour-btn tour-btn--ghost" @click="previous">
              上一步
            </button>
            <button type="button" class="tour-btn tour-btn--primary" @click="next">
              {{ isLast ? '完成' : '下一步' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.tour-root {
  position: fixed;
  z-index: 90;
  inset: 0;
  pointer-events: none;
}

.tour-blocker {
  position: fixed;
  z-index: 90;
  inset: 0;
  background: transparent;
  pointer-events: auto;
}

.tour-root--no-target .tour-blocker {
  background: rgba(15, 23, 42, 0.45);
}

.tour-highlight {
  position: fixed;
  z-index: 91;
  border: 2px solid var(--ui-primary);
  border-radius: 14px;
  box-shadow: 0 0 0 9999px rgba(15, 23, 42, 0.45);
  pointer-events: none;
  transition: all 0.18s ease;
}

.tour-tooltip {
  position: fixed;
  z-index: 92;
  max-height: calc(100dvh - 24px);
  overflow-y: auto;
  padding: 16px;
  border: 1px solid var(--ui-border);
  border-radius: 14px;
  color: var(--ui-ink);
  background: var(--ui-surface-strong);
  box-shadow: 0 24px 64px rgba(15, 23, 42, 0.28);
  pointer-events: auto;
}

.tour-tooltip__step {
  color: var(--ui-primary);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.tour-tooltip__title {
  margin: 4px 0 0;
  font-size: 15px;
  font-weight: 700;
}

.tour-tooltip__body {
  margin: 6px 0 0;
  color: var(--ui-muted);
  font-size: 12px;
  line-height: 1.65;
}

.tour-tooltip__actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 14px;
}

.tour-btn {
  padding: 6px 12px;
  border: 1px solid transparent;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.tour-btn--ghost {
  color: var(--ui-muted);
  background: transparent;
}

.tour-btn--ghost:hover {
  color: var(--ui-ink);
  background: var(--ui-surface-soft);
}

.tour-btn--primary {
  color: var(--ui-primary-on-fill, #fff);
  background: var(--ui-primary-fill);
}

.tour-btn--primary:hover {
  box-shadow: 0 0 0 3px var(--ui-primary-soft);
}
</style>
