<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
// 活动页当前无进行中的活动。退役记录（仅留定位，实现均已移除或归档）：
//   - 2026-10-09 星砂 / 七夕类旧活动页面停用（历史协议解析仍在 activity 服务里）
//   - 2026-10-15 S3 萌宠 / 秋祈良愿 / 快乐不独享 随 S4 轮换下架
//   - 2026-11-16 奶茶热销中（S4）结算期结束后退役
// 奶茶面板已归档到 core/archive/milk-tea/。本页只保留 admin 的活动分析入口 ——
// AdminActivityUpdatePanel 是在线发现未适配活动的唯一工具，将来新活动上线靠它。
import AdminActivityUpdatePanel from '@/components/admin/AdminActivityUpdatePanel.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { useAccountStore } from '@/stores/account'
import { useUserStore } from '@/stores/user'

const accountStore = useAccountStore()
const userStore = useUserStore()
const { currentAccountId, currentAccount } = storeToRefs(accountStore)

const showActivityAnalysis = ref(false)

// 非管理员不应保留弹窗状态（切换账号后权限可能变化）
watch(userStore, () => {
  if (!userStore.isAdmin)
    showActivityAnalysis.value = false
}, { immediate: true })

onBeforeUnmount(() => {
  showActivityAnalysis.value = false
})

onMounted(() => {})
</script>

<template>
  <section class="activity-page space-y-4">
    <header class="relative overflow-hidden rounded-xl from-slate-800 via-sky-800 to-indigo-900 bg-gradient-to-r shadow-sm">
      <div class="absolute h-64 w-64 rounded-full bg-sky-300/15 blur-3xl -right-12 -top-20" />
      <div class="relative flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div class="min-w-0 flex items-center gap-3">
          <span class="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-white/10 text-3xl text-sky-100">
            <span class="i-carbon-events" />
          </span>
          <div>
            <h1 class="text-xl text-white font-bold">
              活动中心
            </h1>
            <div class="mt-1 text-xs text-sky-100/75">
              当前账号 {{ currentAccount?.name || '未选择' }} · 查看进行中的活动与奖励
            </div>
          </div>
        </div>
        <div class="min-w-0 flex flex-wrap items-center gap-2">
          <BaseButton v-if="userStore.isAdmin" variant="secondary" @click="showActivityAnalysis = true">
            <span class="i-carbon-analytics mr-1.5" />
            活动分析
          </BaseButton>
        </div>
      </div>
    </header>

    <div v-if="!currentAccountId" class="rounded-lg bg-white p-10 text-center text-sm text-gray-500 shadow dark:bg-gray-800">
      请先选择账号，再查看活动数据。
    </div>
    <template v-else>
      <p class="rounded-lg bg-white p-8 text-center text-sm text-gray-500 dark:bg-gray-800">
        暂无进行中的活动。
      </p>
      <p class="px-2 text-xs text-gray-400 dark:text-gray-500">
        奶茶热销中（2026-11-15 结算期结束）已归档；新活动由管理员用「活动分析」在线发现。
      </p>
    </template>

    <Teleport to="body">
      <div
        v-if="showActivityAnalysis"
        class="fixed inset-0 z-60 flex items-center justify-center bg-black/55 p-3 sm:p-6"
        role="dialog"
        aria-modal="true"
        aria-label="活动分析"
        @click.self="showActivityAnalysis = false"
      >
        <div class="max-h-[92vh] max-w-7xl w-full flex flex-col overflow-hidden rounded-xl bg-white shadow-2xl dark:bg-gray-800">
          <header class="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
            <div>
              <h2 class="text-gray-900 font-semibold dark:text-white">
                活动分析
              </h2>
              <p class="mt-0.5 text-xs text-gray-500">
                在线发现未适配活动并读取只读活动树
              </p>
            </div>
            <div class="min-w-0 flex items-center gap-3">
              <button
                class="grid h-9 w-9 place-items-center rounded-lg text-gray-500 transition hover:bg-gray-100 dark:hover:bg-gray-700"
                aria-label="关闭活动分析"
                @click="showActivityAnalysis = false"
              >
                <span class="i-carbon-close text-xl" />
              </button>
            </div>
          </header>
          <div class="min-h-0 flex-1 overflow-y-auto p-4">
            <AdminActivityUpdatePanel />
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.activity-page {
  min-width: 0;
}
.activity-page :deep(button) {
  min-height: 42px;
}
.activity-page .text-xs {
  overflow-wrap: anywhere;
}
</style>
