<script setup lang="ts">
import type { PastureQuote } from '@/stores/pasture'
import { useIntervalFn } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import { useAccountStore } from '@/stores/account'
import { usePastureStore } from '@/stores/pasture'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'

/**
 * 牧场面板。
 *
 * 结构和 FarmPanel 对齐：卡片头 + 药丸汇总 + 内容区，
 * 这样「我的农场 / 我的牧场」两个 tab 看起来是一套东西。
 */

const accountStore = useAccountStore()
const pastureStore = usePastureStore()
const statusStore = useStatusStore()
const toast = useToastStore()

const { currentAccountId } = storeToRefs(accountStore)
const { realtimeConnected } = storeToRefs(statusStore)
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
  tasks,
  taskSummary,
  taskLoading,
  ledger,
} = storeToRefs(pastureStore)

/** 牧场变化慢，20 秒轮询足够，也不会和 bot 抢请求预算 */
const POLL_MS = 20_000

const connected = computed(() => !!realtimeConnected.value)
const hasData = computed(() => summary.value.capacity > 0)

const pills = computed(() => [
  {
    key: 'animals',
    icon: 'i-carbon-home',
    label: `栏位 ${summary.value.animals}/${summary.value.capacity}`,
    cls: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300',
  },
  {
    key: 'harvest',
    icon: 'i-carbon-crop-growth',
    label: `可收 ${summary.value.harvestable}`,
    cls: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  },
  {
    key: 'feed',
    icon: 'i-carbon-wheat',
    label: `待喂 ${summary.value.needFeed}`,
    cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  },
  {
    key: 'clean',
    icon: 'i-carbon-warning',
    label: `灾害 ${summary.value.needClean}`,
    cls: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  },
  {
    key: 'grass',
    icon: 'i-carbon-sprout',
    label: `牧草 ${summary.value.grassAmount}`,
    cls: summary.value.grassLow
      ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400'
      : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  },
  {
    key: 'task',
    icon: 'i-carbon-task',
    label: `任务 ${taskSummary.value.claimable}/${taskSummary.value.total}`,
    cls: taskSummary.value.claimable > 0
      ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300'
      : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
  },
])

const ops = [
  { op: 'harvest', icon: 'i-carbon-crop-growth', label: '收获', hint: '收动物产物与货架', color: 'bg-orange-500 hover:bg-orange-600' },
  { op: 'feed', icon: 'i-carbon-wheat', label: '投喂', hint: '给待喂动物加草', color: 'bg-amber-500 hover:bg-amber-600' },
  { op: 'clean', icon: 'i-carbon-clean', label: '清理', hint: '清除虫与杂草', color: 'bg-rose-500 hover:bg-rose-600' },
  { op: 'stroke', icon: 'i-carbon-touch-1', label: '抚摸', hint: '抚摸推进动物产出', color: 'bg-violet-500 hover:bg-violet-600' },
  { op: 'refill', icon: 'i-carbon-add-alt', label: '补栏', hint: '把背包里的动物放进空栏', color: 'bg-sky-500 hover:bg-sky-600' },
  { op: 'grass', icon: 'i-carbon-plant', label: '补草', hint: '给牧草机加料', color: 'bg-emerald-500 hover:bg-emerald-600' },
]

/**
 * 直接动作：全部走「报价 → 确认 → 执行」两段式。
 * 后端会重新报价并比对签名，所以这里看到的费用就是实际要付的费用；
 * 状态变了会报「牧场状态、商品或费用已变化」，不会闷头扣钱。
 */
const directOps = [
  { action: 'harvest', input: { all: true }, icon: 'i-carbon-crop-growth', label: '一键收获' },
  { action: 'produce', input: { all: true }, icon: 'i-carbon-play-outline', label: '一键生产' },
  { action: 'clean', input: {}, icon: 'i-carbon-clean', label: '一键清理' },
  { action: 'sell', input: { all: true }, icon: 'i-carbon-currency-yen', label: '出售产物' },
  { action: 'claimTasks', input: { all: true }, icon: 'i-carbon-task-complete', label: '领任务' },
  { action: 'claimIllustrated', input: { kind: 'normal' }, icon: 'i-carbon-book', label: '图鉴奖励' },
  { action: 'claimDailyShare', input: {}, icon: 'i-carbon-share', label: '每日分享' },
]

/** 待确认的报价（非空时显示确认弹层） */
const pendingQuote = ref<PastureQuote | null>(null)
const pendingInput = ref<Record<string, unknown>>({})
const quoting = ref(false)

/** 角标优先级：可收获 > 待投喂 > 缺草 > 生产中 */
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

const TASK_CATEGORY_LABEL: Record<string, string> = {
  pasture_growth: '成长',
  pasture_daily: '每日',
  pasture_side: '支线',
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
  if (!currentAccountId.value || !connected.value)
    return
  await pastureStore.fetchPasture(currentAccountId.value)
  if (showError && error.value)
    toast.add(error.value, 'error')
}

async function refreshTasks() {
  if (!currentAccountId.value || !connected.value)
    return
  await pastureStore.fetchTasks(currentAccountId.value)
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
  // 收获/投喂会推进任务进度，顺手刷一次
  void refreshTasks()
}

async function claimTasks() {
  if (!currentAccountId.value || taskLoading.value)
    return
  const claimed = await pastureStore.claimTasks(currentAccountId.value)
  toast.add(claimed > 0 ? `已领取 ${claimed} 个牧场任务` : '没有可领取的牧场任务', claimed > 0 ? 'success' : 'info')
}

/** 第一段：报价。skipped 直接提示，不弹确认。 */
async function requestAction(action: string, input: Record<string, unknown> = {}) {
  if (!currentAccountId.value || operating.value || quoting.value)
    return
  quoting.value = true
  try {
    const quote = await pastureStore.quoteAction(currentAccountId.value, action, input)
    if (!quote) {
      if (error.value)
        toast.add(error.value, 'error')
      return
    }
    if (quote.skipped) {
      toast.add(quote.message || '当前没有可执行的操作', 'info')
      return
    }
    pendingInput.value = input
    pendingQuote.value = quote
  }
  finally {
    quoting.value = false
  }
}

/** 第二段：带签名执行 */
async function confirmAction() {
  const quote = pendingQuote.value
  if (!quote || !currentAccountId.value)
    return
  const result = await pastureStore.operateAction(
    currentAccountId.value,
    quote.action,
    pendingInput.value,
    quote.expected.signature,
  )
  pendingQuote.value = null
  if (!result) {
    if (error.value)
      toast.add(error.value, 'error')
    return
  }
  if (result.status === 'skipped') {
    toast.add(quote.message || '当前没有可执行的操作', 'info')
    return
  }
  const gained = (result.rewards || []).map(r => `${r.name}×${r.count}`).join('、')
  toast.add(gained ? `${quote.label}完成：${gained}` : `${quote.label}完成`, 'success')
  void refreshTasks()
}

function cancelQuote() {
  pendingQuote.value = null
}

/** 待核对操作：人工核对后解除保护，否则同一目标不允许再次提交 */
async function ackOne(id: string) {
  if (!currentAccountId.value)
    return
  const ok = await pastureStore.acknowledge(currentAccountId.value, id)
  toast.add(ok ? '已解除该操作的保护' : (error.value || '解除失败'), ok ? 'success' : 'error')
}

const { pause, resume } = useIntervalFn(() => refresh(false), POLL_MS, { immediate: false })

onMounted(() => {
  void refresh()
  void refreshTasks()
  void pastureStore.fetchLedger(currentAccountId.value)
  resume()
})

watch(currentAccountId, () => {
  pastureStore.clearPastureData()
  void refresh()
  void refreshTasks()
  void pastureStore.fetchLedger(currentAccountId.value)
})

watch(connected, (value) => {
  if (value) {
    void refresh()
    void refreshTasks()
  }
  else {
    pause()
  }
})
</script>

<template>
  <div class="rounded-lg bg-white shadow dark:bg-gray-800">
    <!-- 卡片头 -->
    <div class="flex flex-col items-stretch justify-between gap-3 border-b border-gray-100 p-4 sm:flex-row sm:items-center dark:border-gray-700">
      <div>
        <h3 class="flex items-center gap-2 text-lg font-bold">
          <div class="i-carbon-home text-xl" />
          牧场详情
        </h3>
        <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
          动物、货架、灾害与牧草，和农场共用同一条连接。
          <span v-if="updatedAt">更新于 {{ formatTime(updatedAt) }}</span>
        </p>
      </div>
      <div class="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        <button
          class="flex items-center justify-center gap-1.5 rounded bg-emerald-600 px-3 py-2 text-sm text-white transition disabled:cursor-not-allowed hover:bg-emerald-700 disabled:opacity-50"
          :disabled="!connected || operating"
          @click="runOp('all')"
        >
          <div class="i-carbon-play" />
          一键执行
        </button>
        <button
          class="flex items-center justify-center gap-1.5 rounded bg-gray-500 px-3 py-2 text-sm text-white transition disabled:cursor-not-allowed hover:bg-gray-600 disabled:opacity-50"
          :disabled="loading"
          @click="refresh()"
        >
          <div class="i-carbon-renew" />
          刷新
        </button>
      </div>
    </div>

    <!-- 药丸汇总 -->
    <div class="grid grid-cols-3 gap-2 border-b border-gray-100 bg-gray-50 p-3 text-xs sm:flex sm:flex-wrap sm:gap-4 dark:border-gray-700 dark:bg-gray-900/50 sm:p-4">
      <div
        v-for="pill in pills"
        :key="pill.key"
        class="flex items-center gap-1.5 rounded-full px-3 py-1"
        :class="pill.cls"
      >
        <div :class="pill.icon" />
        <span class="font-medium">{{ pill.label }}</span>
      </div>
    </div>

    <!-- 未连接 -->
    <div
      v-if="!connected"
      class="m-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-200"
    >
      账号未连接，牧场数据不可用。等登录恢复后会自动刷新。
    </div>

    <div class="p-2 sm:p-4">
      <!-- 空态 -->
      <div
        v-if="!hasData && !loading"
        class="border border-gray-300 rounded-lg border-dashed px-6 py-10 text-center text-sm text-gray-500 dark:border-gray-600 dark:text-gray-400"
      >
        还没有牧场数据。进一次游戏里的牧场，或点上面的「刷新」。
      </div>

      <template v-else>
        <!-- 待核对操作：结果未知的写操作，必须先人工核对 -->
        <div
          v-if="ledger.length"
          class="mb-4 border border-amber-300 rounded-lg bg-amber-50 p-3 text-xs dark:border-amber-700 dark:bg-amber-900/20"
        >
          <div class="mb-2 flex items-center gap-1.5 text-amber-800 font-semibold dark:text-amber-200">
            <div class="i-carbon-warning-alt" />
            有 {{ ledger.length }} 个操作结果未确认
          </div>
          <div
            v-for="entry in ledger"
            :key="entry.id"
            class="mb-1.5 flex flex-wrap items-center justify-between gap-2 rounded bg-white/60 px-2 py-1.5 dark:bg-gray-800/60"
          >
            <span class="text-amber-900 dark:text-amber-100">
              {{ entry.label }} · {{ entry.message }}
            </span>
            <button
              class="rounded bg-amber-600 px-2 py-1 text-white transition hover:bg-amber-700"
              @click="ackOne(entry.id)"
            >
              核对完成
            </button>
          </div>
        </div>

        <!-- 直接动作（报价 → 确认 → 执行） -->
        <div class="grid grid-cols-3 mb-4 gap-2 sm:flex sm:flex-wrap">
          <button
            v-for="item in directOps"
            :key="item.action"
            class="flex items-center justify-center gap-1.5 border border-gray-300 rounded px-3 py-2 text-sm text-gray-700 transition disabled:cursor-not-allowed dark:border-gray-600 hover:bg-gray-100 dark:text-gray-200 disabled:opacity-50 dark:hover:bg-gray-700"
            :disabled="!connected || operating || quoting"
            @click="requestAction(item.action, item.input)"
          >
            <div :class="item.icon" />
            <span>{{ item.label }}</span>
          </button>
        </div>

        <!-- 单项操作 -->
        <div class="grid grid-cols-3 mb-4 gap-2 sm:flex sm:flex-wrap">
          <button
            v-for="item in ops"
            :key="item.op"
            class="flex items-center justify-center gap-1.5 rounded px-3 py-2 text-sm text-white transition disabled:cursor-not-allowed disabled:opacity-50"
            :class="item.color"
            :disabled="!connected || operating"
            :title="item.hint"
            @click="runOp(item.op)"
          >
            <div :class="item.icon" />
            <span>{{ item.label }}</span>
          </button>
        </div>
        <p v-if="lastActions.length" class="mb-4 text-xs text-gray-500 dark:text-gray-400">
          上次：{{ lastActions.join(' → ') }}
        </p>

        <!-- 动物 -->
        <section v-if="animals.length" class="mb-4">
          <h4 class="mb-2 flex items-center gap-2 text-sm text-gray-700 font-medium dark:text-gray-300">
            <div class="i-carbon-home" />
            动物 <span class="text-gray-400">({{ animals.length }})</span>
          </h4>
          <div class="grid grid-cols-1 gap-3 lg:grid-cols-3 sm:grid-cols-2 xl:grid-cols-4">
            <div
              v-for="animal in animals"
              :key="`${animal.ranchInstId}-${animal.animalInstId}`"
              class="rounded-lg bg-gray-50 p-3 dark:bg-gray-900/50"
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
        <div class="grid grid-cols-1 mb-4 gap-4 lg:grid-cols-3">
          <section class="rounded-lg bg-gray-50 p-4 dark:bg-gray-900/50">
            <h4 class="mb-2 text-sm text-gray-700 font-medium dark:text-gray-300">
              货架 <span class="text-gray-400">({{ shelves.length }})</span>
            </h4>
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

          <section class="rounded-lg bg-gray-50 p-4 dark:bg-gray-900/50">
            <h4 class="mb-2 text-sm text-gray-700 font-medium dark:text-gray-300">
              灾害 <span class="text-gray-400">({{ hazards.length }})</span>
            </h4>
            <p v-if="!hazards.length" class="text-xs text-gray-400">
              没有虫或杂草
            </p>
            <ul v-else class="text-xs text-gray-600 space-y-1 dark:text-gray-300">
              <li v-for="hazard in hazards" :key="hazard.hazardId">
                灾害 #{{ hazard.hazardId }}（类型 {{ hazard.hazardType }}）
              </li>
            </ul>
          </section>

          <section class="rounded-lg bg-gray-50 p-4 dark:bg-gray-900/50">
            <h4 class="mb-2 text-sm text-gray-700 font-medium dark:text-gray-300">
              空栏 <span class="text-gray-400">({{ emptySlots.length }})</span>
            </h4>
            <p v-if="!emptySlots.length" class="text-xs text-gray-400">
              栏位已满
            </p>
            <p v-else class="text-xs text-gray-600 dark:text-gray-300">
              {{ emptySlots.map(s => s.slotIndex).join(', ') }}
            </p>
            <p class="mt-2 text-[11px] text-gray-400">
              自动补栏只放背包里的动物；要不要花钱买，取决于「自动买动物」开关。
            </p>
          </section>
        </div>

        <!-- 牧场任务 -->
        <section class="rounded-lg bg-gray-50 p-4 dark:bg-gray-900/50">
          <div class="mb-2 flex items-center justify-between gap-2">
            <h4 class="flex items-center gap-2 text-sm text-gray-700 font-medium dark:text-gray-300">
              <div class="i-carbon-task" />
              牧场任务
              <span class="text-gray-400">({{ taskSummary.claimable }}/{{ taskSummary.total }} 可领)</span>
            </h4>
            <button
              class="flex items-center gap-1 rounded bg-violet-600 px-2.5 py-1 text-xs text-white transition disabled:cursor-not-allowed hover:bg-violet-700 disabled:opacity-50"
              :disabled="!connected || taskLoading || taskSummary.claimable === 0"
              @click="claimTasks"
            >
              <div class="i-carbon-download" />
              领取
            </button>
          </div>
          <p v-if="!tasks.length" class="text-xs text-gray-400">
            没有进行中的牧场任务（自动化开启时会自己领）
          </p>
          <ul v-else class="text-xs text-gray-600 space-y-1 dark:text-gray-300">
            <li
              v-for="task in tasks"
              :key="task.id"
              class="flex items-center justify-between gap-2 rounded bg-white px-2 py-1 dark:bg-gray-800"
            >
              <div class="min-w-0 flex items-center gap-1.5">
                <span class="shrink-0 rounded bg-gray-100 px-1 text-[10px] text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                  {{ TASK_CATEGORY_LABEL[task.category] || task.category }}
                </span>
                <span class="truncate" :title="task.desc">{{ task.desc }}</span>
              </div>
              <div class="flex shrink-0 items-center gap-1.5">
                <span class="text-gray-400 tabular-nums">
                  {{ task.progress }}/{{ task.totalProgress }}
                </span>
                <span v-if="task.canClaim" class="rounded bg-emerald-100 px-1 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                  可领
                </span>
                <span v-else-if="task.isClaimed" class="text-gray-400">
                  已领
                </span>
              </div>
            </li>
          </ul>
        </section>
      </template>
    </div>

    <!-- 报价确认弹层 -->
    <div
      v-if="pendingQuote"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      @click.self="cancelQuote"
    >
      <div class="max-w-sm w-full rounded-lg bg-white p-4 shadow-xl dark:bg-gray-800">
        <h4 class="mb-2 text-base font-bold">
          {{ pendingQuote.label }}
        </h4>
        <p v-if="pendingQuote.message" class="mb-2 text-xs text-amber-600 dark:text-amber-400">
          {{ pendingQuote.message }}
        </p>
        <div v-if="pendingQuote.count > 1" class="mb-2 text-xs text-gray-500 dark:text-gray-400">
          数量：{{ pendingQuote.count }}
        </div>
        <div v-if="pendingQuote.costItems.length" class="mb-2 text-xs">
          <div class="mb-1 text-gray-600 font-medium dark:text-gray-300">
            消耗
          </div>
          <div v-for="item in pendingQuote.costItems" :key="item.id" class="text-rose-600 dark:text-rose-400">
            {{ item.name }} ×{{ item.count }}
          </div>
        </div>
        <div v-if="pendingQuote.rewards.length" class="mb-2 text-xs">
          <div class="mb-1 text-gray-600 font-medium dark:text-gray-300">
            预计获得
          </div>
          <div v-for="item in pendingQuote.rewards" :key="item.id" class="text-emerald-600 dark:text-emerald-400">
            {{ item.name }} ×{{ item.count }}
          </div>
        </div>
        <div class="mt-3 flex justify-end gap-2">
          <button
            class="rounded bg-gray-200 px-3 py-1.5 text-sm text-gray-700 transition dark:bg-gray-700 hover:bg-gray-300 dark:text-gray-200"
            @click="cancelQuote"
          >
            取消
          </button>
          <button
            class="rounded bg-emerald-600 px-3 py-1.5 text-sm text-white transition hover:bg-emerald-700 disabled:opacity-50"
            :disabled="operating"
            @click="confirmAction"
          >
            确认执行
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
