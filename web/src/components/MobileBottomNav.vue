<script setup lang="ts">
import { computed } from 'vue'
import { useUserStore } from '@/stores/user'

const userStore = useUserStore()

const ownerItems = [
  { path: '/admin', label: '管理', icon: 'i-carbon-dashboard' },
  { path: '/admin/tenants', label: '用户', icon: 'i-carbon-user-admin' },
  { path: '/personal', label: '农场', icon: 'i-carbon-sprout' },
  { path: '/ranch', label: '牧场', icon: 'i-carbon-pet-image-o' },
  { path: '/settings', label: '我的', icon: 'i-carbon-settings' },
]

const tenantItems = [
  { path: '/home', label: '首页', icon: 'i-carbon-home' },
  { path: '/personal', label: '农场', icon: 'i-carbon-sprout' },
  { path: '/ranch', label: '牧场', icon: 'i-carbon-pet-image-o' },
  { path: '/activity', label: '活动', icon: 'i-carbon-events' },
  { path: '/settings', label: '我的', icon: 'i-carbon-settings' },
]

const items = computed(() => userStore.isOwner ? ownerItems : tenantItems)
</script>

<template>
  <nav class="mobile-bottom-nav lg:hidden" aria-label="主要导航">
    <RouterLink
      v-for="item in items"
      :key="item.path"
      :to="item.path"
      class="mobile-bottom-nav__item"
      exact-active-class="mobile-bottom-nav__item--active"
    >
      <div :class="item.icon" class="mobile-bottom-nav__icon" />
      <span>{{ item.label }}</span>
    </RouterLink>
  </nav>
</template>

<style scoped>
.mobile-bottom-nav {
  position: fixed;
  z-index: 35;
  right: max(14px, env(safe-area-inset-right));
  bottom: max(12px, env(safe-area-inset-bottom));
  left: max(14px, env(safe-area-inset-left));
  display: none;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  min-height: 66px;
  padding: 7px 8px;
  border: 1px solid var(--ui-border);
  border-radius: 24px;
  background: color-mix(in srgb, var(--ui-bg) 84%, transparent);
  box-shadow:
    0 16px 42px rgba(31, 41, 51, 0.14),
    inset 0 1px 0 var(--glass-highlight);
  -webkit-backdrop-filter: blur(22px) saturate(135%);
  backdrop-filter: blur(22px) saturate(135%);
}

@media (max-width: 1023px) {
  .mobile-bottom-nav {
    display: grid;
  }
}

.mobile-bottom-nav__item {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 3px;
  border-radius: 17px;
  color: var(--ui-muted);
  font-size: 11px;
  line-height: 1.1;
  text-decoration: none;
  transition:
    color 0.16s ease,
    background-color 0.16s ease;
}

.mobile-bottom-nav__icon {
  width: 22px;
  height: 22px;
}

.mobile-bottom-nav__item--active {
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
  box-shadow: none !important;
}
</style>
