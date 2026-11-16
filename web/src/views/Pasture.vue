<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, onMounted, watch } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { useAccountStore } from '@/stores/account'
import { usePastureStore } from '@/stores/pasture'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'

const accountStore = useAccountStore()
const pastureStore = usePastureStore()
const statusStore = useStatusStore()
const toast = useToastStore()

const { currentAccountId } = storeToRefs(accountStore)
const { status, realtimeConnected } = storeToRefs(statusStore)
const {
  summary,
  animals,
  shelves,
  hazards,
  emptySlots,
  updatedAt,
  loading,
  operating,
  error,
  lastActions,
} = storeToRefs(pastureStore)

/** 面板轮询间隔：牧场本身变化慢，20 秒足够，且不会和 bot 的请求抢预算 */
const POLL_MS = 20_000

const connected = computed(() => !!realtimeConnected.value)
const hasData = computed(() => summary.value.capacity > 0)

const summaryCards = computed(() => [
  {
    key: 'animals',
    label: '栏位',
    value: `${summary.value.animals}/${summary.value.capacity}`,
    hint: `空 ${summary.value.emptySlots}`,
    tone: 'text-sky-600 dark:text-sky-400',
  },
  {
    key: 'harvest',
    label: '可收获',
    value: String(summary.value.harvestable),
    hint: summary.value.expectedHarvestExp > 0 ? `约 +${summary.value.expectedHarvestExp} 经验` : '',
    tone: 'text-emerald-600 dark:text-emerald-400',
  },
  {
    key: 'feed',
    label: '待投喂',
    value: String(summary.value.needFeed),
    hint: summary.value.needFeed > 0 ? '需要草料' : '',
    tone: 'text-amber-600 dark:text-amber-400',
  },
  {
    key: 'clean',
    label: '灾害',
    value: String(summary.value.needClean),
    hint: summary.value.needClean > 0 ? '虫/杂草' : '',
    tone: 'text-rose-600 dark:text-rose-400',
  },
  {
    key: 'stroke',
    label: '可抚摸',
    value: String(summary.value.strokable || 0),
    hint: summary.value.strokable > 0 ? '抚摸推进产出' : '',
    tone: 'text-violet-600 dark:text-violet-400',
  },
  {
    key: 'grass',
    label: '牧草',
    value: String(summary.value.grassAmount),
    hint: summary.value.grassLow ? '偏低' : '充足',
    tone: summary.value.grassLow
      ? 'text-rose-600 dark:text-rose-400'
      : 'text-emerald-600 dark:text-emerald-400',
  },
])

const ops = [
  { op: 'harvest', label: '收获', hint: '收动物产物与货架' },
  { op: 'feed', label: '投喂', hint: '给待喂动物加草' },
  { op: 'clean', label: '清理', hint: '清除虫与杂草' },
  { op: 'stroke', label: '抚摸', hint: '抚摸可推进动物产出' },
  { op: 'refill', label: '补栏', hint: '把背包里的动物放进空栏' },
  { op: 'grass', label: '补草', hint: '给牧草机加料' },
]

/** 状态角标：优先级 可收获 > 待投喂 > 缺草 > 生产中 */
function animalTone(animal: any) {
  if (animal.canHarvest)
    return { label: '可收获', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' }
  if (animal.canFeed)
    return { label: '待投喂', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' }
  if (animal.grassBlocked)
    return { label: '缺草', cls: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300' }
  if (animal.producing)
    return { label: '生产中', cls: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300' }
  return { label: animal.stageName, cls: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300' }
}

function formatRemain(sec: number) {
  if (!sec || sec <= 0)
    return ''
  if (sec < 60)
    return `${sec} 秒`
  if (sec < 3600)
    return `${Math.floor(sec / 60)} 分`
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return m > 0 ? `${h} 时 ${m} 分` : `${h} 时`
}

function formatTime(ms: number) {
  if (!ms)
    return '—'
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false })
}

async function refresh(showError = true) {
  if (!currentAccountId.value || !connected.value) {
    // 未连接时不打接口，避免刷出一堆超时
    return
  }
  await pastureStore.fetchPasture(currentAccountId.value)
  if (showError && error.value)
    toast.add(error.value, 'error')
}

async function runOp(op: string) {
  if (!currentAccountId.value || operating.value)
    return
  const result = await pastureStore.operate(currentAccountId.value, op)
  if (!result) {
    if (error.value)
      toast.add(error.value, 'error')
    return
  }
  if (result.actions && result.actions.length > 0)
    toast.add(`牧场执行：${result.actions.join(' → ')}`, 'success')
  else
    toast.add('牧场当前没有需要做的操作', 'info')
}

const { pause, resume } = useIntervalFn(() => refresh(false), POLL_MS, { immediate: false })

onMounted(() => {
  void refresh()
  resume()
})

watch(currentAccountId, () => {
  pastureStore.clearPastureData()
  void refresh()
})

watch(connected, (value) => {
  if (value)
    void refresh()
  else
    pause()
})
</script>

<template>
  <div class="space-y-5">
    <!-- 页头 -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl text-gray-900 font-semibold dark:text-gray-100">
          牧场
        </h1>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
          动物、货架、灾害与牧草，和农场共用同一条连接。
          <span v-if="updatedAt">更新于 {{ formatTime(updatedAt) }}</span>
        </p>
      </div>
      <div class="flex items-center gap-2">
        <BaseButton variant="outline" size="sm" :loading="loading" @click="refresh()">
          刷新
        </BaseButton>
        <BaseButton
          variant="primary"
          size="sm"
          :loading="operating"
          :disabled="!connected"
          @click="runOp('all')"
        >
          一键执行
        </BaseButton>
      </div>
    </div>

    <!-- 未连接提示 -->
    <div
      v-if="!connected"
      class="border border-amber-200 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200"
    >
      账号未连接，牧场数据不可用。等登录恢复后会自动刷新。
    </div>

    <!-- 汇总卡片 -->
    <div class="grid grid-cols-2 gap-3 lg:grid-cols-5 sm:grid-cols-3">
      <div
        v-for="card in summaryCards"
        :key="card.key"
        class="border border-gray-200 rounded-lg bg-white p-3 dark:border-gray-700 dark:bg-gray-800"
      >
        <div class="text-xs text-gray-500 dark:text-gray-400">
          {{ card.label }}
        </div>
        <div class="mt-1 text-2xl font-semibold" :class="card.tone">
          {{ card.value }}
        </div>
        <div class="mt-0.5 h-4 text-xs text-gray-400 dark:text-gray-500">
          {{ card.hint }}
        </div>
      </div>
    </div>

    <!-- 单项操作 -->
    <div class="flex flex-wrap gap-2">
      <BaseButton
        v-for="item in ops"
        :key="item.op"
        variant="secondary"
        size="sm"
        :loading="operating"
        :disabled="!connected"
        :title="item.hint"
        @click="runOp(item.op)"
      >
        {{ item.label }}
      </BaseButton>
      <span
        v-if="lastActions.length"
        class="self-center text-xs text-gray-500 dark:text-gray-400"
      >
        上次：{{ lastActions.join(' → ') }}
      </span>
    </div>

    <!-- 空态 -->
    <div
      v-if="!hasData && !loading"
      class="border border-gray-300 rounded-lg border-dashed px-6 py-10 text-center text-sm text-gray-500 dark:border-gray-600 dark:text-gray-400"
    >
      还没有牧场数据。进一次游戏里的牧场，或点上面的「刷新」。
    </div>

    <!-- 动物 -->
    <section v-if="animals.length">
      <h2 class="mb-2 text-sm text-gray-700 font-medium dark:text-gray-300">
        动物 <span class="text-gray-400">({{ animals.length }})</span>
      </h2>
      <div class="grid grid-cols-1 gap-3 lg:grid-cols-3 sm:grid-cols-2 xl:grid-cols-4">
        <div
          v-for="animal in animals"
          :key="`${animal.ranchInstId}-${animal.animalInstId}`"
          class="border border-gray-200 rounded-lg bg-white p-3 dark:border-gray-700 dark:bg-gray-800"
        >
          <div class="flex items-start justify-between gap-2">
            <div>
              <div class="text-gray-900 font-medium dark:text-gray-100">
                {{ animal.name }}
              </div>
              <div class="text-xs text-gray-500 dark:text-gray-400">
                栏位 {{ animal.slotIndex }}
                <span v-if="animal.mutation && animal.mutation.tier">
                  · 品阶 {{ animal.mutation.tier }}
                </span>
              </div>
            </div>
            <span
              class="rounded px-1.5 py-0.5 text-[11px] font-medium"
              :class="animalTone(animal).cls"
            >
              {{ animalTone(animal).label }}
            </span>
          </div>
          <div class="mt-2 text-xs text-gray-500 space-y-0.5 dark:text-gray-400">
            <div v-if="animal.readyInSec">
              产物成熟 {{ formatRemain(animal.readyInSec) }}后
            </div>
            <div v-if="animal.canHarvest && animal.expectedHarvestExp">
              预计 +{{ animal.expectedHarvestExp }} 经验
            </div>
            <div v-if="animal.produceCount > 0">
              待收产物 ×{{ animal.produceCount }}
            </div>
            <div v-if="animal.mutation && animal.mutation.weightFinalX10">
              体重 {{ (animal.mutation.weightFinalX10 / 10).toFixed(1) }}
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 货架 / 灾害 / 空栏 -->
    <div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <section class="border border-gray-200 rounded-lg bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <h2 class="mb-2 text-sm text-gray-700 font-medium dark:text-gray-300">
          货架 <span class="text-gray-400">({{ shelves.length }})</span>
        </h2>
        <p v-if="!shelves.length" class="text-xs text-gray-400">
          没有待处理货架
        </p>
        <ul v-else class="text-xs text-gray-600 space-y-1 dark:text-gray-300">
          <li v-for="shelf in shelves" :key="`${shelf.ranchInstId}-${shelf.slotIndex}`">
            槽位 {{ shelf.slotIndex }}：剩余 {{ shelf.totalRemain }}
            <span v-if="shelf.canCollect" class="ml-1 text-emerald-600 dark:text-emerald-400">可收</span>
            <span v-if="shelf.canSteal" class="ml-1 text-amber-600 dark:text-amber-400">可偷</span>
          </li>
        </ul>
      </section>

      <section class="border border-gray-200 rounded-lg bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <h2 class="mb-2 text-sm text-gray-700 font-medium dark:text-gray-300">
          灾害 <span class="text-gray-400">({{ hazards.length }})</span>
        </h2>
        <p v-if="!hazards.length" class="text-xs text-gray-400">
          没有虫或杂草
        </p>
        <ul v-else class="text-xs text-gray-600 space-y-1 dark:text-gray-300">
          <li v-for="hazard in hazards" :key="hazard.hazardId">
            灾害 #{{ hazard.hazardId }}（类型 {{ hazard.hazardType }}）
          </li>
        </ul>
      </section>

      <section class="border border-gray-200 rounded-lg bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <h2 class="mb-2 text-sm text-gray-700 font-medium dark:text-gray-300">
          空栏 <span class="text-gray-400">({{ emptySlots.length }})</span>
        </h2>
        <p v-if="!emptySlots.length" class="text-xs text-gray-400">
          栏位已满
        </p>
        <p v-else class="text-xs text-gray-600 dark:text-gray-300">
          {{ emptySlots.map(s => s.slotIndex).join(', ') }}
        </p>
        <p v-if="status" class="mt-2 text-[11px] text-gray-400">
          提示：自动补栏只放背包里的动物；要不要花钱买，取决于「自动买动物」开关。
        </p>
      </section>
    </div>
  </div>
</template>
