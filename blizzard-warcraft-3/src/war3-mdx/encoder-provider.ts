/**
 * `common.model/native-encoder` for Warcraft III models.
 *
 * UVM bytes in, one Warcraft III model out. The provider knows nothing about any other game: the
 * only thing it reads besides the common structures is this format's own `BlizzardMDX` residual.
 */
import { exportWar3FromUvm, type War3EncodeOptions } from './native-encoder.js'

const CONTRACT = 'common.model/native-encoder'
const FORMAT_ID = 'war3-mdx'
const OPTION_KEYS = ['encoding', 'metersPerTargetUnit']

interface EncodeRequest {
  readonly uvm: Uint8Array
  readonly options?: unknown
  readonly signal?: AbortSignal
}
interface ProviderContext {
  readonly budgets: {
    readonly maxInputBytes: bigint | number
    readonly maxScalarBytes: number
    readonly maxDepth: number
    readonly maxNodes: number
  }
}
interface Selection {
  readonly contract: string
  readonly major: number
  readonly offerId: string
  readonly contractSelectionKey: string
}

export const abiVersion = 1
export const provides = Object.freeze([CONTRACT])

export function createProvider(selection: Selection, context: ProviderContext) {
  if (
    selection.contract !== CONTRACT ||
    selection.major !== 1 ||
    selection.offerId !== 'war3-mdx-from-uvm' ||
    selection.contractSelectionKey !== `format=${FORMAT_ID}`
  )
    throw new TypeError(`unknown Warcraft III native encoder offer ${selection.offerId}`)
  return Object.freeze({
    value: Object.freeze({
      contract: CONTRACT,
      formatId: FORMAT_ID,
      extension: 'mdx',
      mediaType: 'model/x-warcraft3-mdx',
      async encode(request: EncodeRequest) {
        if (request === null || typeof request !== 'object' || Array.isArray(request))
          throw new TypeError('native model encode request must be an object')
        const options = request.options
        if (
          options !== undefined &&
          (options === null || typeof options !== 'object' || Array.isArray(options))
        )
          throw new TypeError('Warcraft III encoder options must be an object')
        if (
          options !== undefined &&
          Object.keys(options as Record<string, unknown>).some(key => !OPTION_KEYS.includes(key))
        )
          throw new TypeError('Warcraft III encoder received an unknown option')
        const resolved = (options ?? {}) as War3EncodeOptions
        const bytes = exportWar3FromUvm(
          request.uvm,
          {
            maxInputBytes: Number(context.budgets.maxInputBytes),
            maxJsonBytes: context.budgets.maxScalarBytes,
            maxDepth: context.budgets.maxDepth,
            maxNodes: context.budgets.maxNodes,
          },
          resolved,
          request.signal,
        )
        const encoding = resolved.encoding ?? 'mdx'
        return Object.freeze({
          formatId: FORMAT_ID,
          extension: encoding,
          mediaType: `model/x-warcraft3-${encoding}`,
          bytes,
        })
      },
    }),
    release: async () => undefined,
  })
}
