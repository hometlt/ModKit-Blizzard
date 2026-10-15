import fs from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { TreeNodeFacts, TreeNodeRef } from '@modkit/sdk'
import { Sc2FolderSource } from '../../../game/battlenet/content-sources/local-files.js'
import { createSc2ModContexts } from '../../shared/workspace/mod-contexts.js'

const scratchRoot = 'C:/MKTEMP'
let scratch: string
let target: string
beforeAll(async () => {
  await fs.mkdir(scratchRoot, { recursive: true })
  scratch = await fs.mkdtemp(path.join(scratchRoot, 'sc2-resource-locales-'))
  target = path.join(scratch, 'Locale.SC2Mod')
  for (const [file, text] of Object.entries({
    DocumentInfo: '<DocInfo><Dependencies/></DocInfo>',
    'Base.SC2Data/GameData/UnitData.xml': '<Catalog><CUnit id="Marine"/></Catalog>',
    'enUS.SC2Data/LocalizedData/GameStrings.txt': 'Unit/Name/Marine=Marine\n',
    'ruRU.SC2Data/LocalizedData/GameStrings.txt': 'Unit/Name/Marine=Морпех\n',
    'Base.SC2Data/UI/FontStyles.SC2Style': '<Styles><Constant name="Size" val="12"/><Style name="Title" height="12"/></Styles>',
    'enUS.SC2Data/UI/FontStyles.SC2Style': '<Styles><Constant name="Size" val="14"/><Style name="Title" height="14"/><Style name="English"/></Styles>',
    'ruRU.SC2Data/UI/FontStyles.SC2Style': '<Styles><Constant name="Size" val="16"/><Style name="Title" height="16"/><Style name="Russian"/></Styles>',
  })) {
    const destination = path.join(target, file)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.writeFile(destination, text)
  }
})
afterAll(async () => {
  if (scratch !== undefined && path.resolve(scratch).startsWith(path.resolve(scratchRoot) + path.sep))
    await fs.rm(scratch, { recursive: true, force: true })
})

function contexts() {
  const reads = new Map<string, number>()
  const loader = createSc2ModContexts({
    sources: () => new Map(),
    defaultBaseMods: [],
    hostFolder: directory => {
      const folder = new Sc2FolderSource(directory, 'host', 'host')
      return {
        id: 'host',
        list: (file: string) => folder.list(file),
        read: (file: string, max: number) => {
          reads.set(file, (reads.get(file) ?? 0) + 1)
          return folder.read(file, max)
        },
        dispose: () => folder.dispose(),
      }
    },
  })
  const open = (locale: string) => loader.open({ schemaVersion: 1, target, locales: [locale] })
  return { loader, open, reads }
}

it.each([
  ['enUS', 'Marine', 'ruRU', 'Морпех'],
  ['ruRU', 'Морпех', 'enUS', 'Marine'],
])('uses %s names (%s) before switching to %s (%s)', async (first, firstName, second, secondName) => {
  const { loader, open, reads } = contexts()
  try {
    const contexts = await Promise.all([open(first!), open(second!)])
    expect(contexts[0]!.contextId).not.toBe(contexts[1]!.contextId)
    const names = [firstName, secondName]
    const node = { id: 'entity/Unit/Marine', hasChildren: true }
    for (const [index, context] of contexts.entries()) {
      const root = await context.query({ kind: 'resources.tree', action: 'root' }) as TreeNodeRef
      expect(root.hasChildren).toBe(true)
      const facts = await context.query({ kind: 'resources.tree', action: 'facts', node }) as TreeNodeFacts
      expect(facts.preview).toContain(names[index])
    }
    const previousReads = new Map(reads)
    const again = await open(first!)
    const facts = await again.query({ kind: 'resources.tree', action: 'facts', node }) as TreeNodeFacts
    expect(facts.preview).toContain(firstName)
    expect(reads).toEqual(previousReads)
  } finally { await loader.dispose() }
})

it('shares document reads across concurrent resource requests and locales', async () => {
  const { loader, open, reads } = contexts()
  try {
    const context = await open('enUS')
    const roots = await Promise.all(Array.from({ length: 8 }, () => context.query({ kind: 'resources.tree', action: 'root' })))
    for (const root of roots) expect(root).toEqual(roots[0])
    const previousReads = new Map(reads)
    const localized = await open('ruRU')
    await localized.query({ kind: 'resources.tree', action: 'root' })
    expect(reads).toEqual(previousReads)
    const dataReads = [...reads].filter(([file]) => file.toLowerCase().endsWith('/unitdata.xml'))
    expect(dataReads).toHaveLength(1)
    expect(dataReads[0]![1]).toBe(1)
  } finally { await loader.dispose() }
})

it('does not parse resources for a request cancelled before it starts', async () => {
  const { loader, open, reads } = contexts()
  try {
    const context = await open('enUS')
    const previousReads = new Map(reads)
    const reason = new Error('cancelled resource request')
    await expect(context.query({ kind: 'resources.tree', action: 'root' }, AbortSignal.abort(reason))).rejects.toBe(reason)
    expect(reads).toEqual(previousReads)
    const root = await context.query({ kind: 'resources.tree', action: 'root' }) as TreeNodeRef
    expect(root.hasChildren).toBe(true)
  } finally { await loader.dispose() }
})

it('shows effective localized styles, constants and their owning declarations', async () => {
  const { loader, open } = contexts()
  try {
    for (const [locale, name, height] of [['enUS', 'English', '14'], ['ruRU', 'Russian', '16']]) {
      const context = await open(locale!)
      const styles = await context.query({ kind: 'resources.tree', action: 'children',
        node: { id: 'style-section/styles', hasChildren: true }, page: { limit: 100 } }) as { items: TreeNodeRef[] }
      expect(styles.items.map(item => item.id)).toContain(`style-item/styles/${name}`)
      const facts = await context.query({ kind: 'resources.tree', action: 'facts',
        node: { id: 'style-item/styles/Title', hasChildren: true } }) as TreeNodeFacts
      expect(facts.value).toMatchObject({ height })
      expect(facts.subjectId).toContain(`${locale}.SC2Data`)
      const constant = await context.query({ kind: 'resources.tree', action: 'facts',
        node: { id: 'style-item/constants/Size', hasChildren: false } }) as TreeNodeFacts
      expect(constant.preview).toBe(height)
      expect(constant.subjectId).toContain(`${locale}.SC2Data`)
    }
  } finally { await loader.dispose() }
})
