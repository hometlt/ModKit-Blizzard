export interface M3FileSystem {
  existsSync(path: string): boolean
  readFileSync(path: string): Uint8Array
  readFileSync(path: string, encoding: 'utf8'): string
}

export interface M3Path {
  dirname(path: string): string
  join(...paths: string[]): string
}

export interface M3PlatformAdapters {
  readonly fs?: M3FileSystem
  readonly path?: M3Path
  readonly dirname?: string
  readonly DOMParser?: typeof globalThis.DOMParser
}

let adapters: M3PlatformAdapters = {}
let initializer: (() => Promise<void>) | undefined
let initialization: Promise<void> | undefined

/** Install host adapters without importing Node modules into the portable M3 graph. */
export function installM3PlatformAdapters(next: M3PlatformAdapters): void {
  adapters = { ...adapters, ...next }
}

/** Install a lazy host initializer. The Node-only leaf uses this compatibility seam. */
export function installM3PlatformInitializer(next: () => Promise<void>): void {
  initializer = next
  initialization = undefined
}

/** Initialize the active host. Browser-main uses its native DOMParser. */
export async function initPlatform(): Promise<void> {
  if (initializer) {
    initialization ??= initializer()
    await initialization
  }
  if (!adapters.DOMParser && !globalThis.DOMParser) {
    throw new Error('No DOMParser is available for the M3 runtime.')
  }
}

export function getFs(): M3FileSystem {
  if (!adapters.fs) throw new Error('M3 filesystem access requires the Node platform entrypoint.')
  return adapters.fs
}

export function getPath(): M3Path {
  if (!adapters.path) throw new Error('M3 path access requires the Node platform entrypoint.')
  return adapters.path
}

export function getDirname(): string {
  if (!adapters.dirname) {
    throw new Error('M3 module path access requires the Node platform entrypoint.')
  }
  return adapters.dirname
}

export function getDOMParser(): typeof globalThis.DOMParser {
  const DOMParserImpl = adapters.DOMParser ?? globalThis.DOMParser
  if (!DOMParserImpl) throw new Error('No DOMParser is available for the M3 runtime.')
  return DOMParserImpl
}
