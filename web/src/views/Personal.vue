<script setup lang="ts">
import { computed, ref } from 'vue'
import BagPanel from '@/components/BagPanel.vue'
import FarmPanel from '@/components/FarmPanel.vue'
import PasturePanel from '@/components/PasturePanel.vue'
import TaskPanel from '@/components/TaskPanel.vue'

const currentTab = ref<'farm' | 'pasture' | 'bag' | 'task'>('farm')

// 用三元而不是查表：模板里对对象下标取动态 key 拿不稳组件引用，
// 实测切 tab 后高亮变了但面板还是旧的。三元表达式和原来 3 个 tab 时一致。
// 这里刻意不用 <Transition mode="out-in">：套一层过渡后，切 tab 时按钮高亮会变，
// 但面板一直停在旧组件上（实测加不加 :key 都一样）。去掉过渡后切换正常。
const currentPanel = computed(() =>
  currentTab.value === 'pasture' ? PasturePanel
    : currentTab.value === 'bag' ? BagPanel
      : currentTab.value === 'task' ? TaskPanel
        : FarmPanel,
)
</script>

<template>
  <div class="h-full flex flex-col p-4">
    <div class="mb-4 flex space-x-2">
      <button
        class="rounded-lg px-4 py-2 font-medium transition-colors"
        :class="currentTab === 'farm'
          ? 'text-white shadow-md'
          : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'"
        :style="currentTab === 'farm' ? { backgroundColor: 'var(--theme-primary)' } : {}"
        @click="currentTab = 'farm'"
      >
        <div class="flex items-center space-x-2">
          <div class="i-carbon-sprout text-lg" />
          <span>我的农场</span>
        </div>
      </button>
      <button
        class="rounded-lg px-4 py-2 font-medium transition-colors"
        :class="currentTab === 'pasture'
          ? 'text-white shadow-md'
          : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'"
        :style="currentTab === 'pasture' ? { backgroundColor: 'var(--theme-primary)' } : {}"
        @click="currentTab = 'pasture'"
      >
        <div class="flex items-center space-x-2">
          <div class="i-carbon-home text-lg" />
          <span>我的牧场</span>
        </div>
      </button>
      <button
        class="rounded-lg px-4 py-2 font-medium transition-colors"
        :class="currentTab === 'bag'
          ? 'text-white shadow-md'
          : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'"
        :style="currentTab === 'bag' ? { backgroundColor: 'var(--theme-primary)' } : {}"
        @click="currentTab = 'bag'"
      >
        <div class="flex items-center space-x-2">
          <div class="i-carbon-box text-lg" />
          <span>我的背包</span>
        </div>
      </button>
      <button
        class="rounded-lg px-4 py-2 font-medium transition-colors"
        :class="currentTab === 'task'
          ? 'text-white shadow-md'
          : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'"
        :style="currentTab === 'task' ? { backgroundColor: 'var(--theme-primary)' } : {}"
        @click="currentTab = 'task'"
      >
        <div class="flex items-center space-x-2">
          <div class="i-carbon-task text-lg" />
          <span>我的任务</span>
        </div>
      </button>
    </div>

    <div class="flex-1 overflow-hidden overflow-y-auto">
      <component :is="currentPanel" />
    </div>
  </div>
</template>
