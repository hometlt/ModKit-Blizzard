/** Native M3/M3A export through common.model/native-encoder. Geometry/rig/material encoding
 * belongs to the M3 codec; this provider validates options and reports conversion losses.
 * Strict materials by default; explicit base-color-coverage permits a bounded approximation.
 * No image conversion, asset-library writes or source-game branches. Node/browser share this
 * implementation; manifests: models/providers/{m3,m3a}-native-encoder/provider.json. */
import { encodeM3UvmBytes } from '../../dist/m3/uvm/write-operation.js'

const CONTRACT = 'common.model/native-encoder'
const FORMAT_BY_OFFER = Object.freeze({
  'm3-from-uvm': 'm3',
  'm3a-from-uvm': 'm3a',
})

export const abiVersion = 1
export const provides = Object.freeze([CONTRACT])

export function createProvider(selection, context) {
  const formatId = FORMAT_BY_OFFER[selection.offerId]
  if (selection.contract !== CONTRACT || selection.major !== 1 || formatId === undefined)
    throw new TypeError(`unknown Blizzard native model encoder offer ${selection.offerId}`)
  if (selection.contractSelectionKey !== `format=${formatId}`)
    throw new TypeError(`Blizzard native model encoder selection does not match ${formatId}`)
  const extension = formatId
  return Object.freeze({
    value: Object.freeze({
      contract: CONTRACT,
      formatId,
      extension,
      mediaType: `model/x-${formatId}`,
      async encode(request) {
        if (request === null || typeof request !== 'object' || Array.isArray(request))
          throw new TypeError('native model encode request must be an object')
        const options = request.options ?? {}
        if (options === null || typeof options !== 'object' || Array.isArray(options))
          throw new TypeError('M3 encoder options must be an object')
        if (Object.keys(options).some(key => !['metersPerNativeUnit', 'materialPolicy'].includes(key)))
          throw new TypeError('M3 encoder received an unknown option')
        const materialPolicy = options.materialPolicy ?? 'strict'
        if (!['strict', 'base-color-coverage'].includes(materialPolicy))
          throw new TypeError('M3 encoder received an unknown materialPolicy')
        const notes = []
        const bytes = await encodeM3UvmBytes(
          request.uvm,
          context.budgets,
          request.signal,
          formatId,
          options.metersPerNativeUnit,
          materialPolicy,
          notes,
        )
        return Object.freeze({ formatId, extension, mediaType: `model/x-${formatId}`, bytes,
          diagnostics: Object.freeze(notes.map(message => Object.freeze({
            severity: 'warning', code: 'blizzard/m3-conversion-loss', message,
          }))),
        })
      },
    }),
    release: async () => undefined,
  })
}
