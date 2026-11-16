<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import api from '@/api'
import { useAccountStore } from '@/stores/account'

/**
 * 牧场运行策略。
 *
 * 对应农场的两项策略：
 *  - 优先种子  → 优先补栏动物（补栏时先买它，买不起才退到最便宜的）
 *  - 偷菜白名单 → 偷产物白名单（按货架 lot 的 animal_id 判断）
 *
 * 牧场没有「种植策略」那一套七选一算法：补栏的目标永远是「把空栏填满」，
 * 差别只在挑哪只，所以一个优先项加一个白名单就够了。
 */

const props = defineProps<{
  settings: {
    pasturePreferredAnimal: number
    pastureStealWhitelist: number[]
  }
}>()

const accountStore = useAccountStore()
// 用 storeToRefs 拿 ref：直接解构出来的是字符串快照，切换账号后不会更新
const { currentAccountId } = storeToRefs(accountStore)

interface Animal {
  id: number
  name: string
}

const animals = ref<Animal[]>([])
const loading = ref(false)

const nest = computed(() => animals.value.filter(a => a.id >= 60000 && a.id < 70000))
const barn = computed(() => animals.value.filter(a => a.id >= 70000))

async function loadAnimals() {
  if (!currentAccountId.value || loading.value)
    return
  loading.value = true
  try {
    const { data } = await api.get('/api/pasture/animals', {
      headers: { 'x-account-id': currentAccountId.value },
    })
    if (data && data.ok && Array.isArray(data.data))
      animals.value = data.data
  }
  catch { /* 清单只是下拉用，失败时保持空列表，不影响保存其它策略 */ }
  finally {
    loading.value = false
  }
}

function toggleWhitelist(id: number) {
  const list = props.settings.pastureStealWhitelist || []
  props.settings.pastureStealWhitelist = list.includes(id)
    ? list.filter(x => x !== id)
    : [...list, id]
}

function isWhite(id: number) {
  return (props.settings.pastureStealWhitelist || []).includes(id)
}

onMounted(loadAnimals)
</script>

<template>
  <div class="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
    <h4 class="mb-1 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
      <div class="i-carbon-home text-base text-teal-600 dark:text-teal-400" />
      牧场策略
    </h4>
    <p class="mb-3 text-xs text-gray-500 dark:text-gray-400">
      补栏永远先用背包里的动物；只有背包没有、且开了「自动买动物」时才会花钱。
    </p>

    <!-- 优先补栏动物 -->
    <div class="mb-4">
      <label class="mb-1 block text-xs text-gray-600 dark:text-gray-300">
        优先补栏动物
      </label>
      <select
        v-model.number="settings.pasturePreferredAnimal"
        class="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800"
      >
        <option :value="0">
          不指定（买最便宜的）
        </option>
        <optgroup v-if="nest.length" label="窝类">
          <option v-for="a in nest" :key="a.id" :value="a.id">
            {{ a.name }} ({{ a.id }})
          </option>
        </optgroup>
        <optgroup v-if="barn.length" label="棚类">
          <option v-for="a in barn" :key="a.id" :value="a.id">
            {{ a.name }} ({{ a.id }})
          </option>
        </optgroup>
      </select>
      <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
        指定的动物买不起时会自动退到买得起的；留空则永远挑最便宜的那只。
      </p>
    </div>

    <!-- 偷产物白名单 -->
    <div>
      <div class="mb-1 flex items-center justify-between">
        <label class="text-xs text-gray-600 dark:text-gray-300">
          偷产物白名单
        </label>
        <button
          v-if="(settings.pastureStealWhitelist || []).length"
          class="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600 transition hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300"
          @click="settings.pastureStealWhitelist = []"
        >
          清空（不限制）
        </button>
      </div>
      <p class="mb-2 text-xs text-gray-500 dark:text-gray-400">
        空 = 不限制，所有可偷的都偷；选了就只偷货架上有这些动物的好友牧场。
        需要先打开「偷好友牧场产物」开关才会生效。
      </p>
      <div v-if="!animals.length" class="text-xs text-gray-400">
        {{ loading ? '加载动物清单…' : '动物清单不可用（连不上账号时正常）' }}
      </div>
      <div v-else class="grid max-h-64 grid-cols-2 gap-1 overflow-y-auto sm:grid-cols-4">
        <label
          v-for="a in animals"
          :key="a.id"
          class="flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-xs transition"
          :class="isWhite(a.id)
            ? 'bg-teal-50 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300'
            : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'"
        >
          <input
            type="checkbox"
            :checked="isWhite(a.id)"
            class="shrink-0"
            @change="toggleWhitelist(a.id)"
          >
          <span class="truncate">{{ a.name }}</span>
        </label>
      </div>
    </div>
  </div>
</template>