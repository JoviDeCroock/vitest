/**
 * Experimental bundled execution: one code-split Vite build for all test
 * entries of a project. Shared modules land in common chunks that are
 * evaluated exactly once per worker realm; workers import the prebuilt entry
 * chunks natively instead of fetching per-module transforms from the server.
 */
import type { Plugin } from 'vite'
import type { TestProject } from '../project'
import { mkdirSync } from 'node:fs'
import MagicString from 'magic-string'
import { dirname, join, relative, resolve } from 'pathe'
import { build, mergeConfig, parseAst } from 'vite'
import { distDir } from '../../paths'
import { createBundledMockPlugins } from './mockPlugin'

const JS_RE = /\.(?:[cm]?[jt]s|[jt]sx)$/

const runtimePath = join(distDir, 'bundled-mocks.js')
const vitestPackagesDir = dirname(dirname(distDir))

function entryName(root: string, file: string): string {
  const rel = relative(root, file)
    .split('/')
    .map(segment => (segment === '..' ? '__' : segment))
    .join('/')
  return `t/${rel.replace(/[^\w/.-]/g, '_')}`
}

function nodeGlobalsPlugin(root: string): Plugin {
  return {
    name: 'vitest:bundled-node-globals',
    enforce: 'post',
    transform(code, id) {
      const queryIndex = id.indexOf('?')
      const path = queryIndex === -1 ? id : id.slice(0, queryIndex)
      if (!path.startsWith(root) || path.includes('/node_modules/') || path.startsWith('\0')) {
        return null
      }
      if (!JS_RE.test(path)) {
        return null
      }
      const wantsDirname
        = /\b__(?:dirname|filename)\b/.test(code) && !/\b(?:const|let|var|function)\s+__(?:dirname|filename)\b/.test(code)
      const wantsMetaUrl = /\bimport\.meta\.url\b/.test(code)
      if (!wantsDirname && !wantsMetaUrl) {
        return null
      }
      const magic = new MagicString(code)
      if (wantsMetaUrl) {
        const sourceUrl = JSON.stringify(new URL(`file://${path}`).href)
        try {
          const program = parseAst(code)
          const visit = (node: any): void => {
            if (!node || typeof node.type !== 'string') {
              return
            }
            if (
              node.type === 'MemberExpression'
              && node.object?.type === 'MetaProperty'
              && node.property?.name === 'url'
            ) {
              magic.overwrite(node.start, node.end, sourceUrl)
            }
            for (const key of Object.keys(node)) {
              const value = node[key]
              if (Array.isArray(value)) {
                for (const child of value) {
                  visit(child)
                }
              }
              else if (value && typeof value.type === 'string') {
                visit(value)
              }
            }
          }
          visit(program)
        }
        catch {}
      }
      if (wantsDirname) {
        magic.prepend(
          `const __filename = ${JSON.stringify(path)}; const __dirname = ${JSON.stringify(dirname(path))};\n`,
        )
      }
      return { code: magic.toString(), map: magic.generateMap({ hires: true }) }
    },
  }
}

/**
 * Externalize with monorepo fidelity: resolve every bare import through the
 * full plugin pipeline from its actual importer, then externalize as a
 * resolved absolute path. The vitest runtime cluster is always external so
 * chunks share the worker's live singletons (runner, expect, spies).
 */
function externalizePlugin(): Plugin {
  return {
    name: 'vitest:bundled-externalize',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (source.startsWith(runtimePath) || source.startsWith(distDir)) {
        return { id: source, external: true }
      }
      if (!importer) {
        return null
      }
      if (source.startsWith('/') || source.startsWith('.') || source.startsWith('\0')) {
        return null
      }
      if (source.startsWith('node:') || source.includes('?')) {
        return null
      }
      if (!/^@?\w/.test(source) || source.startsWith('virtual:')) {
        return null
      }
      let importerPath = importer.split('?')[0]
      if (importerPath.startsWith('\0vitest-bundled-hoist:')) {
        importerPath = importerPath.slice('\0vitest-bundled-hoist:'.length)
      }
      const resolved = await this.resolve(source, importerPath, { ...options, skipSelf: true })
      if (!resolved || resolved.external || resolved.id.startsWith('\0')) {
        return resolved ?? null
      }
      const path = resolved.id.split('?')[0]
      if (!path.startsWith('/')) {
        return null
      }
      if (!path.includes('/node_modules/') && !path.startsWith(vitestPackagesDir)) {
        return null
      }
      return { id: path, external: true }
    },
  }
}

export interface BundledBuildResult {
  entries: Record<string, string>
  excluded: { file: string, message: string }[]
  durationMs: number
}

export async function buildBundledTests(
  project: TestProject,
  files: string[],
): Promise<BundledBuildResult> {
  const root = project.config.root
  const outDir = join(project.vite.config.cacheDir, 'vitest-bundled')
  mkdirSync(outDir, { recursive: true })

  const input: Record<string, string> = {}
  for (const file of [...files, ...project.config.setupFiles]) {
    input[entryName(root, file)] = file
  }

  const buildStart = performance.now()
  let entryMap: Record<string, string> = {}

  const manifestPlugin: Plugin = {
    name: 'vitest:bundled-manifest',
    writeBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk' || !chunk.isEntry || !chunk.facadeModuleId) {
          continue
        }
        entryMap[resolve(chunk.facadeModuleId)] = join(outDir, chunk.fileName)
      }
    },
  }

  const makeConfig = (buildInput: Record<string, string>) => ({
    root,
    configFile: project.vite.config.configFile ?? (false as const),
    logLevel: 'error' as const,
    mode: 'test',
    define: {
      'import.meta.env.DEV': '(globalThis.__vitest_bundled_env__.DEV)',
      'import.meta.env.PROD': '(globalThis.__vitest_bundled_env__.PROD)',
      'import.meta.env.MODE': '(globalThis.__vitest_bundled_env__.MODE)',
      'import.meta.env.SSR': '(globalThis.__vitest_bundled_env__.SSR)',
      'import.meta.env.BASE_URL': '(globalThis.__vitest_bundled_env__.BASE_URL)',
      'import.meta.env': 'globalThis.__vitest_bundled_env__',
    },
    build: {
      outDir,
      emptyOutDir: true,
      write: true,
      minify: false,
      sourcemap: true,
      target: 'es2022',
      modulePreload: false,
      reportCompressedSize: false,
      copyPublicDir: false,
      ssr: true,
      rollupOptions: {
        input: buildInput,
        preserveEntrySignatures: 'strict' as const,
        makeAbsoluteExternalsRelative: false,
        output: {
          format: 'es' as const,
          entryFileNames: '[name]-[hash].js',
          chunkFileNames: 'chunks/[name]-[hash].js',
          hoistTransitiveImports: false,
        },
      },
    },
    ssr: {
      external: true as const,
      noExternal: [] as string[],
    },
    plugins: [
      ...createBundledMockPlugins({
        root,
        runtimePath,
        testFiles: files,
      }),
      externalizePlugin(),
      nodeGlobalsPlugin(root),
      manifestPlugin,
    ],
  })

  const excluded: { file: string, message: string }[] = []
  for (let attempt = 0; ; attempt++) {
    try {
      entryMap = {}
      await build(mergeConfig({}, makeConfig(input)))
      break
    }
    catch (error: any) {
      const message = String(error?.message ?? error)
      const culprit = attempt < 8
        ? Object.entries(input).find(([, file]) => message.includes(file))
        : undefined
      if (!culprit) {
        throw error
      }
      delete input[culprit[0]]
      excluded.push({ file: culprit[1], message: message.split('\n').slice(0, 3).join('\n') })
    }
  }

  return { entries: entryMap, excluded, durationMs: performance.now() - buildStart }
}
