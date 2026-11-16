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
    grassAmount: 0,
    grassLow: false,
    nextReadyInSec: 0,
    expectedHarvestExp: 0,
    label: '[]',
    hasWork: false,
  }
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

  function clearPastureData() {
    summary.value = emptySummary()
    animals.value = []
    shelves.value = []
    hazards.value = []
    emptySlots.value = []
    updatedAt.value = 0
    error.value = ''
    lastActions.value = []
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
    clearPastureData,
    fetchPasture,
    operate,
  }
})
