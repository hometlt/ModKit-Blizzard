import { describe, expect, it } from 'vitest'
import { joinPath, normalizePath } from '../../src/casc/binary.js'

describe('normalizePath', () => {
  it('preserves a leading slash for absolute POSIX paths', () => {
    // Regression: an absolute install root must stay absolute, otherwise
    // FsReader.get() resolves it against cwd and fails with ENOENT (#126).
    expect(normalizePath('/home/user/StarCraft II')).toBe('/home/user/StarCraft II')
  })

  it('collapses duplicate leading slashes to one', () => {
    expect(normalizePath('//home/user')).toBe('/home/user')
  })

  it('leaves relative virtual paths relative', () => {
    expect(normalizePath('config/ab/cd/key')).toBe('config/ab/cd/key')
  })

  it('leaves Windows drive-letter roots unchanged', () => {
    expect(normalizePath('C:/Program Files/StarCraft II')).toBe('C:/Program Files/StarCraft II')
  })

  it('converts backslashes and trims a trailing slash', () => {
    expect(normalizePath('C:\\mods\\MyMod\\')).toBe('C:/mods/MyMod')
  })
})

describe('joinPath', () => {
  it('joins an absolute install root with a child, keeping it absolute', () => {
    expect(joinPath('/home/user/StarCraft II', '.build.info')).toBe(
      '/home/user/StarCraft II/.build.info',
    )
  })

  it('drops empty parts and stays relative when the root is empty', () => {
    expect(joinPath('', '.build.info')).toBe('.build.info')
  })

  it('joins relative CASC-internal segments', () => {
    expect(joinPath('SC2Data', 'config', 'ab')).toBe('SC2Data/config/ab')
  })
})
