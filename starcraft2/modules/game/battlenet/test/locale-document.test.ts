import { describe, expect, it } from 'vitest'

import { localeDocument } from '../publishing/package-compiler.js'

describe('the locale document a publication is named by', () => {
  it('ends where the editor ends it', () => {
    const text = Buffer.from(localeDocument('enUS', new Map([[1, 'ModTest'], [2, 'ModTest']]))).toString('utf8')

    // Battle.net refuses a header whose locale document carries a trailing newline.
    expect(text.endsWith('</Locale>')).toBe(true)
    expect(text).toBe(
      '<?xml version="1.0" encoding="utf-8"?>\r\n<Locale region="enUS">\r\n' +
        '    <e id="1">ModTest</e>\r\n    <e id="2">ModTest</e>\r\n</Locale>',
    )
  })
})
