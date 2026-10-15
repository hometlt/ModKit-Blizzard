/**
 * The community files World of Warcraft needs beside its storage, downloaded into the host's index
 * cache directory (owner decision 09.10): the root names no paths, so file names come from the
 * wowdev listfile (`id;path`, ~2 million names), and encrypted files need the wowdev TACT keys.
 *
 * Each file is fetched once into `<cache>/world-of-warcraft/` and fetched again after
 * {@link REFRESH_DAYS} days (the listfile grows with every patch); a failed refresh keeps the old
 * copy, a failed first fetch leaves the game unnamed (`filedataid/<id>`) — never an error. Writes go
 * through a temporary file, so a reader never sees half a file. Node only.
 */
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const LISTFILE_URL = 'https://github.com/wowdev/wow-listfile/releases/latest/download/community-listfile.csv'
export const TACT_KEYS_URL = 'https://raw.githubusercontent.com/wowdev/TACTKeys/master/WoW.txt'
const REFRESH_DAYS = 7
const MAXIMUM_DOWNLOAD_BYTES = 512 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000

/** A downloaded file: `id` changes whenever its bytes may have. */
export interface CommunityFile {
  readonly id: string
  load(): Promise<Uint8Array>
}

/** Fetch `url` into `path` through a temporary file; refuses more than {@link MAXIMUM_DOWNLOAD_BYTES}. */
async function download(url: string, path: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!response.ok || response.body === null) throw new Error(`${url} answered ${String(response.status)}`)
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > MAXIMUM_DOWNLOAD_BYTES) throw new Error(`${url} is larger than ${String(MAXIMUM_DOWNLOAD_BYTES)} bytes`)
  const temporary = `${path}.${String(process.pid)}.tmp`
  let received = 0
  const counted = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>).on('data', (chunk: Uint8Array) => {
    received += chunk.length
    if (received > MAXIMUM_DOWNLOAD_BYTES) counted.destroy(new Error(`${url} is larger than ${String(MAXIMUM_DOWNLOAD_BYTES)} bytes`))
  })
  try {
    await pipeline(counted, createWriteStream(temporary))
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/**
 * The cached copy of `url` named `name`, fetched when missing or older than {@link REFRESH_DAYS};
 * nothing when there is no copy and the fetch fails.
 */
export async function communityFile(
  cacheDirectory: string,
  name: string,
  url: string,
  log: (message: string) => void = () => undefined,
): Promise<CommunityFile | undefined> {
  const folder = join(cacheDirectory, 'world-of-warcraft')
  const path = join(folder, name)
  const current = await stat(path).catch(() => undefined)
  if (current === undefined || Date.now() - current.mtimeMs > REFRESH_DAYS * 86_400_000) {
    try {
      await mkdir(folder, { recursive: true })
      await download(url, path)
    } catch (error) {
      log(`World of Warcraft: ${name} was not downloaded (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  const file = await stat(path).catch(() => undefined)
  if (file === undefined) return undefined
  return Object.freeze({
    id: `${String(file.size)}-${String(Math.trunc(file.mtimeMs))}`,
    load: async () => new Uint8Array(await readFile(path)),
  })
}

/**
 * TACT keys of `WoW.txt` (`KEYNAME KEY [comment]`: 16 and 32 hex digits) by key name, lower-case.
 * Malformed lines are skipped.
 */
export function parseTactKeys(text: string): ReadonlyMap<string, Uint8Array> {
  const keys = new Map<string, Uint8Array>()
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*([0-9a-f]{16})\s+([0-9a-f]{32})\b/iu.exec(line)
    if (match === null) continue
    const key = new Uint8Array(16)
    for (let i = 0; i < 16; i++) key[i] = Number.parseInt(match[2]!.slice(i * 2, i * 2 + 2), 16)
    keys.set(match[1]!.toLowerCase(), key)
  }
  return keys
}
