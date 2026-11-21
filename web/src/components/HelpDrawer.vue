<script setup lang="ts">
import { NDrawer, NDrawerContent } from 'naive-ui/es/drawer'

defineProps<{
  show: boolean
}>()

const emit = defineEmits<{
  (e: 'update:show', value: boolean): void
}>()

const sections = [
  {
    key: 'account',
    icon: 'i-carbon-user-multiple',
    title: '添加游戏账号',
    body: '点击左侧或首页的「添加账号」，选择 QQ / 微信扫码，或粘贴游戏登录 Code。添加成功后账号会自动启动。',
  },
  {
    key: 'start',
    icon: 'i-carbon-play',
    title: '启动自动托管',
    body: '账号在线后，收菜、种植、好友巡查和日常任务会按设置自动执行。首页的「启动托管」可以手动恢复。',
  },
  {
    key: 'farm',
    icon: 'i-carbon-sprout',
    title: '农场收菜',
    body: '进入「农场」查看土地状态。首页会显示可收获数量，点击「一键收菜」即可处理成熟作物。',
  },
  {
    key: 'ranch',
    icon: 'i-carbon-pet-image-o',
    title: '牧场照料',
    body: '进入「牧场」查看动物状态。首页会提示可喂养、可收获和需要清理的动物，点「进入牧场」处理。',
  },
  {
    key: 'settings',
    icon: 'i-carbon-settings',
    title: '设置与策略',
    body: '「设置」中可以调整种植策略、自动控制、好友互动和账号参数；修改后运行中的账号会按新配置执行。',
  },
]
</script>

<template>
  <NDrawer :show="show" width="min(420px, 100vw)" placement="right" @update:show="value => emit('update:show', value)">
    <NDrawerContent title="使用帮助" closable>
      <div class="space-y-3">
        <div v-for="item in sections" :key="item.key" class="help-item">
          <span class="help-item__icon" :class="item.icon" />
          <div class="min-w-0">
            <div class="help-item__title">
              {{ item.title }}
            </div>
            <p class="help-item__body">
              {{ item.body }}
            </p>
          </div>
        </div>
        <div class="help-note">
          还有问题？把页面截图和操作时间发给管理员，后台日志可以定位具体原因。
        </div>
      </div>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped>
.help-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--ui-border);
  border-radius: 12px;
  background: var(--ui-surface-soft);
}

.help-item__icon {
  display: grid;
  width: 30px;
  height: 30px;
  flex: none;
  place-items: center;
  border-radius: 9px;
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
  font-size: 17px;
}

.help-item__title {
  color: var(--ui-ink);
  font-size: 13px;
  font-weight: 600;
}

.help-item__body {
  margin: 4px 0 0;
  color: var(--ui-muted);
  font-size: 12px;
  line-height: 1.65;
}

.help-note {
  padding: 10px 12px;
  border-radius: 10px;
  color: var(--ui-muted);
  background: var(--ui-surface-soft);
  font-size: 11px;
  line-height: 1.6;
}
</style>
