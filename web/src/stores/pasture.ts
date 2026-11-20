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

/** 报价（两段式第一段）。skipped=true 表示当前无事可做，不要发执行请求。 */
export interface PastureQuote {
  action: string
  label: string
  costs: { resourceKey: string, amount: string }[]
  costItems: { id: number, count: string, name: string, image?: string }[]
  rewards: { id: number, count: string, name: string, image?: string }[]
  count: number
  message?: string
  skipped: boolean
  expected: { signature: string }
}

/** 执行回执 */
export interface PastureActionResult {
  status: 'confirmed' | 'skipped'
  costs: { id: number, count: string, name: string }[]
  rewards: { id: number, count: string, name: string }[]
  completed: number
  refreshRequired?: boolean
}

/** 结果未知的写操作，必须人工核对后解除 */
export interface PastureLedgerEntry {
  id: string
  target: string
  label: string
  message: string
  createdAt: number
  costs: { resourceKey: string, amount: string }[]
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
  /** 待核对操作（结果未知的写操作） */
  const ledger = ref<PastureLedgerEntry[]>([])

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
    ledger.value = []
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

  /** 两段式第一段：报价（不发写请求） */
  async function quoteAction(accountId: string, action: string, input: Record<string, unknown> = {}) {
    if (!accountId)
      return null
    const requestedId = String(accountId)
    try {
      const { data } = await api.post(`/api/pasture/${action}/quote`, input, {
        headers: { 'x-account-id': accountId },
      })
      if (!isCurrentAccount(requestedId))
        return null
      if (data && data.ok && data.data)
        return data.data as PastureQuote
      error.value = (data && data.error) || '报价失败'
      return null
    }
    catch (e: any) {
      if (isCurrentAccount(requestedId))
        error.value = e?.response?.data?.error || e?.message || '报价失败'
      return null
    }
  }

  /** 两段式第二段：带签名执行。签名不符时后端会拒（RANCH_OFFER_CHANGED） */
  async function operateAction(
    accountId: string,
    action: string,
    input: Record<string, unknown>,
    signature: string,
  ) {
    if (!accountId)
      return null
    const requestedId = String(accountId)
    operating.value = true
    error.value = ''
    try {
      const { data } = await api.post(`/api/pasture/${action}`, {
        ...input,
        expected: { signature },
      }, {
        headers: { 'x-account-id': accountId },
      })
      if (!isCurrentAccount(requestedId))
        return null
      if (data && data.ok) {
        const result = (data.data || null) as PastureActionResult | null
        if (result && result.rewards?.length)
          lastActions.value = [`${action} 完成`]
        await refreshAfterWrite(requestedId)
        return result
      }
      error.value = (data && data.error) || '操作失败'
      return null
    }
    catch (e: any) {
      if (isCurrentAccount(requestedId))
        error.value = e?.response?.data?.error || e?.message || '操作失败'
      return null
    }
    finally {
      if (isCurrentAccount(requestedId))
        operating.value = false
    }
  }

  /** 写操作之后：面板与待核对列表都要刷新（可能新增了待核对记录） */
  async function refreshAfterWrite(accountId: string) {
    await Promise.all([fetchPasture(accountId), fetchLedger(accountId)])
  }

  /** 待核对操作列表 */
  async function fetchLedger(accountId: string) {
    if (!accountId)
      return
    const requestedId = String(accountId)
    try {
      const { data } = await api.get('/api/pasture/ledger', {
        headers: { 'x-account-id': accountId },
      })
      if (!isCurrentAccount(requestedId))
        return
      if (data && data.ok && Array.isArray(data.data))
        ledger.value = data.data as PastureLedgerEntry[]
    }
    catch { /* 待核对列表只是附加信息，失败不打断主流程 */ }
  }

  /** 人工核对后解除保护 */
  async function acknowledge(accountId: string, id: string) {
    if (!accountId || !id)
      return false
    const requestedId = String(accountId)
    try {
      const { data } = await api.post('/api/pasture/acknowledge', { id }, {
        headers: { 'x-account-id': accountId },
      })
      if (!isCurrentAccount(requestedId))
        return false
      if (data && data.ok) {
        await fetchLedger(accountId)
        return true
      }
      error.value = (data && data.error) || '解除失败'
      return false
    }
    catch (e: any) {
      if (isCurrentAccount(requestedId))
        error.value = e?.response?.data?.error || e?.message || '解除失败'
      return false
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
    ledger,
    clearPastureData,
    fetchPasture,
    operate,
    fetchTasks,
    claimTasks,
    quoteAction,
    operateAction,
    fetchLedger,
    acknowledge,
  }
})
