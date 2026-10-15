/**
 * The subject here is the archived facade. Its operation vocabulary remains available for
 * ported code, while registration/routing moved to the MK3 contribution host.
 *
 * The identity case used to live in the SC2 codec's `codec.test.ts`, next to the codec it
 * happened to register. That put a claim about this package inside a test suite for a game, and
 * left this package with no test of its own once the codec's tests moved out. The stand-in
 * below is enough: nothing asserted here is about any format, and `DataCodecRegistry` cannot
 * tell the difference.
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { GameArtifactCodec } from '@modkit/codec-kit/legacy/assets'
import {
  DataCodecRegistry as SemanticDataCodecRegistry,
  type DataCodecSummary as SemanticDataCodecSummary,
  type DataRouteOptions as SemanticDataRouteOptions,
} from '@modkit/codec-kit/legacy/semantic/data'
import * as semanticData from '@modkit/codec-kit/legacy/semantic/data'
import {
  DATA_OPERATION_IDS as RootDataOperationIds,
  DATA_OPERATION_ID_LIST as RootDataOperationIdList,
  DataCodecRegistry as RootDataCodecRegistry,
  type DataCodecSummary as RootDataCodecSummary,
  type DataOperationKey as RootDataOperationKey,
  type DataRouteOptions as RootDataRouteOptions,
} from '../../shared/catalog-engine/index.js'
import {
  DATA_ENTITY_CARDS_OPERATION_ID,
  DATA_OPERATION_IDS as FacadeDataOperationIds,
  DATA_OPERATION_ID_LIST as FacadeDataOperationIdList,
  DATA_REFERENCES_OPERATION_ID,
  DATA_RESOLVE_INHERITANCE_OPERATION_ID,
  type DataOperationKey as FacadeDataOperationKey,
} from '../../shared/catalog-engine/operations.js'
import {
  DataCodecRegistry as FacadeDataCodecRegistry,
  type DataCodecSummary as FacadeDataCodecSummary,
  type DataRouteOptions as FacadeDataRouteOptions,
} from '../../shared/catalog-engine/registry.js'

const STAND_IN_CODEC_ID = 'test.data-stand-in'

/** A minimal `GameArtifactCodec` — enough to be registered, listed, and summarized. */
function standInCodec(): GameArtifactCodec<unknown> {
  return {
    id: STAND_IN_CODEC_ID,
    kind: 'data',
    supportedGames: [],
    sourceKinds: ['file'],
    operations: [],
    detect: async () => ({
      pluginId: STAND_IN_CODEC_ID,
      confidence: 0,
      evidence: [],
      requiredRanges: [],
    }),
    open: async () => ({}),
    describe: async () => {
      throw new Error('stand-in codec: describe() is not part of this test')
    },
    createSession: () => {
      throw new Error('stand-in codec: createSession() is not part of this test')
    },
  }
}

describe('sc2 catalog-engine re-export of the codec-kit legacy semantic facade', () => {
  it('re-exports the canonical semantic registry constructor by identity', () => {
    expect(FacadeDataCodecRegistry).toBe(SemanticDataCodecRegistry)
    expect(RootDataCodecRegistry).toBe(SemanticDataCodecRegistry)
    expect(new RootDataCodecRegistry()).toBeInstanceOf(SemanticDataCodecRegistry)
  })

  it('keeps one operation vocabulary behind both the root and the module', () => {
    expect(RootDataOperationIds).toBe(FacadeDataOperationIds)
    expect(RootDataOperationIdList).toBe(FacadeDataOperationIdList)
    // The three verbs with no shared `AssetOperationId` are declared here, dot-namespaced.
    expect(FacadeDataOperationIds.resolveInheritance).toBe(DATA_RESOLVE_INHERITANCE_OPERATION_ID)
    expect(FacadeDataOperationIds.references).toBe(DATA_REFERENCES_OPERATION_ID)
    expect(FacadeDataOperationIds.entityCards).toBe(DATA_ENTITY_CARDS_OPERATION_ID)
  })

  it('preserves bidirectional registry and operation types', () => {
    expectTypeOf<FacadeDataCodecSummary>().toEqualTypeOf<SemanticDataCodecSummary>()
    expectTypeOf<SemanticDataCodecSummary>().toEqualTypeOf<FacadeDataCodecSummary>()
    expectTypeOf<RootDataCodecSummary>().toEqualTypeOf<SemanticDataCodecSummary>()

    expectTypeOf<FacadeDataRouteOptions>().toEqualTypeOf<SemanticDataRouteOptions>()
    expectTypeOf<SemanticDataRouteOptions>().toEqualTypeOf<FacadeDataRouteOptions>()
    expectTypeOf<RootDataRouteOptions>().toEqualTypeOf<SemanticDataRouteOptions>()

    expectTypeOf<RootDataOperationKey>().toEqualTypeOf<FacadeDataOperationKey>()
    expectTypeOf<FacadeDataOperationKey>().toEqualTypeOf<RootDataOperationKey>()
  })

  it('names no game: the operation vocabulary is the facade’s, the codecs are the host’s', () => {
    // The dot-namespaced IDs read `sc2-data.*` for historical reasons and are flagged in
    // operations.ts for promotion; what matters is that no SC2 *implementation* is reachable
    // from here any more, and that semantic never claimed the vocabulary either.
    expect('DATA_OPERATION_IDS' in semanticData).toBe(false)
    expect('createSc2DataCodec' in semanticData).toBe(false)
  })

  it('refuses the removed MK2 registration plane', () => {
    const codec = standInCodec()
    expect(() => new RootDataCodecRegistry().register(codec)).toThrowError(
      expect.objectContaining({ code: 'codec-kit/legacy-registry-unavailable' }),
    )
  })
})
