import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { compilePublicationPackage, localeDocument } from '../publishing/package-compiler.js'
import { decodeCacheHeader, field, number, blob, array } from '../content-sources/cache-header.js'

const header = process.env['MODKIT_SC2_HEADER_FIXTURE']
const archive = process.env['MODKIT_SC2_ARCHIVE_FIXTURE']
const available = Boolean(header && archive && existsSync(header) && existsSync(archive))

describe('publication package compiler', () => {
  it('refuses a first publication instead of inventing a header', async () => {
    await expect(
      compilePublicationPackage(
        {
          archive: { path: 'X.SC2Mod', bytes: Uint8Array.of(1) },
          baseHeader: new Uint8Array(),
          namespace: 1,
          region: 'us',
          kind: 'mod',
          locale: 'enUS',
          texts: [{ locale: 'enUS', name: 'X' }],
          target: { mode: 'create' },
          visibility: 'private',
          locked: false,
        },
        join(tmpdir(), 'modkit-compile-refused'),
      ),
    ).rejects.toThrow('StarCraft II Editor')
  })

  it('writes one locale entry per string the header points at', () => {
    const xml = new TextDecoder().decode(localeDocument('ruRU', new Map([[2, 'Второй'], [1, 'Имя & «знак»']])))
    expect(xml).toContain('<Locale region="ruRU">')
    expect(xml.indexOf('id="1"')).toBeLessThan(xml.indexOf('id="2"'))
    expect(xml).toContain('Имя &amp; «знак»')
  })

  /** A real editor header and its archive, when this machine has them; none is committed. */
  it.skipIf(!available)('compiles a next revision from an editor header', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'modkit-compile-'))
    try {
      const archiveBytes = new Uint8Array(readFileSync(archive!))
      const compiled = await compilePublicationPackage(
        {
          archive: { path: archive!, bytes: archiveBytes },
          baseHeader: new Uint8Array(readFileSync(header!)),
          namespace: 474349,
          region: 'us',
          kind: 'mod',
          locale: 'enUS',
          texts: [
            { locale: 'enUS', name: 'Mod11', description: 'Compiled by Modkit' },
            { locale: 'ruRU', name: 'Мод11', description: 'Собрано Modkit' },
          ],
          target: { mode: 'update', id: 377020, expectedVersion: 65538 },
          visibility: 'private',
          locked: true,
        },
        directory,
      )
      const manifest = JSON.parse(await readFile(compiled.packagePath, 'utf8'))
      expect(manifest.schema).toBe(1)
      expect(manifest.archiveSha256).toBe(createHash('sha256').update(archiveBytes).digest('hex'))
      expect(manifest.locales).toHaveLength(2)
      expect(manifest.metadata.m_localizedNames).toEqual([
        { m_locale: 'enUS', m_name: 'Mod11' },
        { m_locale: 'ruRU', m_name: 'Мод11' },
      ])

      const tree = decodeCacheHeader(new Uint8Array(await readFile(join(directory, 'publication.s2mh'))))
      const publication = field(tree, 0)
      expect(number(field(publication, 3))).toBe(474349)
      expect(number(field(field(publication, 0), 1))).toBe(65538)
      // Every depot reference the header carries must be a component of this package.
      const digests = new Set([manifest.archiveSha256, ...manifest.locales.map((item: { sha256: string }) => item.sha256)])
      expect(Buffer.from(blob(field(publication, 2)).subarray(8)).toString('hex')).toBe(manifest.archiveSha256)
      for (const entry of array(field(publication, 8))) {
        const handle = blob(array(field(entry, 1))[0]!)
        expect(digests.has(Buffer.from(handle.subarray(8)).toString('hex'))).toBe(true)
        expect(Buffer.from(handle.subarray(6, 8)).toString('ascii')).toBe('US')
      }
      const russian = await readFile(join(directory, 'ruRU.s2ml'), 'utf8')
      expect(russian).toContain('Мод11')
      expect(russian).toContain('Собрано Modkit')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
