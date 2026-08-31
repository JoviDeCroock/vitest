/**
 * Bundle-time `vi.mock` for experimental bundled execution. Instead of
 * intercepting module requests at runtime, the bundler compiles mocks away:
 *
 * - Each test file's top-level `vi.mock`/`vi.unmock`/`vi.hoisted` calls are
 *   extracted during transform. A file with mocks gets a private context (ctx).
 * - Factories and hoisted blocks move into a virtual hoist module
 *   (`\0vitest-bundled-hoist:<file>`). The hoist module eagerly evaluates each
 *   factory (top-level await; factories receive `importOriginal`); factories
 *   that reference test-file bindings defer to a scoped copy the test file
 *   re-provides when its body runs (see bundledMockRuntime.ts).
 * - Project-source modules imported (transitively) by a mocking file are
 *   cloned per context via an id query (`?v-bundled-mock=<ctx>`), so two
 *   suites can mock the same module differently while non-mocking suites share
 *   the pristine graph. node_modules stay shared.
 * - Every ctx module that reads mocks also imports the hoist module, making
 *   registration a hard dependency of consumption — chunk-splitting cannot
 *   reorder them.
 * - Imports of mocked ids are rewritten to synchronous registry destructures;
 *   dynamic imports and `vi.importMock` go through the async accessor;
 *   `vi.importActual` compiles to a pristine dynamic import.
 */
import type { Plugin } from 'vite'
import { existsSync } from 'node:fs'
import MagicString from 'magic-string'
import { basename, dirname, extname, join } from 'pathe'
import { parseAst } from 'vite'

const JS_RE = /\.(?:[cm]?[jt]s|[jt]sx)$/
const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts']

export const HOIST_PREFIX = '\0vitest-bundled-hoist:'
export const DYN_GROUP_PREFIX = 'virtual:vitest-bundled-dyn/'
const MOCK_QUERY = 'v-bundled-mock'
const ACTUAL_QUERY = 'v-bundled-actual'
const DYNCTX_QUERY = 'v-bundled-dynctx'

function splitQuery(id: string): [string, string | null] {
  const index = id.indexOf('?')
  return index === -1 ? [id, null] : [id.slice(0, index), id.slice(index + 1)]
}

function hashCtx(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i++) {
    hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0
  }
  return hash.toString(36)
}

function walk(node: any, visit: (node: any) => void): void {
  if (!node || typeof node.type !== 'string') {
    return
  }
  visit(node)
  for (const key of Object.keys(node)) {
    const value = node[key]
    if (Array.isArray(value)) {
      for (const child of value) {
        walk(child, visit)
      }
    }
    else if (value && typeof value.type === 'string') {
      walk(value, visit)
    }
  }
}

function viCall(node: any): string | null {
  if (
    node?.type === 'CallExpression'
    && node.callee?.type === 'MemberExpression'
    && node.callee.object?.type === 'Identifier'
    && (node.callee.object.name === 'vi' || node.callee.object.name === 'vitest')
    && node.callee.property?.type === 'Identifier'
  ) {
    return node.callee.property.name
  }
  return null
}

function keyFor(name: string): string {
  return /^[A-Z_$][\w$]*$/i.test(name) ? name : JSON.stringify(name)
}

interface Edit {
  start: number
  end: number
  replacement: string
}

function spliceEdits(text: string, offset: number, edits: Edit[]): string {
  let out = text
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start - offset) + edit.replacement + out.slice(edit.end - offset)
  }
  return out
}

export interface BundledMockState {
  contexts: Map<string, { file: string, mocks: Map<string, 'static' | 'dynamic'>, mutables: Set<string> }>
  fileCtx: Map<string, string>
  hoistModules: Map<string, string>
}

export interface BundledMockPluginOptions {
  root: string
  runtimePath: string
  testFiles: string[]
  dynGroups?: Map<string, Set<string>>
  state?: BundledMockState
}

export function createBundledMockPlugins(options: BundledMockPluginOptions): Plugin[] {
  const { root, runtimePath, testFiles, dynGroups = new Map<string, Set<string>>() } = options
  const testFileSet = new Set(testFiles)
  const contexts = options.state?.contexts ?? new Map()
  const fileCtx = options.state?.fileCtx ?? new Map()
  const hoistModules = options.state?.hoistModules ?? new Map()
  const dynOwners = new Map([...dynGroups.keys()].map(file => [hashCtx(file), file]))

  const isClonable = (id: string) =>
    id.startsWith(root)
    && !id.includes('/node_modules/')
    && !id.startsWith('\0')
    && JS_RE.test(id)

  function findMocksFile(rid: string, spec: string): string | undefined {
    const candidates: string[] = []
    if (spec.startsWith('.') || spec.startsWith('/')) {
      const dir = join(dirname(rid), '__mocks__')
      const base = basename(rid)
      const stem = base.slice(0, base.length - extname(base).length)
      candidates.push(join(dir, base), ...EXTS.map(ext => join(dir, stem + ext)))
    }
    else {
      const dir = join(root, '__mocks__')
      candidates.push(join(dir, spec), ...EXTS.map(ext => join(dir, spec + ext)))
    }
    return candidates.find(candidate => existsSync(candidate))
  }

  const resolvePlugin: Plugin = {
    name: 'vitest:bundled-mock-resolve',
    enforce: 'pre',
    async resolveId(source, importer, resolveOptions) {
      if (source.startsWith(HOIST_PREFIX)) {
        return source
      }
      if (source.startsWith(DYN_GROUP_PREFIX)) {
        return `\0${source}`
      }
      if (!importer) {
        return null
      }

      const [sourcePath, sourceQuery] = splitQuery(source)
      const [importerPath, importerQuery] = splitQuery(importer)

      if (sourceQuery === ACTUAL_QUERY) {
        const resolved = await this.resolve(sourcePath, importerPath, { ...resolveOptions, skipSelf: true })
        return resolved ?? sourcePath
      }

      if (sourceQuery?.startsWith(`${DYNCTX_QUERY}=`)) {
        return source
      }

      if (importer.startsWith(HOIST_PREFIX)) {
        return null
      }

      if (importerQuery?.startsWith(`${DYNCTX_QUERY}=`)) {
        const dynCtx = importerQuery.slice(DYNCTX_QUERY.length + 1)
        const resolved = await this.resolve(source, importerPath, { ...resolveOptions, skipSelf: true })
        if (!resolved || resolved.external) {
          return resolved
        }
        const [rid, ridQuery] = splitQuery(resolved.id)
        if (ridQuery || !isClonable(rid)) {
          return resolved
        }
        return `${rid}?${DYNCTX_QUERY}=${dynCtx}`
      }

      let ctx: string | null = null
      if (importerQuery?.startsWith(`${MOCK_QUERY}=`)) {
        ctx = importerQuery.slice(MOCK_QUERY.length + 1)
      }
      else {
        ctx = fileCtx.get(importerPath) ?? null
      }
      if (!ctx) {
        return null
      }

      const resolved = await this.resolve(source, importerPath, { ...resolveOptions, skipSelf: true })
      if (!resolved || resolved.external) {
        return resolved
      }
      const [rid, ridQuery] = splitQuery(resolved.id)
      if (ridQuery || !isClonable(rid)) {
        return resolved
      }
      return `${rid}?${MOCK_QUERY}=${ctx}`
    },
    async load(id) {
      if (id.startsWith(HOIST_PREFIX)) {
        return hoistModules.get(id) ?? null
      }
      if (id.startsWith(`\0${DYN_GROUP_PREFIX}`)) {
        const file = id.slice(DYN_GROUP_PREFIX.length + 1)
        try {
          await (this as any).load({ id: file })
        }
        catch {}
        const targets = [...(dynGroups.get(file) ?? [])]
        const ctx = hashCtx(file)
        const lines = targets.map(
          (target, i) => `export * as m${i} from ${JSON.stringify(`${target}?${DYNCTX_QUERY}=${ctx}`)};`,
        )
        lines.push(
          `export const __vitestBundledDynMap = ${JSON.stringify(Object.fromEntries(targets.map((t, i) => [t, `m${i}`])))};`,
        )
        return lines.join('\n')
      }
    },
  }

  const transformPlugin: Plugin = {
    name: 'vitest:bundled-mock-transform',
    enforce: 'post',
    async transform(code, id) {
      const [path, rawQuery] = splitQuery(id)
      const params = rawQuery ? new URLSearchParams(rawQuery) : null
      let cloneCtx = params?.get(MOCK_QUERY) ?? null
      if (!cloneCtx && params) {
        const dynHash = params.get(DYNCTX_QUERY)
        const owner = dynHash && dynOwners.get(dynHash)
        const ownerCtx = owner && fileCtx.get(owner)
        if (ownerCtx) {
          cloneCtx = ownerCtx
        }
      }
      const isTestEntry = !cloneCtx && testFileSet.has(path)
      if (!cloneCtx && !isTestEntry) {
        return null
      }
      if (path.startsWith('\0')) {
        return null
      }
      if (
        isTestEntry
        && !/\b(?:vi|vitest)\s*\.\s*(?:mock|unmock|doMock|doUnmock|hoisted|importActual|importMock|resetModules|spyOn)\b/.test(
          code,
        )
      ) {
        return null
      }

      let program: any
      try {
        program = parseAst(code)
      }
      catch {
        return null
      }
      const body = program.body
      const magic = new MagicString(code)
      const removedRanges: [number, number][] = []
      const inRemoved = (node: any) => removedRanges.some(([s, e]) => node.start >= s && node.end <= e)
      let edited = false

      let ctx: string
      let mocks: Map<string, 'static' | 'dynamic'>
      let hasHoistModule = false
      let ctxMutables = new Set<string>()
      let mutableTarget = false

      const rewriteFactoryText = async (factoryNode: any): Promise<string> => {
        const edits: Edit[] = []
        const calls: any[] = []
        walk(factoryNode, (node) => {
          if (viCall(node) === 'importActual' && node.arguments[0]?.type === 'Literal') {
            calls.push(node)
          }
        })
        for (const call of calls) {
          const spec = call.arguments[0].value
          if (typeof spec !== 'string') {
            continue
          }
          const resolved = await this.resolve(spec, path, { skipSelf: true })
          if (!resolved) {
            continue
          }
          const rid = splitQuery(resolved.id)[0]
          const isBare = !spec.startsWith('.') && !spec.startsWith('/')
          const actual = `${isBare ? spec : rid}?${ACTUAL_QUERY}`
          edits.push({ start: call.start, end: call.end, replacement: `import(${JSON.stringify(actual)})` })
        }
        return spliceEdits(code.slice(factoryNode.start, factoryNode.end), factoryNode.start, edits)
      }

      // phase 1 (test entries only): extract vi.mock / vi.hoisted
      if (isTestEntry) {
        ctx = hashCtx(path)
        mocks = new Map()
        let pending: any[] = []
        const statementActions: { stmt: any, kind: string, entry?: any }[] = []
        let hoistIndex = 0

        for (const stmt of body) {
          const expr = stmt.type === 'ExpressionStatement' ? stmt.expression : null
          const method = expr ? viCall(expr) : null

          if (method === 'mock' || method === 'unmock') {
            const arg0 = expr.arguments[0]
            if (arg0?.type !== 'Literal' || typeof arg0.value !== 'string') {
              this.warn(`vi.${method} with a non-literal specifier in ${path} is unsupported in bundled execution`)
              continue
            }
            const resolved = await this.resolve(arg0.value, path, { skipSelf: true })
            if (!resolved) {
              this.warn(`vi.${method}(${JSON.stringify(arg0.value)}) in ${path} did not resolve`)
              continue
            }
            const rid = splitQuery(resolved.id)[0]
            if (method === 'unmock') {
              mocks.delete(rid)
              pending = pending.filter(p => !(p.kind === 'mock' && p.rid === rid))
              statementActions.push({ stmt, kind: 'remove' })
            }
            else {
              const spec = arg0.value
              const isBare = !spec.startsWith('.') && !spec.startsWith('/')
              const actualSpec = `${isBare ? spec : rid}?${ACTUAL_QUERY}`
              const factoryNode = expr.arguments[1]
              const isFactory
                = factoryNode
                  && (factoryNode.type === 'ArrowFunctionExpression' || factoryNode.type === 'FunctionExpression')
              const factoryText = isFactory ? await rewriteFactoryText(factoryNode) : null
              mocks.set(rid, 'static')
              const entry = { kind: 'mock', rid, spec, actualSpec, factoryText }
              pending.push(entry)
              statementActions.push({ stmt, kind: factoryText ? 'provide' : 'remove', entry })
            }
            continue
          }

          if (method === 'hoisted') {
            const fnNode = expr.arguments[0]
            if (!fnNode) {
              continue
            }
            const n = hoistIndex++
            pending.push({ kind: 'hoisted', n, patternText: null, fnText: code.slice(fnNode.start, fnNode.end) })
            statementActions.push({ stmt, kind: 'remove' })
            continue
          }

          if (stmt.type === 'VariableDeclaration') {
            for (const decl of stmt.declarations) {
              if (viCall(decl.init) !== 'hoisted') {
                continue
              }
              const fnNode = decl.init.arguments[0]
              if (!fnNode) {
                continue
              }
              const n = hoistIndex++
              pending.push({
                kind: 'hoisted',
                n,
                patternText: code.slice(decl.id.start, decl.id.end),
                fnText: code.slice(fnNode.start, fnNode.end),
              })
              magic.overwrite(decl.init.start, decl.init.end, `__vitestBundledHoisted(${JSON.stringify(ctx)}, ${n})`)
              removedRanges.push([decl.init.start, decl.init.end])
              edited = true
            }
          }
        }

        for (const action of statementActions) {
          const { stmt } = action
          if (action.kind === 'provide' && pending.includes(action.entry)) {
            const e = action.entry
            magic.overwrite(
              stmt.start,
              stmt.end,
              `__vitestBundledProvideScopedFactory(${JSON.stringify(ctx)}, ${JSON.stringify(e.rid)}, `
              + `() => (${e.factoryText})(() => import(${JSON.stringify(e.actualSpec)})));`,
            )
          }
          else {
            magic.remove(stmt.start, stmt.end)
          }
          removedRanges.push([stmt.start, stmt.end])
          edited = true
        }

        // phase 1.5: vi.doMock / vi.doUnmock and namespace vi.spyOn
        const dynIds = new Map<string, string>()
        const nsImports = new Map<string, any>()
        for (const stmt of body) {
          if (stmt.type !== 'ImportDeclaration') {
            continue
          }
          for (const s of stmt.specifiers ?? []) {
            if (s.type === 'ImportNamespaceSpecifier') {
              nsImports.set(s.local.name, stmt)
            }
          }
        }
        const lateCalls: [string, any][] = []
        walk(program, (node) => {
          const m = viCall(node)
          if ((m === 'doMock' || m === 'doUnmock') && node.arguments[0]?.type === 'Literal') {
            lateCalls.push([m, node])
          }
          else if (m === 'spyOn' && node.arguments[0]?.type === 'Identifier' && nsImports.has(node.arguments[0].name)) {
            lateCalls.push([m, node])
          }
        })
        for (const [m, node] of lateCalls) {
          if (inRemoved(node)) {
            continue
          }
          if (m === 'spyOn') {
            const stmt = nsImports.get(node.arguments[0].name)
            const resolved = await this.resolve(stmt.source.value, path, { skipSelf: true })
            const rid = resolved && splitQuery(resolved.id)[0]
            if (rid && isClonable(rid)) {
              ctxMutables.add(rid)
            }
            continue
          }
          const spec = node.arguments[0].value
          if (typeof spec !== 'string') {
            continue
          }
          const resolved = await this.resolve(spec, path, { skipSelf: true })
          if (!resolved) {
            this.warn(`vi.${m}(${JSON.stringify(spec)}) in ${path} did not resolve`)
            continue
          }
          const rid = splitQuery(resolved.id)[0]
          if (m === 'doUnmock') {
            magic.overwrite(node.start, node.end, `__vitestBundledDoUnmock(${JSON.stringify(ctx)}, ${JSON.stringify(rid)})`)
          }
          else {
            const isBare = !spec.startsWith('.') && !spec.startsWith('/')
            const actualSpec = `${isBare ? spec : rid}?${ACTUAL_QUERY}`
            const factoryNode = node.arguments[1]
            const isFactory
              = factoryNode
                && (factoryNode.type === 'ArrowFunctionExpression' || factoryNode.type === 'FunctionExpression')
            const factoryText = isFactory ? await rewriteFactoryText(factoryNode) : 'null'
            if (!mocks.has(rid)) {
              mocks.set(rid, 'dynamic')
            }
            dynIds.set(rid, spec)
            magic.overwrite(
              node.start,
              node.end,
              `__vitestBundledDoMock(${JSON.stringify(ctx)}, ${JSON.stringify(rid)}, ${factoryText}, `
              + `() => import(${JSON.stringify(actualSpec)}))`,
            )
          }
          removedRanges.push([node.start, node.end])
          edited = true
        }

        if (pending.length || dynIds.size || ctxMutables.size) {
          contexts.set(ctx, { file: path, mocks, mutables: ctxMutables })
          fileCtx.set(path, ctx)
        }
        if (pending.length || dynIds.size) {
          hasHoistModule = true

          const lines = [
            `import { vi } from "vitest";`,
            `import { __vitestBundledRegisterMock, __vitestBundledEagerMock, __vitestBundledRegisterHoisted, __vitestBundledAutomock, __vitestBundledRegisterDynamicActual } from ${JSON.stringify(runtimePath)};`,
          ]
          let autoIndex = 0
          for (const entry of pending) {
            if (entry.kind === 'hoisted') {
              lines.push(`const __vhv${entry.n} = await (${entry.fnText})();`)
              if (entry.patternText) {
                lines.push(`const ${entry.patternText} = __vhv${entry.n};`)
              }
              lines.push(`__vitestBundledRegisterHoisted(${JSON.stringify(ctx)}, ${entry.n}, __vhv${entry.n});`)
            }
            else if (entry.factoryText) {
              lines.push(
                `await __vitestBundledEagerMock(${JSON.stringify(ctx)}, ${JSON.stringify(entry.rid)}, `
                + `() => (${entry.factoryText})(() => import(${JSON.stringify(entry.actualSpec)})));`,
              )
            }
            else {
              const mockFile = findMocksFile(entry.rid, entry.spec)
              const varName = `__vauto${autoIndex++}`
              if (mockFile) {
                lines.push(`import * as ${varName} from ${JSON.stringify(mockFile)};`)
                lines.push(`__vitestBundledRegisterMock(${JSON.stringify(ctx)}, ${JSON.stringify(entry.rid)}, ${varName});`)
              }
              else {
                const importSpec = entry.spec.startsWith('.') || entry.spec.startsWith('/') ? entry.rid : entry.spec
                lines.push(`import * as ${varName} from ${JSON.stringify(importSpec)};`)
                lines.push(
                  `__vitestBundledRegisterMock(${JSON.stringify(ctx)}, ${JSON.stringify(entry.rid)}, __vitestBundledAutomock(${varName}));`,
                )
              }
            }
          }
          let dynIndex = 0
          for (const [rid, spec] of dynIds) {
            const importSpec = spec.startsWith('.') || spec.startsWith('/') ? rid : spec
            const varName = `__vdyn${dynIndex++}`
            lines.push(`import * as ${varName} from ${JSON.stringify(importSpec)};`)
            lines.push(`__vitestBundledRegisterDynamicActual(${JSON.stringify(ctx)}, ${JSON.stringify(rid)}, ${varName});`)
          }
          hoistModules.set(`${HOIST_PREFIX}${path}`, lines.join('\n'))
        }
      }
      else {
        ctx = cloneCtx!
        const info = contexts.get(ctx)
        if (!info) {
          return null
        }
        mocks = info.mocks
        ctxMutables = info.mutables ?? new Set()
        mutableTarget = ctxMutables.has(path)
      }

      let runtimeNeeded = edited
      const ns = (rid: string) => {
        runtimeNeeded = true
        return `__vitestBundledMockNs(${JSON.stringify(ctx)}, ${JSON.stringify(rid)})`
      }
      const nsAsync = (rid: string) => {
        runtimeNeeded = true
        return `__vitestBundledMockNsAsync(${JSON.stringify(ctx)}, ${JSON.stringify(rid)})`
      }

      // phase 2: rewrite static imports/re-exports of mocked ids
      for (const stmt of body) {
        if (inRemoved(stmt)) {
          continue
        }

        if (stmt.type === 'ImportDeclaration') {
          const resolved = await this.resolve(stmt.source.value, path, { skipSelf: true })
          const rid = resolved && splitQuery(resolved.id)[0]
          if (!rid) {
            continue
          }

          if (isTestEntry && ctxMutables.has(rid) && (stmt.specifiers ?? []).some((s: any) => s.type === 'ImportNamespaceSpecifier')) {
            const source = JSON.stringify(stmt.source.value)
            const parts = [`import ${source};`]
            const named: string[] = []
            for (const s of stmt.specifiers ?? []) {
              if (s.type === 'ImportNamespaceSpecifier') {
                runtimeNeeded = true
                parts.push(`const ${s.local.name} = __vitestBundledMutableNs(${JSON.stringify(ctx)}, ${JSON.stringify(rid)});`)
              }
              else if (s.type === 'ImportDefaultSpecifier') {
                named.push(`default as ${s.local.name}`)
              }
              else if (s.type === 'ImportSpecifier') {
                const name = s.imported?.name ?? s.imported?.value
                named.push(name === s.local.name ? s.local.name : `${name} as ${s.local.name}`)
              }
            }
            if (named.length) {
              parts.unshift(`import { ${named.join(', ')} } from ${source};`)
            }
            magic.overwrite(stmt.start, stmt.end, parts.join(' '))
            removedRanges.push([stmt.start, stmt.end])
            edited = true
            continue
          }

          const kind = mocks.get(rid)
          if (!kind) {
            continue
          }
          if (kind === 'dynamic' && isTestEntry) {
            continue
          }
          const parts: string[] = []
          const destructure: string[] = []
          for (const spec of stmt.specifiers ?? []) {
            if (spec.type === 'ImportDefaultSpecifier') {
              destructure.push(`default: ${spec.local.name}`)
            }
            else if (spec.type === 'ImportNamespaceSpecifier') {
              parts.push(`const ${spec.local.name} = ${ns(rid)};`)
            }
            else if (spec.type === 'ImportSpecifier') {
              const name = spec.imported?.name ?? spec.imported?.value
              destructure.push(name === spec.local.name ? spec.local.name : `${keyFor(name)}: ${spec.local.name}`)
            }
          }
          if (destructure.length) {
            parts.push(`const { ${destructure.join(', ')} } = ${ns(rid)};`)
          }
          if (!parts.length) {
            parts.push(`${ns(rid)};`)
          }
          magic.overwrite(stmt.start, stmt.end, parts.join(' '))
          removedRanges.push([stmt.start, stmt.end])
          edited = true
          continue
        }

        if (stmt.type === 'ExportNamedDeclaration' && stmt.source) {
          const resolved = await this.resolve(stmt.source.value, path, { skipSelf: true })
          const rid = resolved && splitQuery(resolved.id)[0]
          if (!rid || !mocks.has(rid)) {
            continue
          }
          const temps: string[] = []
          const exports: string[] = []
          ;(stmt.specifiers ?? []).forEach((spec: any, index: number) => {
            const local = spec.local?.name ?? spec.local?.value
            const exported = spec.exported?.name ?? spec.exported?.value
            temps.push(`${keyFor(local)}: __vx${index}`)
            exports.push(`__vx${index} as ${keyFor(exported)}`)
          })
          magic.overwrite(
            stmt.start,
            stmt.end,
            `const { ${temps.join(', ')} } = ${ns(rid)}; export { ${exports.join(', ')} };`,
          )
          removedRanges.push([stmt.start, stmt.end])
          edited = true
          continue
        }

        if (stmt.type === 'ExportAllDeclaration' && stmt.source) {
          const resolved = await this.resolve(stmt.source.value, path, { skipSelf: true })
          const rid = resolved && splitQuery(resolved.id)[0]
          if (rid && mocks.has(rid)) {
            this.warn(`\`export * from\` a mocked module (${stmt.source.value} in ${path}) is unsupported in bundled execution`)
          }
        }
      }

      // phase 2a (spied modules): mutable live exports
      if (mutableTarget) {
        const accessors: { exported: string, local: string, settable: boolean }[] = []
        for (const stmt of body) {
          if (stmt.type !== 'ExportNamedDeclaration' || inRemoved(stmt)) {
            continue
          }
          const decl = stmt.declaration
          if (!decl) {
            if (!stmt.source) {
              for (const s of stmt.specifiers ?? []) {
                const exported = s.exported?.name ?? s.exported?.value
                const local = s.local?.name
                if (exported && local && exported !== 'default') {
                  accessors.push({ exported, local, settable: false })
                }
              }
            }
            continue
          }
          if (decl.type === 'FunctionDeclaration' && decl.id) {
            magic.overwrite(stmt.start, decl.id.end, `export let ${decl.id.name} = function ${decl.id.name}`)
            magic.appendRight(stmt.end, ';')
            accessors.push({ exported: decl.id.name, local: decl.id.name, settable: true })
            edited = true
          }
          else if (decl.type === 'ClassDeclaration' && decl.id) {
            magic.overwrite(stmt.start, decl.id.end, `export let ${decl.id.name} = class ${decl.id.name}`)
            magic.appendRight(stmt.end, ';')
            accessors.push({ exported: decl.id.name, local: decl.id.name, settable: true })
            edited = true
          }
          else if (decl.type === 'VariableDeclaration') {
            if (decl.kind === 'const') {
              magic.overwrite(decl.start, decl.start + 5, 'let')
              edited = true
            }
            for (const d of decl.declarations) {
              if (d.id?.type === 'Identifier') {
                accessors.push({ exported: d.id.name, local: d.id.name, settable: true })
              }
            }
          }
        }
        if (accessors.length) {
          const props = accessors
            .map(a =>
              a.settable
                ? `get ${keyFor(a.exported)}() { return ${a.local}; }, set ${keyFor(a.exported)}(__v) { ${a.local} = __v; }`
                : `get ${keyFor(a.exported)}() { return ${a.local}; }`,
            )
            .join(', ')
          magic.append(
            `\n;__vitestBundledRegisterMutable(${JSON.stringify(ctx)}, ${JSON.stringify(path)}, { ${props} });\n`,
          )
          runtimeNeeded = true
          edited = true
        }
      }

      // phase 3: dynamic imports and vi.importActual / vi.importMock
      const dynamicNodes: any[] = []
      walk(program, (node) => {
        if (node.type === 'ImportExpression' && node.source?.type === 'Literal') {
          dynamicNodes.push(node)
        }
        const method = viCall(node)
        if ((method === 'importActual' || method === 'importMock') && node.arguments[0]?.type === 'Literal') {
          dynamicNodes.push(node)
        }
      })
      for (const node of dynamicNodes) {
        if (inRemoved(node)) {
          continue
        }
        const spec = node.type === 'ImportExpression' ? node.source.value : node.arguments[0].value
        if (typeof spec !== 'string') {
          continue
        }
        const resolved = await this.resolve(spec, path, { skipSelf: true })
        const rid = resolved && splitQuery(resolved.id)[0]
        if (!rid) {
          continue
        }
        const method = node.type === 'ImportExpression' ? null : viCall(node)
        const isBare = !spec.startsWith('.') && !spec.startsWith('/')
        const actualSpec = JSON.stringify(`${isBare ? spec : rid}?${ACTUAL_QUERY}`)
        let replacement: string | null = null
        if (method === 'importActual') {
          replacement = `import(${actualSpec})`
        }
        else if (method === 'importMock') {
          if (mocks.has(rid)) {
            replacement = nsAsync(rid)
          }
          else {
            replacement = `import(${actualSpec}).then((m) => __vitestBundledAutomock(m))`
            runtimeNeeded = true
          }
        }
        else if (mocks.has(rid)) {
          replacement = nsAsync(rid)
        }
        else {
          const owner = isTestEntry ? path : contexts.get(ctx)?.file
          if (owner && dynGroups.get(owner)?.has(rid)) {
            replacement
              = `__vitestBundledDynamicImport(${JSON.stringify(owner)}, ${JSON.stringify(rid)}, `
                + `() => ${code.slice(node.start, node.end)})`
            runtimeNeeded = true
          }
        }
        if (replacement) {
          magic.overwrite(node.start, node.end, replacement)
          removedRanges.push([node.start, node.end])
          edited = true
        }
      }

      if (!edited) {
        return null
      }
      if (runtimeNeeded) {
        magic.prepend(
          `import { __vitestBundledMockNs, __vitestBundledMockNsAsync, __vitestBundledHoisted, __vitestBundledAutomock, __vitestBundledProvideScopedFactory, __vitestBundledDynamicImport, __vitestBundledDoMock, __vitestBundledDoUnmock, __vitestBundledMutableNs, __vitestBundledRegisterMutable } from ${JSON.stringify(runtimePath)};\n`,
        )
        const hoistFile = isTestEntry ? path : contexts.get(ctx)?.file
        if (hoistFile && (hasHoistModule || !isTestEntry) && hoistModules.has(`${HOIST_PREFIX}${hoistFile}`)) {
          magic.prepend(`import ${JSON.stringify(`${HOIST_PREFIX}${hoistFile}`)};\n`)
        }
      }
      return { code: magic.toString(), map: magic.generateMap({ hires: true }) }
    },
  }

  return [resolvePlugin, transformPlugin]
}
