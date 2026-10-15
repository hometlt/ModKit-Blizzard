import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { build, type Metafile } from 'esbuild'
import type { Browser, Page } from '../../../../modkit-core/node_modules/playwright-core/index.js'

export interface PortableBrowserWorker {
  readonly metafile: Metafile
  readonly bundle: string
  readonly styles: string
  call(input: unknown): Promise<unknown>
  close(): Promise<void>
}

/** Reusable browser-platform bundle + actual Dedicated Worker, following the common real-scene
 * tests. This does not simulate browser globals in Node and does not claim host activation. */
export async function portableBrowserWorker(options: {
  readonly entrypoint: string
  readonly coreRoot: string
  /** Page composition can activate its own production workers and real browser storage. */
  readonly realm?: 'worker' | 'page'
  readonly assets?: ReadonlyMap<string, string | Uint8Array>
  readonly onConsole?: (message: string) => void
}): Promise<PortableBrowserWorker> {
  const result = await build({
    stdin: {
      contents:
        options.realm === 'page'
          ? `import { run } from ${JSON.stringify(options.entrypoint.replaceAll('\\', '/'))};
           Object.defineProperty(globalThis, '__portablePageRun', {value: run, configurable: true});`
          : `import { run } from ${JSON.stringify(options.entrypoint.replaceAll('\\', '/'))};
        globalThis.addEventListener('message', async ({data}) => {
          try { globalThis.postMessage({id:data.id,ok:true,output:await run(data.input)}); }
          catch(error) { globalThis.postMessage({id:data.id,ok:false,error:{name:error?.name,message:error?.message,stack:error?.stack}}); }
        });
        globalThis.postMessage({id:0,ok:true,ready:true});`,
      loader: 'js',
      resolveDir: resolve(options.entrypoint, '..'),
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    outfile: 'portable.js',
    loader: { '.ttf': 'dataurl' },
    metafile: true,
    write: false,
  })
  const output = result.outputFiles.find(file => file.path.endsWith('.js'))
  const styles = result.outputFiles
    .filter(file => file.path.endsWith('.css'))
    .map(file => file.text)
    .join('\n')
  if (output === undefined) throw new Error('portable browser bundle is absent')
  const inlineAsset = (dependency: { readonly kind: string; readonly path: string }) =>
    dependency.kind === 'url-token' && dependency.path.startsWith('data:')
  for (const [path, input] of Object.entries(result.metafile.inputs)) {
    if (path.startsWith('node:')) throw new Error(`browser bundle contains Node input ${path}`)
    for (const dependency of input.imports) {
      if (
        (dependency.external === true && !inlineAsset(dependency)) ||
        dependency.path.startsWith('node:')
      )
        throw new Error(`browser bundle retains an external dependency: ${dependency.path}`)
    }
  }
  for (const file of Object.values(result.metafile.outputs))
    if (file.imports.some(dependency => !inlineAsset(dependency)))
      throw new Error('browser bundle retains external imports')

  const executablePath = [
    process.env['CHROME_PATH'],
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((path): path is string => path !== undefined && existsSync(path))
  if (executablePath === undefined)
    throw new Error('Chrome/Chromium is required for portable worker tests')
  const requireFromCore = createRequire(join(options.coreRoot, 'package.json'))
  const { chromium } = requireFromCore(
    'playwright-core',
  ) as typeof import('../../../../modkit-core/node_modules/playwright-core/index.js')
  const browser: Browser = await chromium.launch({ executablePath, headless: true })
  let page: Page
  try {
    page = await browser.newPage()
    if (options.onConsole !== undefined)
      page.on('console', message => options.onConsole?.(message.text()))
    // A localhost origin supplies real secure-context WebCrypto; no HTTP server or network assets.
    await page.route('**/*', async route => {
      const asset = options.assets?.get(route.request().url())
      if (asset !== undefined)
        await route.fulfill({
          contentType: 'text/javascript',
          body: typeof asset === 'string' ? asset : Buffer.from(asset),
        })
      else if (route.request().url() === 'http://127.0.0.1/portable-proof')
        await route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><title>Portable codec worker</title>',
        })
      else await route.abort('blockedbyclient')
    })
    await page.goto('http://127.0.0.1/portable-proof')
    if (options.realm === 'page') {
      if (styles.length > 0) await page.addStyleTag({ content: styles })
      await page.addScriptTag({ content: output.text })
    } else
      await page.evaluate(async bundle => {
        const url = URL.createObjectURL(new Blob([bundle], { type: 'text/javascript' }))
        const worker = new Worker(url, { type: 'module', name: 'modkit-portable-conformance' })
        const pending = new Map<
          number,
          { resolve(value: unknown): void; reject(error: Error): void }
        >()
        let nextId = 0
        const ready = new Promise<void>((resolveReady, reject) => {
          pending.set(0, { resolve: () => resolveReady(), reject })
        })
        worker.onmessage = ({
          data,
        }: MessageEvent<{
          id: number
          ok: boolean
          output?: unknown
          error?: { name?: string; message?: string; stack?: string }
        }>) => {
          const request = pending.get(data.id)
          if (request === undefined) return
          pending.delete(data.id)
          if (data.ok) request.resolve(data.output)
          else {
            const error = new Error(data.error?.message ?? 'portable worker failed')
            error.name = data.error?.name ?? 'Error'
            if (data.error?.stack !== undefined) error.stack = data.error.stack
            request.reject(error)
          }
        }
        worker.onerror = event => {
          for (const request of pending.values()) request.reject(new Error(event.message))
          pending.clear()
        }
        const api = {
          async call(input: unknown): Promise<unknown> {
            const id = ++nextId
            return new Promise((resolveReply, reject) => {
              pending.set(id, { resolve: resolveReply, reject })
              worker.postMessage({ id, input })
            })
          },
          close() {
            worker.terminate()
            URL.revokeObjectURL(url)
            for (const request of pending.values())
              request.reject(new Error('portable worker closed'))
            pending.clear()
          },
        }
        Object.defineProperty(globalThis, '__portableWorker', { value: api, configurable: true })
        await ready
      }, output.text)
  } catch (error) {
    await browser.close()
    throw error
  }
  return {
    metafile: result.metafile,
    bundle: output.text,
    styles,
    call: input =>
      options.realm === 'page'
        ? page.evaluate(async value => {
            const run = Reflect.get(globalThis, '__portablePageRun') as (
              input: unknown,
            ) => Promise<unknown>
            return run(value)
          }, input)
        : page.evaluate(async value => {
            const api = Reflect.get(globalThis, '__portableWorker') as {
              call(input: unknown): Promise<unknown>
            }
            return api.call(value)
          }, input),
    async close() {
      try {
        if (options.realm !== 'page')
          await page.evaluate(() => {
            const api = Reflect.get(globalThis, '__portableWorker') as { close(): void }
            api.close()
            Reflect.deleteProperty(globalThis, '__portableWorker')
          })
      } finally {
        await browser.close()
      }
    },
  }
}
