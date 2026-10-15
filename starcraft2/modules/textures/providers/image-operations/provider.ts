/**
 * The StarCraft II texture operations, as a service-operation provider.
 *
 * They run wherever the host runs providers — never inside a viewer. A viewer offers them because
 * each descriptor declares a `viewer.image` surface: the host lists them for that surface, the
 * view draws the declared fields, sends the decoded pixels, and puts the returned pixels back as
 * one undoable edit. No StarCraft II code reaches the page, which a webview's content-security
 * policy would refuse anyway.
 */
import { diagnostic } from '@modkit/core'
import {
  SERVICE_OPERATION_PROVIDER_CONTRACT,
  type ContributionContext,
  type SelectedServiceOffer,
  type ServiceOperationProvider,
  type ServiceOperationRequest,
  type ServiceOperationResult,
} from '@modkit/sdk'

import {
  SC2_BUTTON_ICON_OPERATION_ID,
  SC2_IMAGE_OPERATIONS,
  SC2_NORMAL_MAP_OPERATION_ID,
  SC2_TERRAIN_DIFFUSE_OPERATION_ID,
  packSc2TerrainDiffuse,
  terrainDiffuseOptionsOf,
  convertNormalMapToSc2,
  framePercentOf,
  imageFromInput,
  imageToResult,
  prepareSc2ButtonIcon,
} from '../../shared/operations.js'

const PROVIDER_ID = 'blizzard/starcraft2-image-operations'

export const abiVersion = 1
export const provides = Object.freeze([SERVICE_OPERATION_PROVIDER_CONTRACT])

function refused(operationId: string, code: string, message: string): ServiceOperationResult {
  return Object.freeze({
    state: 'refused' as const,
    operationId,
    code,
    message,
    diagnostics: Object.freeze([diagnostic('error', code, message)]),
  })
}

export function createProvider(selection: SelectedServiceOffer, _context: ContributionContext) {
  if (selection.contract !== SERVICE_OPERATION_PROVIDER_CONTRACT || selection.major !== 1) {
    throw new TypeError('unsupported StarCraft II image-operation selection')
  }

  const value: ServiceOperationProvider = Object.freeze({
    contract: SERVICE_OPERATION_PROVIDER_CONTRACT,
    providerId: PROVIDER_ID,
    operations: Object.freeze(SC2_IMAGE_OPERATIONS),
    async invoke(request: ServiceOperationRequest): Promise<ServiceOperationResult> {
      try {
        const image = imageFromInput(request.input)
        if (request.operationId === SC2_BUTTON_ICON_OPERATION_ID) {
          return Object.freeze({
            state: 'completed' as const,
            operationId: request.operationId,
            value: imageToResult(prepareSc2ButtonIcon(image, framePercentOf(request.input))),
            diagnostics: Object.freeze([]),
          })
        }
        if (request.operationId === SC2_NORMAL_MAP_OPERATION_ID) {
          return Object.freeze({
            state: 'completed' as const,
            operationId: request.operationId,
            value: imageToResult(convertNormalMapToSc2(image)),
            diagnostics: Object.freeze([]),
          })
        }
        if (request.operationId === SC2_TERRAIN_DIFFUSE_OPERATION_ID) {
          return Object.freeze({ state: 'completed' as const, operationId: request.operationId,
            value: imageToResult(packSc2TerrainDiffuse(image, terrainDiffuseOptionsOf(request.input))), diagnostics: Object.freeze([]) })
        }
        return refused(
          request.operationId,
          'blizzard/sc2-image-operation-unknown',
          'This provider does not publish that image operation.',
        )
      } catch (error) {
        // A refusal a person can act on: the icon is not square, the frame is out of range.
        return refused(
          request.operationId,
          'blizzard/sc2-image-operation-refused',
          error instanceof Error ? error.message : String(error),
        )
      }
    },
  })

  return Object.freeze({ value, release: async () => undefined })
}
