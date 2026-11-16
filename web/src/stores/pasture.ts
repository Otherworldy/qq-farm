import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/api'
import { useAccountStore } from '@/stores/account'

/** 面板渲染用的动物条目（由后端 buildPanelView 拍平） */
export interface PastureAnimal {
  ranchInstId: number
  slotIndex: number
  animalInstId: number
  animalId: number
  name: string
  stage: number
  stageName: string
  canHarvest: boolean
  canFeed: boolean
  producing: boolean
  grassBlocked: boolean
  produceCount: number
  readyAtMs: number
  readyInSec: number
  expectedHarvestExp: number
  expectedProduceExp: number
  mutation: { type: number, tier: number, weightFinalX10: number, strokable: boolean } | null
}

export interface PastureShelf {
  ranchInstId: number
  slotIndex: number
  totalRemain: number
  canCollect: boolean
  canSteal: boolean
  lots: number
}

export interface PastureHazard {
  ranchInstId: number
  hazardId: number
  hazardType: number
}

export interface PastureSummary {
  animals: number
  capacity: number
  emptySlots: number
  harvestable: number
  collectableShelves: number
  needFeed: number
  needClean: number
  strokable: number
  grassAmount: number
  grassLow: boolean
  nextReadyInSec: number
  expectedHarvestExp: number
  label: string
  hasWork: boolean
}

export interface PastureOpResult {
  hadWork: boolean
  actions: string[]
  label?: string
}

function emptySummary(): PastureSummary {
  return {
    animals: 0,
    capacity: 0,
    emptySlots: 0,
    harvestable: 0,
    collectableShelves: 0,
    needFeed: 0,
    needClean: 0,
    strokable: 0,
    grassAmount: 0,
    grassLow: false,
    nextReadyInSec: 0,
    expectedHarvestExp: 0,
    label: '[]',
    hasWork: false,
  }
}

/** 牧场任务（taskpb scene_id=2，task_type 4/5/6） */
export interface PastureTask {
  id: number
  desc: string
  category: string
  progress: number
  totalProgress: number
  canClaim: boolean
  isClaimed: boolean
  shareMultiple: number
}

export interface PastureTaskSummary {
  total: number
  claimable: number
  items: PastureTask[]
}

export const usePastureStore = defineStore('pasture', () => {
  const summary = ref<PastureSummary>(emptySummary())
  const animals = ref<PastureAnimal[]>([])
  const shelves = ref<PastureShelf[]>([])
  const hazards = ref<PastureHazard[]>([])
  const emptySlots = ref<{ ranchInstId: number, slotIndex: number }[]>([])
  const updatedAt = ref(0)
  const loading = ref(false)
  const operating = ref(false)
  const error = ref('')
  /** 上一次操作的返回，用于面板短期提示 */
  const lastActions = ref<string[]>([])
  const tasks = ref<PastureTask[]>([])
  const taskSummary = ref<{ total: number, claimable: number }>({ total: 0, claimable: 0 })
  const taskLoading = ref(false)

  function clearPastureData() {
    summary.value = emptySummary()
    animals.value = []
    shelves.value = []
    hazards.value = []
    emptySlots.value = []
    updatedAt.value = 0
    error.value = ''
    lastActions.value = []
    tasks.value = []
    taskSummary.value = { total: 0, claimable: 0 }
  }

  function isCurrentAccount(accountId: string) {
    const accountStore = useAccountStore()
    const currentId = String(
      (accountStore.currentAccountId as { value?: string })?.value
      ?? accountStore.currentAccountId
      ?? '',
    )
    return currentId === String(accountId)
  }

  async function fetchPasture(accountId: string) {
    if (!accountId)
      return
    const requestedId = String(accountId)
    loading.value = true
    error.value = ''
    try {
      const { data } = await api.get('/api/pasture', {
        headers: { 'x-account-id': accountId },
      })
      // 账号切走后丢弃过期响应
      if (!isCurrentAccount(requestedId))
        return
      if (data && data.ok && data.data) {
        summary.value = data.data.summary || emptySummary()
        animals.value = data.data.animals || []
        shelves.value = data.data.shelves || []
        hazards.value = data.data.hazards || []
        emptySlots.value = data.data.emptySlots || []
        updatedAt.value = data.data.updatedAt || Date.now()
      }
      else {
        error.value = (data && data.error) || '牧场数据为空'
      }
    }
    catch (e: any) {
      if (isCurrentAccount(requestedId))
        error.value = e?.response?.data?.error || e?.message || '读取牧场失败'
    }
    finally {
      if (isCurrentAccount(requestedId))
        loading.value = false
    }
  }

  async function operate(accountId: string, op = 'all') {
    if (!accountId)
      return null
    operating.value = true
    error.value = ''
    try {
      const { data } = await api.post('/api/pasture/operate', { op }, {
        headers: { 'x-account-id': accountId },
      })
      if (data && data.ok) {
        lastActions.value = (data.data && data.data.actions) || []
        // 操作完立刻刷新一次，面板不用等下一次轮询
        await fetchPasture(accountId)
        return data.data as PastureOpResult
      }
      error.value = (data && data.error) || '操作失败'
      return null
    }
    catch (e: any) {
      error.value = e?.response?.data?.error || e?.message || '操作失败'
      return null
    }
    finally {
      operating.value = false
    }
  }

  async function fetchTasks(accountId: string) {
    if (!accountId)
      return
    taskLoading.value = true
    try {
      const { data } = await api.get('/api/pasture/tasks', {
        headers: { 'x-account-id': accountId },
      })
      if (data && data.ok && data.data) {
        tasks.value = data.data.items || []
        taskSummary.value = {
          total: Number(data.data.total) || 0,
          claimable: Number(data.data.claimable) || 0,
        }
      }
    }
    catch { /* 任务只是附加信息，失败不打断牧场主流程 */ }
    finally {
      taskLoading.value = false
    }
  }

  async function claimTasks(accountId: string) {
    if (!accountId)
      return 0
    taskLoading.value = true
    try {
      const { data } = await api.post('/api/pasture/tasks/claim', {}, {
        headers: { 'x-account-id': accountId },
      })
      const claimed = Number(data?.data?.claimed) || 0
      await fetchTasks(accountId)
      return claimed
    }
    catch (e: any) {
      error.value = e?.response?.data?.error || e?.message || '领取牧场任务失败'
      return 0
    }
    finally {
      taskLoading.value = false
    }
  }

  return {
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
    clearPastureData,
    fetchPasture,
    operate,
    fetchTasks,
    claimTasks,
  }
})
