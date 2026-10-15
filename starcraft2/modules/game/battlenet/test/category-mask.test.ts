import { describe, expect, it } from 'vitest'

import { categoryMaskOf, DEFAULT_VARIANT } from '../publishing/header-composer.js'

describe('the arcade categories a publication is listed under', () => {
  it('follows from the variants, which is why no query has to report it', () => {
    // A document with no lobby of its own: the category its single default variant names.
    expect(categoryMaskOf([DEFAULT_VARIANT])).toBe(2)
    // Two variants in different categories are listed under both.
    expect(categoryMaskOf([
      { categoryId: 1, modeId: 1, maxTeamSize: 1 },
      { categoryId: 4, modeId: 2, maxTeamSize: 2 },
    ])).toBe(0b10010)
    // Category zero appears in no published header, and a mask of zero is refused outright.
    expect(categoryMaskOf([])).toBe(0)
  })
})
