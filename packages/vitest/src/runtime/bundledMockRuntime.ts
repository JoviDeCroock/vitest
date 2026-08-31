/**
 * Runtime registry for bundle-time `vi.mock` (experimental bundled execution).
 *
 * Factories are registered as thunks by the generated hoist module. The hoist
 * module attempts an eager evaluation (plain and async factories materialize
 * before any import, as hoisting does in the module runner). If the eager
 * attempt throws a ReferenceError — the factory closes over test-file bindings
 * that don't exist in the hoist scope — the entry stays pending and the test
 * file's body re-provides the same factory text compiled in its own scope.
 */
import { fn } from '@vitest/spy'

interface MockEntry {
  value: any
  materialized: boolean
  eagerError: Error | null
  scopedThunk: (() => unknown) | null
}

const entries = new Map<string, MockEntry>()
const hoistedValues = new Map<string, unknown>()
const key = (ctx: string, id: string) => `${ctx}\0${id}`

function getEntry(ctx: string, id: string): MockEntry {
  const k = key(ctx, id)
  if (!entries.has(k)) {
    entries.set(k, { value: undefined, materialized: false, eagerError: null, scopedThunk: null })
  }
  return entries.get(k)!
}

export function __vitestBundledRegisterMock(ctx: string, id: string, namespace: any): void {
  const entry = getEntry(ctx, id)
  entry.value = namespace
  entry.materialized = true
}

export async function __vitestBundledEagerMock(ctx: string, id: string, thunk: () => unknown): Promise<void> {
  const entry = getEntry(ctx, id)
  try {
    entry.value = await thunk()
    entry.materialized = true
  }
  catch (error) {
    if (error instanceof ReferenceError) {
      entry.eagerError = error
    }
    else {
      throw error
    }
  }
}

export function __vitestBundledProvideScopedFactory(ctx: string, id: string, thunk: () => unknown): void {
  const entry = getEntry(ctx, id)
  if (!entry.materialized) {
    entry.scopedThunk = thunk
  }
}

interface DynamicMockEntry {
  actual: any
  active: boolean
  cache: any
}

const dynamicMocks = new Map<string, DynamicMockEntry>()
const pendingActivations = new Set<Promise<void>>()

export function __vitestBundledRegisterDynamicActual(ctx: string, id: string, actual: any): void {
  const k = key(ctx, id)
  if (!dynamicMocks.has(k)) {
    dynamicMocks.set(k, { actual, active: false, cache: undefined })
  }
}

export function __vitestBundledDoMock(
  ctx: string,
  id: string,
  factory: ((importOriginal: () => Promise<any>) => unknown) | null,
  importOriginal: () => Promise<any>,
): void {
  void factory
  void importOriginal
  if (!dynamicMocks.has(key(ctx, id))) {
    throw new Error(`[vitest] vi.doMock target "${id}" was not prepared at bundle time`)
  }
  throw new Error(
    '[vitest] vi.doMock requires re-evaluating consumer modules and is not supported '
    + 'with experimental.bundledExecution yet; use vi.mock instead',
  )
}

export function __vitestBundledDoUnmock(ctx: string, id: string): void {
  const entry = dynamicMocks.get(key(ctx, id))
  if (entry) {
    entry.active = false
    entry.cache = undefined
  }
}

export async function __vitestBundledFlushDoMocks(): Promise<void> {
  if (!pendingActivations.size) {
    return
  }
  const pending = [...pendingActivations]
  pendingActivations.clear()
  await Promise.all(pending)
}

const mutableRegistry = new Map<string, any>()

export function __vitestBundledRegisterMutable(ctx: string, id: string, accessors: any): void {
  mutableRegistry.set(key(ctx, id), accessors)
}

export function __vitestBundledMutableNs(ctx: string, id: string): any {
  const accessors = mutableRegistry.get(key(ctx, id))
  if (!accessors) {
    throw new Error(`[vitest] mutable namespace for "${id}" was not registered (context ${ctx})`)
  }
  return new Proxy(accessors, {
    get: (t, k) => t[k],
    set: (t, k, v) => {
      t[k] = v
      return true
    },
    has: (t, k) => k in t,
    ownKeys: t => Reflect.ownKeys(t),
    getOwnPropertyDescriptor: (t, k) =>
      k in t
        ? { configurable: true, enumerable: true, writable: true, value: t[k] }
        : undefined,
    defineProperty: (t, k, desc) => {
      if ('value' in desc) {
        t[k] = desc.value
      }
      else if (desc.get) {
        t[k] = desc.get()
      }
      return true
    },
  })
}

function materialize(ctx: string, id: string, sync: boolean): any {
  const dynamic = dynamicMocks.get(key(ctx, id))
  if (dynamic) {
    if (!dynamic.active) {
      return dynamic.actual
    }
    if (dynamic.cache === undefined) {
      throw new Error(`[vitest] vi.doMock factory for "${id}" has not resolved yet (import it dynamically)`)
    }
    return dynamic.cache
  }
  const entry = entries.get(key(ctx, id))
  if (!entry) {
    throw new Error(`[vitest] mock for "${id}" was not registered before use (context ${ctx})`)
  }
  if (entry.materialized) {
    return entry.value
  }
  if (entry.scopedThunk) {
    const result = entry.scopedThunk()
    if (result && typeof (result as any).then === 'function') {
      if (sync) {
        throw new TypeError(
          `[vitest] async mock factory for "${id}" references test-file bindings and was imported statically; `
          + `consume it with a dynamic import() inside a test instead`,
        )
      }
      return (result as Promise<any>).then((value) => {
        entry.value = value
        entry.materialized = true
        return value
      })
    }
    entry.value = result
    entry.materialized = true
    return entry.value
  }
  const hint = new Error(
    `[vitest] mock factory for "${id}" references test-file bindings but was consumed before the test file `
    + `evaluated (this pattern fails with a TDZ error in the module runner too). Original error: ${entry.eagerError?.message}`,
  )
  ;(hint as any).cause = entry.eagerError ?? undefined
  throw hint
}

export function __vitestBundledMockNs(ctx: string, id: string): any {
  return materialize(ctx, id, true)
}

export async function __vitestBundledMockNsAsync(ctx: string, id: string): Promise<any> {
  await __vitestBundledFlushDoMocks()
  return materialize(ctx, id, false)
}

let moduleEpoch = 0
const dynamicManifest = new Map<string, string>()
const groupCache = new Map<string, Promise<any>>()

export function __vitestBundledBumpEpoch(): void {
  moduleEpoch++
}

export function __vitestBundledSetDynamicManifest(entries: { filepath: string, url: string }[]): void {
  for (const { filepath, url } of entries) {
    dynamicManifest.set(filepath, url)
  }
}

export async function __vitestBundledDynamicImport(owner: string, id: string, thunk: () => Promise<any>): Promise<any> {
  await __vitestBundledFlushDoMocks()
  const url = dynamicManifest.get(owner)
  if (!url || moduleEpoch === 0) {
    return thunk()
  }
  const cacheKey = `${owner}\0${moduleEpoch}`
  if (!groupCache.has(cacheKey)) {
    const sep = url.includes('?') ? '&' : '?'
    groupCache.set(cacheKey, import(/* @vite-ignore */ `${url}${sep}e=${moduleEpoch}`))
  }
  return groupCache.get(cacheKey)!.then((group) => {
    const exportName = group.__vitestBundledDynMap?.[id]
    return exportName ? group[exportName] : thunk()
  })
}

export function __vitestBundledRegisterHoisted(ctx: string, index: number, value: unknown): void {
  hoistedValues.set(key(ctx, String(index)), value)
}

export function __vitestBundledHoisted(ctx: string, index: number): unknown {
  const k = key(ctx, String(index))
  if (!hoistedValues.has(k)) {
    throw new Error(`[vitest] vi.hoisted value #${index} missing (context ${ctx})`)
  }
  return hoistedValues.get(k)
}

/**
 * Factory-less `vi.mock`: evaluate the actual module and replace function
 * exports with spies. The identity cache guarantees that the same original
 * function maps to the same spy everywhere it appears.
 */
export function __vitestBundledAutomock(actual: any): any {
  const seen = new Map<any, any>()
  const mockValue = (value: any): any => {
    if ((typeof value === 'object' || typeof value === 'function') && value !== null && seen.has(value)) {
      return seen.get(value)
    }
    if (typeof value === 'function') {
      const mock = fn(() => undefined)
      seen.set(value, mock)
      const proto = value.prototype
      if (proto) {
        for (const name of Object.getOwnPropertyNames(proto)) {
          if (name === 'constructor') {
            continue
          }
          const descriptor = Object.getOwnPropertyDescriptor(proto, name)
          if (typeof descriptor?.value === 'function') {
            (mock as any).prototype[name] = fn(() => undefined)
          }
        }
      }
      return mock
    }
    if (Array.isArray(value)) {
      const out: any[] = []
      seen.set(value, out)
      for (const item of value) {
        out.push(mockValue(item))
      }
      return out
    }
    if (value && typeof value === 'object') {
      const out: Record<string, any> = {}
      seen.set(value, out)
      for (const k of Object.keys(value)) {
        out[k] = mockValue(value[k])
      }
      return out
    }
    return value
  }
  const namespace: Record<string, any> = {}
  for (const k of Object.keys(actual)) {
    namespace[k] = mockValue(actual[k])
  }
  return namespace
}
