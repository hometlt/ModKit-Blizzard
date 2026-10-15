import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  LayoutCodecRegistry as SemanticLayoutCodecRegistry,
  type LayoutCodecSummary as SemanticLayoutCodecSummary,
  type LayoutRouteOptions as SemanticLayoutRouteOptions,
} from '@modkit/codec-kit/legacy/semantic/layouts'
import type { GameArtifactCodec } from '@modkit/codec-kit/legacy/assets'
import {
  LayoutCodecRegistry as RootLayoutCodecRegistry,
  type LayoutCodecSummary as RootLayoutCodecSummary,
  type LayoutRouteOptions as RootLayoutRouteOptions,
} from '../../../shared/layout-engine/index.js'
import {
  LayoutCodecRegistry as FacadeLayoutCodecRegistry,
  type LayoutCodecSummary as FacadeLayoutCodecSummary,
  type LayoutRouteOptions as FacadeLayoutRouteOptions,
} from '@modkit/codec-kit/legacy/semantic/layouts'

describe('sc2 layout-engine re-export of the codec-kit legacy semantic facade', () => {
  it('preserves the registry constructor across semantic, submodule, and root exports', () => {
    expect(FacadeLayoutCodecRegistry).toBe(SemanticLayoutCodecRegistry)
    expect(RootLayoutCodecRegistry).toBe(SemanticLayoutCodecRegistry)
  })

  it('preserves bidirectional registry facade type compatibility', () => {
    expectTypeOf<FacadeLayoutCodecSummary>().toEqualTypeOf<SemanticLayoutCodecSummary>()
    expectTypeOf<SemanticLayoutCodecSummary>().toEqualTypeOf<FacadeLayoutCodecSummary>()
    expectTypeOf<RootLayoutCodecSummary>().toEqualTypeOf<SemanticLayoutCodecSummary>()
    expectTypeOf<SemanticLayoutCodecSummary>().toEqualTypeOf<RootLayoutCodecSummary>()

    expectTypeOf<FacadeLayoutRouteOptions>().toEqualTypeOf<SemanticLayoutRouteOptions>()
    expectTypeOf<SemanticLayoutRouteOptions>().toEqualTypeOf<FacadeLayoutRouteOptions>()
    expectTypeOf<RootLayoutRouteOptions>().toEqualTypeOf<SemanticLayoutRouteOptions>()
    expectTypeOf<SemanticLayoutRouteOptions>().toEqualTypeOf<RootLayoutRouteOptions>()
  })

  /**
   * A stand-in, not `sc2-layout`. The subject here is registry behaviour — register, list,
   * summarise — and a game codec was only ever the nearest object that satisfied the interface.
   * This package holds no codec now, and reaching for one would put the extension back in its
   * dependencies to assert something about a `Map`.
   */
  it('refuses the removed MK2 registration plane', () => {
    const codec = {
      id: 'stand-in-layout',
      kind: 'layout',
      supportedGames: ['test-game'],
      sourceKinds: ['file'],
      operations: [],
      async detect() {
        return { pluginId: 'stand-in-layout', confidence: 1, evidence: [], requiredRanges: [] }
      },
      async open() {
        return {}
      },
      describe() {
        return undefined as never
      },
    } as unknown as GameArtifactCodec<unknown>

    expect(() => new RootLayoutCodecRegistry().register(codec)).toThrowError(
      expect.objectContaining({ code: 'codec-kit/legacy-registry-unavailable' }),
    )
  })
})
