import { describe, it, expect } from 'vitest'
import { diffStringTexts, parseStringFileDiff } from '../../shared/core/diff.js'

describe('diffStringTexts', () => {
  it('detects added / modified / deleted by key', () => {
    const oldT = 'A=1\nB=2\nC=3\n'
    const newT = 'A=1\nB=9\nD=4\n'
    const ch = diffStringTexts(oldT, newT).sort((a, b) => a.key.localeCompare(b.key))
    expect(ch).toEqual([
      { key: 'B', kind: 'modified', oldValue: '2', newValue: '9' },
      { key: 'C', kind: 'deleted', oldValue: '3' },
      { key: 'D', kind: 'added', newValue: '4' },
    ])
  })
})

describe('parseStringFileDiff', () => {
  it('parses a unified git diff into key-level changes', () => {
    const patch = [
      '--- a/GameStrings.txt',
      '+++ b/GameStrings.txt',
      '@@ -1,3 +1,3 @@',
      ' Unit/Name/Marine=Marine',
      '-Unit/Name/Zealot=Zealot',
      '+Unit/Name/Zealot=Zealot Mk2',
      '+Unit/Name/Zergling=Zergling',
      '-Unit/Name/Old=Gone',
    ].join('\n')
    const ch = parseStringFileDiff(patch).sort((a, b) => a.key.localeCompare(b.key))
    expect(ch).toEqual([
      { key: 'Unit/Name/Old', kind: 'deleted', oldValue: 'Gone' },
      { key: 'Unit/Name/Zealot', kind: 'modified', oldValue: 'Zealot', newValue: 'Zealot Mk2' },
      { key: 'Unit/Name/Zergling', kind: 'added', newValue: 'Zergling' },
    ])
  })
})
