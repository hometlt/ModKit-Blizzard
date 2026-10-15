import { describe, expect, it } from 'vitest'
import { parseSc2StringsOrdered } from '../../shared/core/text-file.js'
import { analyzeHotkeyStringFile, validateHotkeyValue } from '../../shared/core/hotkeys.js'

describe('validateHotkeyValue', () => {
  it('accepts comma alternatives, chords, mouse, numpad and None', () => {
    expect(validateHotkeyValue('Slash,F12,Escape')).toHaveLength(0)
    expect(validateHotkeyValue('Shift+Equals')).toHaveLength(0)
    expect(validateHotkeyValue('Shift+Alt+9')).toHaveLength(0)
    expect(validateHotkeyValue('Space,LeftMouseButton')).toHaveLength(0)
    expect(validateHotkeyValue('NumPadPlus')).toHaveLength(0)
    expect(validateHotkeyValue('None')).toHaveLength(0)
  })

  it('reports text that is not a known key value', () => {
    const issues = validateHotkeyValue('Space,Not A Key')
    expect(issues).toEqual([expect.objectContaining({ message: 'Unknown hotkey value "Not A Key"' })])
  })

  it('marks None as exclusive', () => {
    expect(validateHotkeyValue('None,Escape')[0]).toMatchObject({ message: 'None must be the only hotkey value' })
  })
})

describe('analyzeHotkeyStringFile', () => {
  it('emits invalid-hotkey diagnostics with value-local ranges', () => {
    const [diag] = analyzeHotkeyStringFile(parseSc2StringsOrdered('UI/Hotkey/Test=Space,BadKey\n'))
    expect(diag).toMatchObject({ code: 'invalid-hotkey', start: 6, end: 12 })
  })
})
