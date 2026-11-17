<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import api from '@/api'
import { useAccountStore } from '@/stores/account'

/**
 * 牧场运行策略。
 *
 * 对应农场的两项策略：
 *  - 优先种子  → 「优先指定动物」这个购买策略本身（选定后在同处挑动物）
 *  - 偷菜白名单 → 偷产物白名单（按货架 lot 的 animal_id 判断）
 *
 * 牧场没有「种植策略」那一套七选一算法：补栏的目标永远是「把空栏填满」，
 * 差别只在挑哪只。「优先指定动物」不是独立配置，它就是购买策略的一个选项，
 * 选定后动物下拉在同一处展开。
 */

const props = defineProps<{
  settings: {
    pastureBuyStrategy: string
    pasturePreferredAnimal: number
    pastureGrassThreshold: number
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

/** 已采集到的动物档案（真实养殖数据反推出来的每小时指标） */
interface AnimalStat {
  animalId: number
  totalExp: number
  totalGold: number
  cycleSamples: number
  expPerHour: number
  goldPerHour: number
}
const animalStats = ref<AnimalStat[]>([])

const BUY_STRATEGIES = [
  { value: 'cheapest', label: '最便宜', hint: '按商店价格升序，最稳。' },
  { value: 'max_exp', label: '经验每小时最高', hint: '按真实养殖数据算经验/时；没养过的动物按价格降序垫后。' },
  { value: 'max_profit', label: '收入每小时最高', hint: '扣除买入价后的净收入/时；同上，无档案时按价格降序。' },
  { value: 'preferred', label: '优先指定动物', hint: '先买指定的那只，买不起再按价格挑。' },
]

const strategyHint = computed(() => {
  const found = BUY_STRATEGIES.find(x => x.value === props.settings.pastureBuyStrategy)
  return found ? found.hint : ''
})

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

async function loadStats() {
  if (!currentAccountId.value)
    return
  try {
    const { data } = await api.get('/api/pasture/animal-stats', {
      headers: { 'x-account-id': currentAccountId.value },
    })
    if (data && data.ok && Array.isArray(data.data))
      animalStats.value = data.data
  }
  catch { /* 档案只是参考，取不到不影响策略保存 */ }
}

function statName(id: number) {
  const found = animals.value.find(a => a.id === id)
  return found ? found.name : `动物 #${id}`
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

onMounted(() => {
  void loadAnimals()
  void loadStats()
})
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

    <!-- 购买策略（「优先指定动物」就是策略本身，选定后在同处挑动物） -->
    <div class="mb-4">
      <label class="mb-1 block text-xs text-gray-600 dark:text-gray-300">
        购买策略
      </label>
      <select
        v-model="settings.pastureBuyStrategy"
        class="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800"
      >
        <option v-for="opt in BUY_STRATEGIES" :key="opt.value" :value="opt.value">
          {{ opt.label }}
        </option>
      </select>

      <!-- 选了「优先指定动物」时直接在这里挑，不再单独一整块配置 -->
      <div v-if="settings.pastureBuyStrategy === 'preferred'" class="mt-2">
        <select
          v-model.number="settings.pasturePreferredAnimal"
          class="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800"
        >
          <option :value="0">
            选一只想养的动物…
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
        <p v-if="!settings.pasturePreferredAnimal" class="mt-1 text-xs text-amber-600 dark:text-amber-400">
          还没选动物 —— 没选之前会按最便宜买。
        </p>
      </div>

      <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
        {{ strategyHint }}
        「经验/时」「收入/时」用牧场里真实养殖出来的数据算；没养过的动物查不到档案，
        会退回按价格挑，绝不编造数值。
      </p>
    </div>

    <!-- 牧草机补草阈值 -->
    <div class="mb-4">
      <label class="mb-1 block text-xs text-gray-600 dark:text-gray-300">
        补草阈值（牧草机存量低于该比例才自动加料）
      </label>
      <div class="flex items-center gap-2">
        <input
          v-model.number="settings.pastureGrassThreshold"
          type="range"
          min="0"
          max="100"
          step="5"
          class="flex-1"
        >
        <span class="w-12 text-right text-sm tabular-nums text-gray-700 dark:text-gray-200">
          {{ settings.pastureGrassThreshold ?? 30 }}%
        </span>
      </div>
      <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
        低于阈值时按缺口一次补齐。抓包确认牧草机的 count 是份数（补 1 份 = +1）。
        100% = 一有缺口就补，0% = 只在完全空时补。
      </p>
    </div>

    <!-- 已采集的动物档案 -->
    <div v-if="animalStats.length" class="mb-4 rounded border border-gray-100 dark:border-gray-700">
      <div class="border-b border-gray-100 px-2 py-1 text-xs text-gray-500 dark:border-gray-700">
        动物档案（{{ animalStats.length }} 种，来自真实养殖）
      </div>
      <table class="w-full text-xs">
        <thead class="text-gray-400">
          <tr>
            <th class="px-2 py-1 text-left font-normal">
              动物
            </th>
            <th class="px-2 py-1 text-right font-normal">
              经验/时
            </th>
            <th class="px-2 py-1 text-right font-normal">
              收入/时
            </th>
            <th class="px-2 py-1 text-right font-normal">
              样本
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="st in animalStats" :key="st.animalId" class="border-t border-gray-50 dark:border-gray-700/60">
            <td class="px-2 py-1">
              {{ statName(st.animalId) }}
            </td>
            <td class="px-2 py-1 text-right tabular-nums">
              {{ st.cycleSamples ? st.expPerHour.toFixed(1) : '—' }}
            </td>
            <td class="px-2 py-1 text-right tabular-nums">
              {{ st.cycleSamples ? st.goldPerHour.toFixed(1) : '—' }}
            </td>
            <td class="px-2 py-1 text-right text-gray-400 tabular-nums">
              {{ st.cycleSamples }}
            </td>
          </tr>
        </tbody>
      </table>
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