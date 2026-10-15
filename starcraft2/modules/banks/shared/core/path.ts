import { readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { inferBankSignatureInfo, toSignatureInfo } from './path-core.js'
import type { DiscoveredBankFile, DiscoverBanksOptions } from './types.js'

const BANK_FILE_RE = /\.SC2Bank$/i

export { inferBankSignatureInfo, toSignatureInfo } from './path-core.js'

export async function discoverBankFiles(rootPath: string, options: DiscoverBanksOptions = {}): Promise<DiscoveredBankFile[]> {
  const maxDepth = options.maxDepth ?? 16
  const out: DiscoveredBankFile[] = []
  await walk(normalizePath(rootPath), 0, maxDepth, out)
  return out.sort((a, b) => comparePath(a.path, b.path))
}

async function walk(dir: string, depth: number, maxDepth: number, out: DiscoveredBankFile[]): Promise<void> {
  if (depth > maxDepth) return
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const fullPath = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      await walk(fullPath, depth + 1, maxDepth, out)
    } else if (entry.isFile() && BANK_FILE_RE.test(entry.name)) {
      out.push({ path: fullPath, info: inferBankSignatureInfo(fullPath) })
    }
  }
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '')
}

function comparePath(a: string, b: string): number {
  return a.localeCompare(b, 'en', { sensitivity: 'base' })
}
