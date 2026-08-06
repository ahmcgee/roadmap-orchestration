export async function parallel(thunks = []) {
  return Promise.all(thunks.map(async (thunk) => {
    try { return await thunk() } catch { return null }
  }))
}
export async function pipeline(items = [], stages = []) {
  return Promise.all(items.map(async (item, index) => {
    let previous = item
    try {
      for (const stage of stages) previous = await stage(previous, item, index)
      return previous
    } catch {
      return null
    }
  }))
}

export function createBudget(total = null) {
  let used = 0
  return {
    total,
    spent: () => used,
    remaining: () => total == null ? Infinity : Math.max(0, total - used),
    add: (amount = 0) => { used += Number.isFinite(amount) ? amount : 0 },
  }
}
