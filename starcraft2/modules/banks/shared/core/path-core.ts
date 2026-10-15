import type { InferredBankSignatureInfo, SC2BankSignatureInfo } from './types.js'

const PLAYER_OR_AUTHOR_ID_RE = /^\d+-S2-\d+-\d+$/i
const BANK_FILE_RE = /\.SC2Bank$/i

export function inferBankSignatureInfo(bankPath: string): InferredBankSignatureInfo {
  const normalized = normalizePath(bankPath)
  const parts = normalized.split('/').filter(Boolean)
  const fileName = parts[parts.length - 1] ?? ''
  const bankName = fileName.replace(BANK_FILE_RE, '')
  const bankIndex = parts.findIndex(part => part.toLowerCase() === 'banks')

  let authorId: string | undefined
  let playerId: string | undefined

  if (bankIndex !== -1) {
    authorId = parts.slice(bankIndex + 1, -1).find(part => PLAYER_OR_AUTHOR_ID_RE.test(part))
    const beforeBanks = parts.slice(0, bankIndex).reverse()
    playerId = beforeBanks.find(part => PLAYER_OR_AUTHOR_ID_RE.test(part))
  } else {
    const ids = parts.filter(part => PLAYER_OR_AUTHOR_ID_RE.test(part))
    playerId = ids.length >= 2 ? ids[ids.length - 2] : undefined
    authorId = ids.length >= 1 ? ids[ids.length - 1] : undefined
  }

  const missing: Array<'authorId' | 'playerId'> = []
  if (authorId === undefined) missing.push('authorId')
  if (playerId === undefined) missing.push('playerId')

  return {
    bankName,
    ...(authorId !== undefined ? { authorId } : {}),
    ...(playerId !== undefined ? { playerId } : {}),
    bankPath: normalized,
    missing,
  }
}

export function toSignatureInfo(info: InferredBankSignatureInfo): SC2BankSignatureInfo | undefined {
  if (info.authorId === undefined || info.playerId === undefined) return undefined
  return { bankName: info.bankName, authorId: info.authorId, playerId: info.playerId }
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '')
}
