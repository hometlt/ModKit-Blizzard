import { describe, expect, it } from 'vitest'
import { CascInstallReader } from '../../src/casc/install-reader.js'
import type { CascReader } from '../../src/casc/reader.js'

describe('CascInstallReader', () => {
  it('canonicalizes separators in listed CASC paths', async () => {
    const casc = {
      listPaths: () => ['Appearance\\\\Zombiecrawler_male.app', 'Textures//50310.tex'],
    } as unknown as CascReader

    await expect(new CascInstallReader(casc).list('')).resolves.toEqual([
      'Appearance/Zombiecrawler_male.app',
      'Textures/50310.tex',
    ])
  })

  it('recognizes exact virtual file aliases as existing', async () => {
    const casc = {
      hasPath: (path: string) => path === 'Textures/50310.tex',
      hasPrefix: () => false,
    } as unknown as CascReader

    await expect(new CascInstallReader(casc).exists('Textures/50310.tex')).resolves.toBe(true)
  })
})
