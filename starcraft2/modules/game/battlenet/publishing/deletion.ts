import { randomUUID } from 'node:crypto'
import { BattleNetVfsError } from '../shared/errors.js'
import { checkedPublication, type BattleNetPublication, type BattleNetRegion, type BattleNetRegionInput } from '../content-sources/vfs-provider.js'

export interface BattleNetDeleteOptions {
  readonly region: BattleNetRegionInput
  readonly publication: BattleNetPublication
  readonly operationId?: string
  readonly signal?: AbortSignal
}
export interface BattleNetDeleteRequest {
  readonly region: BattleNetRegion
  readonly publication: BattleNetPublication
  readonly operationId: string
  readonly signal: AbortSignal
}
/** Unlink removes the account publication; it does not promise depot/cache erasure. */
export interface BattleNetDeleteReceipt {
  readonly status: 'unlinked'
  readonly region: BattleNetRegion
  readonly operationId: string
  readonly id: number
  readonly version: number
  readonly serverUnlinkVerified: true
}
/** Backend must freshly check own linked revision + header before Unlink and verify unlinking after it. */
export type BattleNetDeleteBackend = (request: BattleNetDeleteRequest) => Promise<BattleNetDeleteReceipt | {
  readonly status: 'rejected'; readonly operationId: string; readonly region: BattleNetRegion; readonly reason: string
}>
export class BattleNetDeleteOutcomeUnknownError extends BattleNetVfsError {
  constructor(readonly operationId: string) {
    super('blizzard.battlenet/delete-outcome-unknown', `Deletion may have reached Blizzard. Reconcile operation ${operationId} before retrying.`)
  }
}
export async function deleteBattleNetPublication(options: BattleNetDeleteOptions, region: BattleNetRegion,
  signal: AbortSignal, backend: BattleNetDeleteBackend): Promise<BattleNetDeleteReceipt> {
  signal.throwIfAborted()
  const publication = Object.freeze(checkedPublication(options.publication))
  const operationId = options.operationId ?? randomUUID()
  if (typeof operationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(operationId)) throw new Error('Invalid deletion operation ID')
  let reply: Awaited<ReturnType<BattleNetDeleteBackend>>
  try { reply = await backend(Object.freeze({ region, publication, operationId, signal })) }
  catch { throw new BattleNetDeleteOutcomeUnknownError(operationId) }
  if (!reply || reply.operationId !== operationId || reply.region !== region) throw new BattleNetDeleteOutcomeUnknownError(operationId)
  if (reply.status === 'rejected' && typeof reply.reason === 'string' && reply.reason.length > 0 && reply.reason.length <= 4096) {
    throw new BattleNetVfsError('blizzard.battlenet/delete-rejected', `Deletion rejected: ${reply.reason}`)
  }
  if (reply.status !== 'unlinked' || reply.id !== publication.id || reply.version !== publication.version || reply.serverUnlinkVerified !== true) {
    throw new BattleNetDeleteOutcomeUnknownError(operationId)
  }
  return Object.freeze({ status: 'unlinked', region, operationId, id: reply.id, version: reply.version, serverUnlinkVerified: true })
}
