/**
 * Corpus gate for the GameStrings key scanner: on Blizzard's core layouts, every key the layout
 * schema types as `Text` must be found by `layoutTextReferences`. Runs in tier `real` when the
 * reference game data is present; the assets never enter the repository.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { layoutTextReferences } from '../../../shared/language/layout-text-refs.js'
import { layoutSchemaTextValues, layoutStore } from '../shared/schema-index.js'

const root =
  process.env['MODKITX_SC2_LAYOUT_CORPUS_ROOT'] ??
  join(import.meta.dirname, '..', '..', '..', '..', '..', 'references', 'SC2GameData', 'mods', 'core.sc2mod', 'base.sc2data', 'UI', 'Layout')

const walk = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory()
      ? walk(join(directory, entry.name))
      : /\.sc2layout$/iu.test(entry.name)
        ? [join(directory, entry.name)]
        : [],
  )

describe.skipIf(!existsSync(root))('core layout GameStrings key references', () => {
  it('finds every schema-typed Text key in every core layout', () => {
    const documents = walk(root).map(path => ({
      uri: `file:///${path.replaceAll('\\', '/')}`,
      text: readFileSync(path, 'utf8'),
    }))
    const store = layoutStore(documents)
    let schemaKeys = 0
    const missed: string[] = []
    for (const document of documents) {
      const scanned = new Set(layoutTextReferences(document.text).map(item => `${item.start}:${item.key}`))
      for (const value of layoutSchemaTextValues(store, document.uri)) {
        const prefix = /^@@?/u.exec(value.value)?.[0].length ?? 0
        const key = value.value.slice(prefix)
        if (prefix === 0 || key === '' || key.startsWith('@')) continue
        schemaKeys += 1
        if (!scanned.has(`${value.start + prefix}:${key}`)) missed.push(`${document.uri} ${value.element}@${value.attribute} ${key}`)
      }
    }
    expect(documents.length).toBeGreaterThan(300)
    expect(schemaKeys).toBeGreaterThan(2000)
    expect(missed.slice(0, 10)).toEqual([])
  }, 300_000)
})
