/**
 * `common.map/native-encoder` for Warcraft III: UVW bytes in, one `.w3x` out (`encoder.ts`), the
 * only way back from a world to a Warcraft III map. One offer, format `war3-map`.
 */
import type { NativeMapEncodeRequest, NativeMapEncoding } from '@modkit/sdk/maps'
import { WAR3_MAP_FORMAT_ID, encodeWar3Map } from './encoder.js'

const CONTRACT = 'common.map/native-encoder'
const OFFER = 'war3-map-from-uvw'

interface Selection {
  readonly contract: string
  readonly major: number
  readonly offerId: string
  readonly contractSelectionKey: string
}

export const abiVersion = 1
export const provides = Object.freeze([CONTRACT])

/** The encoder lease for the one offer this provider makes. */
export function createProvider(selection: Selection) {
  if (selection.contract !== CONTRACT || selection.major !== 1 || selection.offerId !== OFFER || selection.contractSelectionKey !== `format=${WAR3_MAP_FORMAT_ID}`)
    throw new TypeError(`unknown Warcraft III map encoder offer ${selection.offerId}`)
  return Object.freeze({
    value: Object.freeze({
      contract: CONTRACT,
      formatId: WAR3_MAP_FORMAT_ID,
      extension: 'w3x',
      /** Writes the world; the encoder needs no catalog of the target, so it never asks one. */
      async encode(request: NativeMapEncodeRequest): Promise<NativeMapEncoding> {
        if (request === null || typeof request !== 'object' || !(request.uvw instanceof Uint8Array)) throw new TypeError('native map encode request must carry the UVW bytes')
        const { bytes, diagnostics } = encodeWar3Map(request.uvw, request.options, request.signal)
        return Object.freeze({ formatId: WAR3_MAP_FORMAT_ID, extension: 'w3x', bytes, diagnostics })
      },
    }),
    release: async () => undefined,
  })
}
