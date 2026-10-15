import { describe, expect, it } from 'vitest'
import {
  bakeWar3Popcorn,
  war3PopcornBakePath,
  war3PopcornFrame,
  war3PopcornGuideOn,
  war3PopcornTexture,
  war3PopcornTrackAt,
  type War3PopcornEmitter,
} from '../src/war3-mdx/popcorn.js'
import { war3SpriteMaterial } from '../src/war3-mdx/scene.js'
import { effect, layer, load, operand, spawn } from './pk-effect-fixture.js'

/**
 * A CORN emitter baked: its effect (one particle: life 0.5 s, size 0.5 m, rising 10 m/s) runs over
 * each clip its guide turns it on for, in its node's frame, and every frame's sprites are recorded
 * in Warcraft III units (50 a metre).
 */
const emitter: War3PopcornEmitter = { name: 'Flame', path: 'FX\\Flame.pkfx', guide: 'Always=on, Death=off', nodeId: 'war3-node-0', pivot: [100, 0, 0] }
const clips = [
  { clipId: 'stand', name: 'Stand 1', startMs: 0, endMs: 1000, looping: false },
  { clipId: 'death', name: 'Death', startMs: 1000, endMs: 2000, looping: false },
]

describe('PopcornFX bakes of a Warcraft III model', () => {
  it('reads its guide by clip name and finds its bake and textures in the game tree', () => {
    expect(war3PopcornGuideOn('Always=on, Death=off, Decay=off', 'Death 1')).toBe(false)
    expect(war3PopcornGuideOn('Always=on, Death=off, Decay=off', 'Stand Ready')).toBe(true)
    expect(war3PopcornGuideOn('Stand=On, Death=Off', 'Birth')).toBe(true)
    expect(war3PopcornGuideOn('Alwyas=on, Death=off', 'Birth')).toBe(true)
    expect(war3PopcornGuideOn('Always=off, Death=on', 'Stand')).toBe(false)
    expect(war3PopcornGuideOn('Stand=On, Death=Off', 'Stand 2')).toBe(true)
    expect(war3PopcornGuideOn('Death=off', 'Spell 1')).toBe(true)
    expect(war3PopcornBakePath('Abilities\\Spells\\X.pkfx')).toBe('Abilities/Spells/X.pkb')
    expect(war3PopcornTexture('_HD.w3mod/Textures/FX/Flare.tif')).toBe('Textures/FX/Flare.tif')
    // a node frame in units, turned a quarter about Z and 100 units out: the same turn, 2 m out
    expect(war3PopcornFrame([0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 100, 0, 50, 1])).toEqual([0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 2, 0, 1, 1])
  })

  it('bakes the clips it runs in, frame by frame, in Warcraft III units', () => {
    const bake = bakeWar3Popcorn([emitter], [effect], clips)
    expect(bake.frameRate).toBe(15)
    expect(bake.batches).toEqual([
      expect.objectContaining({ orientation: 'camera', atlas: [1, 1], texture: 'Flare.tif', blendMode: 3 }),
    ])
    expect(bake.tracks.map(track => track.clipId)).toEqual(['stand'])
    const [track] = bake.tracks
    expect(track!.loop).toBe(false)
    expect(track!.frames.length).toBe(16)
    expect(track!.frames[0]).toBe(0)
    expect(track!.frames.at(-1)).toBe(track!.sprites.length / 17)
    // a sprite: where the effect put it (this one places nothing through its frame), half size 0.5 m
    // = 25 units, its colour
    expect(track!.sprites[0]).toBeCloseTo(0, 3)
    expect([...track!.sprites.slice(3, 5)]).toEqual([25, 25])
    expect([...track!.sprites.slice(6, 10)]).toEqual([1, 0.5, 0, 1])
    // the same model bakes the same
    expect(bakeWar3Popcorn([emitter], [effect], clips).tracks[0]!.sprites).toEqual(track!.sprites)
  })
})

describe('team-coloured PopcornFX bakes', () => {
  it('mark the layers that read the player colour and multiply their material by it', () => {
    // the same effect, its spawn script also loading __a_Game.TeamColor
    const teamSpawn = {
      ...spawn,
      externals: [...spawn.externals, { name: '__a_Game.TeamColor', type: 'float4' }],
      code: [...spawn.code, load(operand(0, 1, 0x23), spawn.externals.length)],
    }
    const teamEffect = { ...effect, layers: [{ ...layer, spawn: teamSpawn }] }
    expect(bakeWar3Popcorn([emitter], [effect], clips).batches[0]!.teamColored).toBe(false)
    expect(bakeWar3Popcorn([emitter], [teamEffect], clips).batches[0]!.teamColored).toBe(true)
    const material = (team: boolean) =>
      (war3SpriteMaterial('m', 'm', 'Flare.tif', { blendMode: 3, priority: 0, alphaTestThreshold: 0, metadata: {}, teamColor: team })
        .shader.parameters.renderModel.standard.layers as Record<string, { op?: number; teamColorMode?: number }>)
    expect(material(false)['emissive1']).toBeUndefined()
    expect(material(true)['emissive1']).toMatchObject({ op: 0, teamColorMode: 1 })
  })
})

describe('CORN tracks', () => {
  it('read a clip of a keyed track: steps, lines, statics and global sequences', () => {
    const keys = [
      { Frame: 1000, Vector: Float32Array.of(1) },
      { Frame: 2000, Vector: Float32Array.of(0) },
    ]
    const linear = { LineType: 1, GlobalSeqId: null, Keys: keys } as never
    const step = { LineType: 0, GlobalSeqId: null, Keys: keys } as never
    expect(war3PopcornTrackAt(linear, 1000, 3000, 1500)).toBeCloseTo(0.5)
    expect(war3PopcornTrackAt(step, 1000, 3000, 1500)).toBe(1)
    expect(war3PopcornTrackAt(step, 1000, 3000, 2500)).toBe(0)
    // a track no key of which lies in the clip, a static value, a global sequence: 1
    expect(war3PopcornTrackAt(step, 5000, 6000, 5500)).toBe(1)
    expect(war3PopcornTrackAt(0, 0, 1, 0)).toBe(1)
    expect(war3PopcornTrackAt({ LineType: 0, GlobalSeqId: 2, Keys: keys } as never, 1000, 3000, 2500)).toBe(1)
  })
})
