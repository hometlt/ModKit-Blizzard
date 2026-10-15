import { describe, expect, it } from 'vitest'
import { SELECT_TABLE } from '../../src/casc/mndx.js'

describe('MNDX select table', () => {
  it('reproduces the pinned CascLib reference rows', () => {
    expect([...SELECT_TABLE.slice(0, 16)]).toEqual([
      7, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0,
    ])
    expect([...SELECT_TABLE.slice(256, 272)]).toEqual([
      7, 7, 7, 1, 7, 2, 2, 1, 7, 3, 3, 1, 3, 2, 2, 1,
    ])
    expect([...SELECT_TABLE.slice(512, 528)]).toEqual([
      7, 7, 7, 7, 7, 7, 7, 2, 7, 7, 7, 3, 7, 3, 3, 2,
    ])
  })
})
