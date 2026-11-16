<script setup lang="ts">
import PasturePanel from '@/components/PasturePanel.vue'

/**
 * 独立路由页。日常入口在「个人 → 我的牧场」这个 tab，
 * 这里保留一份是为了深链接和旧书签还能直接打开。
 */
</script>

<template>
  <div class="space-y-5">
    <div>
      <h1 class="text-xl text-gray-900 font-semibold dark:text-gray-100">
        牧场
      </h1>
      <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
        入口在「个人 → 我的牧场」，这里保留独立地址。
      </p>
    </div>
    <PasturePanel />
  </div>
</template>
