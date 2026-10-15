/**
 * `blizzard/diablo3-sno-registry@1`: the SNO type registry of an installed Diablo III.
 *
 * The registry comes from the installation's own executable (`registry.ts`), so it always matches
 * the data it decodes and nothing of the game is shipped. The executable is read through the host's
 * `installationFiles` (the installation the user selected, or discovery confirmed); no filesystem
 * permission is asked. Deriving it takes seconds; the result is kept for the process and, when the
 * host names a cache directory, on disk under the executable's SHA-256.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sha256Hex } from '@modkit/codec-kit/crypto/digest'
import type { InstallationFiles } from '@modkit/sdk'
import { parsePeImage } from 'modkit-extension-archives/formats/pe/codec'
import type { ExecutableImage } from './x64.js'
import { SNO_REGISTRY_CONTRACT, type SnoRegistryRequest, type SnoRegistryService } from './contract.js'
import { extractSnoTypeRegistry, type SnoTypeRegistry } from './registry.js'

const GAME_ID = 'blizzard/diablo-3'
/** Where an installation keeps the 64-bit client. */
const EXECUTABLE = 'x64/Diablo III64.exe'
const CACHE_VERSION = 2
const IMAGE_SCN_MEM_EXECUTE = 0x2000_0000
/** One read of the host's installation files is at most 64 MiB. */
const READ_BYTES = 64 * 1024 * 1024

interface ProviderContext {
  readonly installationFiles?: InstallationFiles
  readonly settings?: Readonly<Record<string, unknown>>
}

/** Registries derived in this process, by executable digest. */
const derived = new Map<string, Promise<SnoTypeRegistry>>()

/** The client's sections by virtual address, as the core PE codec reads them, for `X64Machine`. */
function executableImage(bytes: Uint8Array): ExecutableImage {
  const image = parsePeImage(bytes)
  if (!image.pe32Plus) throw new TypeError(`${EXECUTABLE} is not a 64-bit image`)
  return {
    imageBase: image.imageBase,
    sections: image.sections.map(section => ({
      virtualAddress: section.virtualAddress,
      virtualSize: section.virtualSize,
      bytes: bytes.subarray(section.rawOffset, section.rawOffset + section.rawSize),
      executable: (section.characteristics & IMAGE_SCN_MEM_EXECUTE) !== 0,
    })),
  }
}

/** The installation's 64-bit client, read a host-bounded range at a time. */
async function executable(files: InstallationFiles | undefined, signal: AbortSignal | undefined): Promise<Uint8Array> {
  const request = { gameId: GAME_ID, path: EXECUTABLE, ...(signal === undefined ? {} : { signal }) }
  const size = files === undefined ? undefined : await files.size(request)
  if (files === undefined || size === undefined)
    throw new TypeError(`the SNO type registry is read from the installation's ${EXECUTABLE}, which this host does not offer: select the Diablo III installation (a browser host has none)`)
  const bytes = new Uint8Array(size)
  for (let offset = 0; offset < size; ) {
    const part = await files.read({ ...request, offset, length: Math.min(READ_BYTES, size - offset) })
    if (part.byteLength === 0) throw new RangeError(`${EXECUTABLE} ended at ${offset} of ${size} bytes`)
    bytes.set(part, offset)
    offset += part.byteLength
  }
  return bytes
}

async function registryOf(request: SnoRegistryRequest, context: ProviderContext | undefined): Promise<SnoTypeRegistry> {
  const bytes = await executable(context?.installationFiles, request.signal)
  const digest = await sha256Hex(bytes)
  const cached = derived.get(digest)
  if (cached !== undefined) return cached
  const cacheDirectory = context?.settings?.['cacheDirectory']
  const cacheFile = typeof cacheDirectory === 'string' && cacheDirectory !== '' ? join(cacheDirectory, `diablo3-sno-registry-${digest}.v${CACHE_VERSION}.json`) : undefined
  const pending = (async () => {
    if (cacheFile !== undefined) {
      try {
        return JSON.parse(await readFile(cacheFile, 'utf8')) as SnoTypeRegistry
      } catch {
        // not cached yet, or unreadable: derive it again
      }
    }
    const registry = extractSnoTypeRegistry(executableImage(bytes))
    if (cacheFile !== undefined) {
      try {
        await mkdir(join(cacheFile, '..'), { recursive: true })
        await writeFile(cacheFile, JSON.stringify(registry))
      } catch {
        // a cache that cannot be written only costs the next process the derivation
      }
    }
    return registry
  })()
  derived.set(digest, pending)
  pending.catch(() => derived.delete(digest))
  return pending
}

export function createProvider(selection: { readonly contract: string; readonly major: number }, context?: ProviderContext) {
  if (selection.contract !== SNO_REGISTRY_CONTRACT || selection.major !== 1)
    throw new TypeError(`unsupported selection ${selection.contract}@${String(selection.major)}`)
  const service: SnoRegistryService = Object.freeze({
    contract: SNO_REGISTRY_CONTRACT,
    registry: (request: SnoRegistryRequest) => registryOf(request, context),
  })
  return Object.freeze({ value: service, release: async (): Promise<void> => undefined })
}

export const abiVersion = 1
export const provides = Object.freeze([SNO_REGISTRY_CONTRACT])
