<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import api from '@/api'
import { useAccountStore } from '@/stores/account'
import { useStealWhitelistStore } from '@/stores/steal-whitelist'

interface CropOption {
  seedId: number
  name: string
  image?: string
}

const accountStore = useAccountStore()
const whitelistStore = useStealWhitelistStore()

const crops = ref<CropOption[]>([])
const cropsLoading = ref(false)
const keyword = ref('')
const draft = ref<number[]>([])
const saving = ref(false)
const tip = ref('')

const activeAccountId = computed(() => {
  const raw = accountStore.currentAccountId as unknown
  const value = (raw as { value?: unknown })?.value ?? raw
  return String(value ?? '')
})

const filteredCrops = computed(() => {
  const q = keyword.value.trim().toLowerCase()
  if (!q)
    return crops.value
  return crops.value.filter(crop =>
    crop.name.toLowerCase().includes(q) || String(crop.seedId).includes(q),
  )
})

const dirty = computed(() => {
  const a = [...draft.value].sort((x, y) => x - y)
  const b = [...whitelistStore.whitelist].sort((x, y) => x - y)
  return a.length !== b.length || a.some((value, index) => value !== b[index])
})

function isSelected(seedId: number) {
  return draft.value.includes(seedId)
}

function toggle(seedId: number) {
  draft.value = isSelected(seedId)
    ? draft.value.filter(id => id !== seedId)
    : [...draft.value, seedId]
  tip.value = ''
}

function selectVisible() {
  const ids = filteredCrops.value.map(crop => crop.seedId)
  draft.value = Array.from(new Set([...draft.value, ...ids]))
  tip.value = ''
}

function clearAll() {
  draft.value = []
  tip.value = ''
}

async function loadCrops() {
  const accountId = activeAccountId.value
  if (!accountId)
    return
  cropsLoading.value = true
  try {
    const res = await api.get('/api/analytics', {
      headers: { 'x-account-id': accountId },
    })
    const data = res.data.data
    crops.value = Array.isArray(data)
      ? data
          .map((item: any) => ({
            seedId: Number(item?.seedId) || 0,
            name: String(item?.name || ''),
            image: item?.image,
          }))
          .filter(crop => crop.seedId > 0)
      : []
  }
  catch {
    crops.value = []
  }
  finally {
    cropsLoading.value = false
  }
}

async function save() {
  saving.value = true
  const ok = await whitelistStore.saveWhitelist(draft.value)
  saving.value = false
  tip.value = ok
    ? (draft.value.length > 0 ? `已保存：只偷 ${draft.value.length} 种作物` : '已清空：恢复全部偷取')
    : '保存失败'
}

watch(() => whitelistStore.whitelist, (value) => {
  draft.value = [...value]
}, { immediate: true, deep: true })

watch(activeAccountId, async (id) => {
  crops.value = []
  draft.value = []
  tip.value = ''
  if (!id)
    return
  await Promise.all([loadCrops(), whitelistStore.fetchWhitelist()])
})

onMounted(async () => {
  if (!activeAccountId.value)
    return
  await Promise.all([loadCrops(), whitelistStore.fetchWhitelist()])
})
</script>

<template>
  <div class="border border-sky-200 rounded-lg bg-sky-50/70 p-3 space-y-3 dark:border-sky-800/50 dark:bg-sky-900/20">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div class="text-sm text-sky-900 font-semibold dark:text-sky-200">
          偷菜作物白名单
        </div>
        <p class="mt-1 text-xs text-sky-700/90 leading-5 dark:text-sky-300/90">
          留空表示全部偷取（仍受植物黑名单约束）。勾选后只偷选中的作物，其它作物成熟也不出手。
        </p>
      </div>
      <span
        class="shrink-0 rounded px-2 py-1 text-xs"
        :class="draft.length > 0
          ? 'bg-sky-100 text-sky-700 dark:bg-sky-900/50 dark:text-sky-300'
          : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'"
      >
        {{ draft.length > 0 ? `只偷 ${draft.length} 种` : '不限制' }}
      </span>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <input
        v-model="keyword"
        type="text"
        placeholder="搜索作物名或 ID"
        class="min-w-40 flex-1 border border-sky-200 rounded bg-white px-2 py-1 text-sm dark:border-sky-800/60 dark:bg-gray-800 dark:text-gray-200"
      >
      <button
        class="rounded bg-sky-100 px-2 py-1 text-xs text-sky-700 transition dark:bg-sky-900/50 hover:bg-sky-200 dark:text-sky-300 dark:hover:bg-sky-900/70"
        @click="selectVisible"
      >
        全选当前
      </button>
      <button
        class="rounded bg-gray-100 px-2 py-1 text-xs text-gray-600 transition dark:bg-gray-700 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-600"
        @click="clearAll"
      >
        清空
      </button>
    </div>

    <div v-if="cropsLoading" class="py-4 text-center text-sm text-sky-700 dark:text-sky-300">
      加载作物列表...
    </div>
    <div v-else-if="filteredCrops.length === 0" class="py-4 text-center text-sm text-gray-500 dark:text-gray-400">
      没有匹配的作物
    </div>
    <div v-else class="grid grid-cols-1 max-h-72 gap-1.5 overflow-y-auto lg:grid-cols-3 sm:grid-cols-2">
      <label
        v-for="crop in filteredCrops"
        :key="crop.seedId"
        class="flex cursor-pointer items-center gap-2 border rounded px-2 py-1.5 transition"
        :class="isSelected(crop.seedId)
          ? 'border-sky-400 bg-sky-100 dark:border-sky-500 dark:bg-sky-900/40'
          : 'border-gray-200 bg-white dark:border-gray-600 dark:bg-gray-800'"
      >
        <input
          type="checkbox"
          :checked="isSelected(crop.seedId)"
          @change="toggle(crop.seedId)"
        >
        <img v-if="crop.image" :src="crop.image" class="h-6 w-6 object-contain" loading="lazy">
        <div v-else class="i-carbon-sprout h-6 w-6 shrink-0 text-gray-400" />
        <span class="min-w-0 flex-1 truncate text-xs text-gray-700 dark:text-gray-300">{{ crop.name }}</span>
        <span class="shrink-0 text-[10px] text-gray-400">{{ crop.seedId }}</span>
      </label>
    </div>

    <div class="flex items-center justify-between gap-2">
      <span
        class="text-xs"
        :class="tip.includes('失败') ? 'text-red-600 dark:text-red-400' : 'text-sky-700 dark:text-sky-300'"
      >
        {{ tip }}
      </span>
      <button
        class="rounded px-3 py-1.5 text-xs transition disabled:opacity-50"
        :class="dirty
          ? 'bg-sky-600 text-white hover:bg-sky-700'
          : 'bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-400'"
        :disabled="!dirty || saving"
        @click="save"
      >
        {{ saving ? '保存中...' : '保存白名单' }}
      </button>
    </div>
  </div>
</template>
