export interface MenuItem {
  path: string
  name: string
  label: string
  icon: string
  component: () => Promise<any>
  meta?: {
    fullBleed?: boolean
    gameSpace?: 'ranch'
    ranchSection?: 'personal' | 'illustrated' | 'mall' | 'friends' | 'activity'
    ownerOnly?: boolean
    tenantOnly?: boolean
    tenantHidden?: boolean
    hideSpaceSwitch?: boolean
    group?: 'admin' | 'game'
  }
}

export const menuRoutes: MenuItem[] = [
  {
    path: 'home',
    name: 'home',
    label: '首页',
    icon: 'i-carbon-home',
    component: () => import('@/views/UserHome.vue'),
    meta: { tenantOnly: true },
  },
  {
    path: 'admin',
    name: 'admin-home',
    label: '管理控制台',
    icon: 'i-carbon-dashboard',
    component: () => import('@/views/AdminOverview.vue'),
    meta: { ownerOnly: true, hideSpaceSwitch: true, group: 'admin' },
  },
  {
    path: 'admin/tenants',
    name: 'admin-tenants',
    label: '用户与激活码',
    icon: 'i-carbon-user-admin',
    component: () => import('@/views/AdminTenants.vue'),
    meta: { ownerOnly: true, hideSpaceSwitch: true, group: 'admin' },
  },
  {
    path: 'admin/appearance',
    name: 'admin-appearance',
    label: '外观设置',
    icon: 'i-carbon-color-palette',
    component: () => import('@/views/AppearanceSettings.vue'),
    meta: { ownerOnly: true, hideSpaceSwitch: true, group: 'admin' },
  },
  {
    path: 'personal',
    name: 'personal',
    label: '农场',
    icon: 'i-carbon-sprout',
    component: () => import('@/views/Personal.vue'),
    meta: { group: 'game' },
  },
  {
    path: '',
    name: 'dashboard',
    label: '农场概览',
    icon: 'i-carbon-dashboard',
    component: () => import('@/views/Dashboard.vue'),
    meta: { group: 'game', tenantHidden: true },
  },
  {
    path: 'illustrated',
    name: 'illustrated',
    label: '图鉴',
    icon: 'i-carbon-book',
    component: () => import('@/views/Illustrated.vue'),
    meta: { group: 'game' },
  },
  {
    path: 'activity',
    name: 'activity-center',
    label: '活动',
    icon: 'i-carbon-events',
    component: () => import('@/views/ActivityCenter.vue'),
    meta: { group: 'game' },
  },
  {
    path: 'friends',
    name: 'friends',
    label: '好友',
    icon: 'i-carbon-user-multiple',
    component: () => import('@/views/Friends.vue'),
    meta: { group: 'game' },
  },
  {
    path: 'analytics',
    name: 'analytics',
    label: '分析',
    icon: 'i-carbon-chart-line',
    component: () => import('@/views/Analytics.vue'),
    meta: { group: 'game', tenantHidden: true },
  },
  {
    path: 'solar-calendar',
    name: 'solar-calendar',
    label: '节令日历',
    icon: 'i-carbon-calendar',
    component: () => import('@/views/SolarCalendar.vue'),
    meta: { group: 'game', tenantHidden: true },
  },
  {
    path: 'game-mall',
    name: 'game-mall',
    label: '游戏商城',
    icon: 'i-carbon-shopping-cart',
    component: () => import('@/views/GameMall.vue'),
    meta: { group: 'game' },
  },
  {
    path: 'settings',
    name: 'Settings',
    label: '设置',
    icon: 'i-carbon-settings',
    component: () => import('@/views/Settings.vue'),
  },
]

export const ranchMenuRoutes: MenuItem[] = [
  { path: 'ranch', name: 'ranch-dashboard', label: '牧场概览', icon: 'i-carbon-dashboard', component: () => import('@/views/RanchOverview.vue'), meta: { gameSpace: 'ranch', group: 'game' } },
  { path: 'ranch/personal', name: 'ranch-personal', label: '个人', icon: 'i-carbon-sprout', component: () => import('@/views/Ranch.vue'), meta: { gameSpace: 'ranch', ranchSection: 'personal', group: 'game' } },
  { path: 'ranch/illustrated', name: 'ranch-illustrated', label: '图鉴', icon: 'i-carbon-book', component: () => import('@/views/Ranch.vue'), meta: { gameSpace: 'ranch', ranchSection: 'illustrated', group: 'game' } },
  { path: 'ranch/activity', name: 'ranch-activity-center', label: '活动', icon: 'i-carbon-gift', component: () => import('@/views/Ranch.vue'), meta: { gameSpace: 'ranch', ranchSection: 'activity', group: 'game' } },
  { path: 'ranch/friends', name: 'ranch-friends', label: '好友', icon: 'i-carbon-user-multiple', component: () => import('@/views/Ranch.vue'), meta: { gameSpace: 'ranch', ranchSection: 'friends', group: 'game' } },
  { path: 'ranch/strategy', name: 'ranch-strategy', label: '策略', icon: 'i-carbon-settings-adjust', component: () => import('@/views/RanchStrategy.vue'), meta: { gameSpace: 'ranch', group: 'game' } },
  { path: 'ranch/game-mall', name: 'ranch-game-mall', label: '游戏商城', icon: 'i-carbon-shopping-cart', component: () => import('@/views/Ranch.vue'), meta: { gameSpace: 'ranch', ranchSection: 'mall', group: 'game' } },
  { path: 'ranch/settings', name: 'ranch-Settings', label: '设置', icon: 'i-carbon-settings', component: () => import('@/views/Settings.vue'), meta: { gameSpace: 'ranch' } },
]

export const allMenuRoutes = [...menuRoutes, ...ranchMenuRoutes]
export function getSpaceMenu(inRanch: boolean) {
  return inRanch ? ranchMenuRoutes : menuRoutes
}
