import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import api from '@/api'
import { useAccountStore } from './account'

function resolveAccountId(): string {
  const accountStore = useAccountStore()
  const raw = accountStore.currentAccountId as unknown
  const value = (raw as { value?: unknown })?.value ?? raw
  return String(value ?? '')
}

export const useStealWhitelistStore = defineStore('steal-whitelist', () => {
  const whitelist = ref<number[]>([])
  const loading = ref(false)
  const saving = ref(false)
  let fetchRequestId = 0

  const restricted = computed(() => whitelist.value.length > 0)

  function clearWhitelistData() {
    whitelist.value = []
    loading.value = false
    saving.value = false
  }

  async function fetchWhitelist() {
    const accountId = resolveAccountId()
    if (!accountId)
      return
    const requestId = ++fetchRequestId
    loading.value = true
    try {
      const res = await api.get('/api/steal-whitelist', {
        headers: { 'x-account-id': accountId },
      })
      if (requestId !== fetchRequestId)
        return
      if (res.data.ok)
        whitelist.value = res.data.data || []
    }
    catch { /* ignore */ }
    finally {
      if (requestId === fetchRequestId)
        loading.value = false
    }
  }

  async function saveWhitelist(seedIds: number[]) {
    const accountId = resolveAccountId()
    if (!accountId)
      return false
    saving.value = true
    try {
      const res = await api.put('/api/steal-whitelist', { seedIds }, {
        headers: { 'x-account-id': accountId },
      })
      if (res.data.ok) {
        whitelist.value = res.data.data || []
        return true
      }
      return false
    }
    catch {
      return false
    }
    finally {
      saving.value = false
    }
  }

  return {
    whitelist,
    loading,
    saving,
    restricted,
    clearWhitelistData,
    fetchWhitelist,
    saveWhitelist,
  }
})
