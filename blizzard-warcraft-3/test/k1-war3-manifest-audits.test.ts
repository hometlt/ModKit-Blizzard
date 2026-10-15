/**
 * K1 source feature audits for the Warcraft III codecs MK2 only planned: `warcraft3-replay`,
 * `warcraft3-map`, `warcraft3-wts` and `warcraft3-script`. In MK2 each was a manifest with status
 * `unsupported`, one `planned` runtime variant with no entrypoint, and no source. The audit shows
 * that nothing else existed to carry over, that MK3 now matches every extension the manifest named,
 * and that the MK3 carrier opens a file written for the test and returns what was written into it.
 * `warcraft3-object-data` is audited the same way: `.slk` is the core SYLK codec's, the object
 * editor's files the Warcraft III object-mods codec's. The receipts under
 * `test/receipts/k1` are pinned by the core feature ledger; `MODKIT_WRITE_K1_RECEIPTS=1` writes a
 * missing one.
 */
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Codec, ContributionContext, LanguageProvider, TableDataSource, TreeDataSource } from '@modkit/sdk'
import { createModkit, openPathArtifactSource } from '@modkit/host/node'
import { authoredMap, authoredReplay, authoredUnitChanges } from './war3-fixtures.js'
import { budget, context, extension, input, source } from './war3-harness.js'

const receipts = join(extension, 'test', 'receipts', 'k1')
const write = process.env['MODKIT_WRITE_K1_RECEIPTS'] === '1'
const workspace = join(extension, '..', '..')
const MK2_COMMIT = '1a14ba4eddd0ae88de273348ebd44cfb98a0581d'
const MK2_CODECS = 'references/modkitmk2/extensions/blizzard/warcraft-3/codecs'
const SUITE = 'modkit-extensions-blizzard/blizzard-warcraft-3/test/k1-war3-manifest-audits.test.ts'
const HERE = 'modkit-extensions-blizzard/blizzard-warcraft-3'

const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
/** A checkout may rewrite line endings; the digest is of the LF text so every machine agrees. */
const textOf = async (path: string) => (await readFile(path, 'utf8')).replaceAll('\r\n', '\n')

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  )
}

interface Case {
  readonly id: string
  readonly verdict: 'identical' | 'different'
  readonly resultDigest: string
  readonly mk3Operation: string
}
const compare = (id: string, mk3Operation: string, observed: unknown, expected: unknown): Case => ({
  id,
  verdict: canonical(observed) === canonical(expected) ? 'identical' : 'different',
  resultDigest: sha256(canonical(observed)),
  mk3Operation,
})

interface Mk2Manifest {
  readonly status: string
  readonly match: { readonly extensions: readonly string[] }
  readonly capabilities: readonly unknown[]
  readonly runtimeVariants: readonly { readonly id: string; readonly availability: string; readonly entrypoints: object }[]
}

/** What an MK3 manifest (codec match or language facet) says it opens. */
async function extensionsOf(path: string): Promise<string[]> {
  const text = await readFile(join(workspace, path), 'utf8')
  return [...text.matchAll(/"extensions":\s*\[([^\]]*)\]/gu)].flatMap(match =>
    [...match[1]!.matchAll(/"([^"]+)"/gu)].map(item => `.${item[1]!}`),
  )
}

/**
 * The cases every manifest-only audit shares: the MK2 directory holds the manifest alone, its one
 * runtime variant is `planned` with no entrypoint and no capability, and every extension it named
 * is matched by an MK3 carrier.
 */
async function manifestCases(codec: string, carriers: readonly string[]): Promise<Case[]> {
  const directory = join(workspace, MK2_CODECS, codec)
  const manifest = JSON.parse(await textOf(join(directory, 'codec.manifest.json'))) as Mk2Manifest
  const matched = new Set((await Promise.all(carriers.map(extensionsOf))).flat())
  return [
    compare('mk2-source:files', 'no MK2 source to carry', (await readdir(directory, { recursive: true })).sort(), [
      'codec.manifest.json',
    ]),
    compare(
      'mk2-manifest:runtimeVariants',
      'no MK2 runtime to carry',
      [manifest.status, manifest.capabilities, manifest.runtimeVariants.map(variant => [variant.id, variant.availability, Object.keys(variant.entrypoints)])],
      ['unsupported', [], [['planned', 'unavailable', []]]],
    ),
    compare(
      'mk2-manifest:match.extensions',
      carriers.join(', '),
      manifest.match.extensions.filter(name => matched.has(name)),
      manifest.match.extensions,
    ),
  ]
}

const languageProvider = async (name: string) =>
  (
    (await import(pathToFileURL(join(extension, 'providers', name, 'runtime.js')).href)) as {
      createProvider(selection: { contract: string; major: number }): { value: LanguageProvider }
    }
  ).createProvider({ contract: 'common.language/document-analysis', major: 1 }).value

interface Row {
  readonly codec: string
  readonly contribution: string
  readonly carriers: readonly string[]
  /** What the carrier is given, for the receipt. */
  readonly sample: { readonly name: string; readonly builder: string; readonly sha256: string }
  readonly executed: () => Promise<Case>
}

const JASS = 'globals\n    integer count = 0\nendglobals\nfunction Tick takes nothing returns nothing\n    set count = count + 1\nendfunction\n'
const WTS = 'STRING 1\n{\nLantern Isle\n}\n\nSTRING 2\n// Quest\n{\nFind the lantern.\n}\n'

const ROWS: Record<string, () => Promise<Row>> = {
  'warcraft3-replay': async () => {
    const bytes = authoredReplay()
    return {
      codec: 'warcraft3-replay',
      contribution: `${HERE}/contributions/codec-war3-replay.json`,
      carriers: [`${HERE}/contributions/codec-war3-replay.json`],
      sample: { name: 'authored.w3g', builder: `${HERE}/test/war3-fixtures.ts#authoredReplay`, sha256: sha256(bytes) },
      async executed() {
        const { createCodec } = (await import(pathToFileURL(join(extension, 'dist', 'war3-replay', 'codec.js')).href)) as {
          createCodec(context: ContributionContext): Codec
        }
        const session = await createCodec(context).open(input(source(bytes)), 'inspect', budget)
        try {
          const result = await session.operations().invoke('export-convert', null)
          if (result.state !== 'ok' || result.output.kind !== 'json') throw new Error(JSON.stringify(result))
          const replay = result.output.value as {
            version: string
            durationMs: number
            map: { path: string }
            players: { name: string; commands: number; apm?: number }[]
            chat: { text: string }[]
          }
          return compare(
            'mk3-carrier:export.convert',
            'blizzard/war3-replay export.convert',
            [replay.version, replay.durationMs, replay.map.path, replay.players.map(player => [player.name, player.commands, player.apm]), replay.chat.map(line => line.text)],
            ['1.24', 1000, 'Maps\\Test.w3x', [['Host', 1, 60], ['Guest', 1, 60]], ['gg']],
          )
        } finally {
          await session.dispose()
        }
      },
    }
  },
  'warcraft3-map': async () => {
    const bytes = await authoredMap()
    return {
      codec: 'warcraft3-map',
      contribution: `${HERE}/contributions/codec-war3-map.json`,
      carriers: [`${HERE}/contributions/codec-war3-map.json`],
      sample: { name: 'authored.w3x', builder: `${HERE}/test/war3-fixtures.ts#authoredMap`, sha256: sha256(bytes) },
      async executed() {
        const scratch = await mkdtemp(join(tmpdir(), 'modkit-war3-audit-'))
        const path = join(scratch, 'Test.w3x')
        await writeFile(path, bytes)
        const host = await createModkit({ extensions: [join(extension, '..', 'mpq'), extension], roots: [scratch] })
        const opened = await host.services.open({
          source: await openPathArtifactSource(path),
          path,
          intent: 'full',
          grant: { id: 'war3-map-audit', classes: ['read-source'] },
          budget: { ...budget, maxInputBytes: 4_000_000n },
        })
        if (opened.state !== 'opened') throw new Error(`map did not open: ${opened.state}`)
        try {
          const invoke = async (id: string, request: unknown) => {
            const handler = opened.descriptor.operations.find(item => item.id === id)?.handlerId
            const result = await opened.session.operations().invoke(handler!, request as never)
            if (result.state !== 'ok') throw new Error(`${id}: ${JSON.stringify(result)}`)
            return (result.output as { value: unknown }).value
          }
          const layers = (await invoke('map.layers', {})) as { layers: { id: string }[] }
          const height = (await invoke('map.layer-read', { layer: 'height' })) as { values: number[] }
          const tree = await opened.session.dataSource('common.view/tree-data-source', 1)
          const name = await (async () => {
            const data = tree.value as TreeDataSource
            return (await data.facts(await data.root())).label
          })().finally(() => tree.release())
          return compare(
            'mk3-carrier:map.layers',
            'blizzard/war3-map over blizzard/mpq: tree, map.layers, map.layer-read',
            [opened.selected.contributionId, name, layers.layers.map(layer => layer.id), height.values],
            [
              'blizzard/war3-map',
              'Lantern Isle',
              ['height', 'cliff-level', 'water', 'ground-texture', 'corner-flags', 'pathing'],
              [8704, 8708, 8712, 8192, 8196, 8200],
            ],
          )
        } finally {
          await opened.session.dispose()
          await rm(scratch, { recursive: true, force: true })
        }
      },
    }
  },
  'warcraft3-object-data': async () => {
    const bytes = authoredUnitChanges()
    return {
      codec: 'warcraft3-object-data',
      contribution: `${HERE}/contributions/codec-war3-object-mods.json`,
      carriers: [`${HERE}/contributions/codec-war3-object-mods.json`, 'modkit-core/extensions/data/contributions/codec-slk.json'],
      sample: { name: 'authored.w3u', builder: `${HERE}/test/war3-fixtures.ts#authoredUnitChanges`, sha256: sha256(bytes) },
      async executed() {
        const { createCodec } = (await import(pathToFileURL(join(extension, 'dist', 'war3-object-mods', 'codec.js')).href)) as {
          createCodec(context: ContributionContext): Codec
        }
        const session = await createCodec(context).open(input(source(bytes, 'memory://audit/war3map.w3u')), 'inspect', budget)
        try {
          const lease = await session.dataSource('common.view/table-data-source', 1)
          const rows = await (lease.value as TableDataSource).rows({ kind: 'range', from: 0, count: 10 }).finally(() => lease.release())
          return compare(
            'mk3-carrier:table-data-source',
            'blizzard/war3-object-mods table-data-source',
            rows.items.map(row => row.cells),
            [
              ['original', 'hfoo', '', 'uhpm', '', '', 'int', '999'],
              ['original', 'hfoo', '', 'unam', '', '', 'string', 'Guard'],
              ['custom', 'h000', 'hpea', 'umvs', '', '', 'real', '1.5'],
            ],
          )
        } finally {
          await session.dispose()
        }
      },
    }
  },
  'warcraft3-wts': async () => ({
    codec: 'warcraft3-wts',
    contribution: `${HERE}/providers/wts-language/provider.json`,
    carriers: [`${HERE}/providers/wts-language/provider.json`],
    sample: { name: 'authored.wts', builder: SUITE, sha256: sha256(WTS) },
    async executed() {
      const provider = await languageProvider('wts-language')
      const analysis = await provider.analyze({ document: { uri: 'memory://audit/war3map.wts', languageId: 'war3-wts', version: 1, text: WTS } })
      return compare(
        'mk3-carrier:analyze',
        'blizzard/war3-wts-language analyze',
        [analysis.symbols.map(symbol => `${symbol.name}: ${symbol.detail}`), analysis.diagnostics.length],
        [['STRING 1: Lantern Isle', 'STRING 2: Find the lantern.'], 0],
      )
    },
  }),
  'warcraft3-script': async () => ({
    codec: 'warcraft3-script',
    contribution: `${HERE}/providers/jass-language/provider.json`,
    // `.lua` scripts (1.31+) are the core Lua language's, with Warcraft III knowledge still to come.
    carriers: [`${HERE}/providers/jass-language/provider.json`, 'modkit-core/extensions/lua/contributions/provider-lua-language.json'],
    sample: { name: 'authored.j', builder: SUITE, sha256: sha256(JASS) },
    async executed() {
      const provider = await languageProvider('jass-language')
      const analysis = await provider.analyze({ document: { uri: 'memory://audit/war3map.j', languageId: 'jass', version: 1, text: JASS } })
      return compare(
        'mk3-carrier:analyze',
        'blizzard/war3-jass-language analyze',
        [analysis.symbols.map(symbol => symbol.name), analysis.diagnostics.length],
        [['count', 'Tick'], 0],
      )
    },
  }),
}

describe('K1 source feature audits of the Warcraft III codecs MK2 only planned', () => {
  it.each(Object.keys(ROWS))('%s: nothing to carry, every extension matched, the carrier runs', async name => {
    const row = await ROWS[name]!()
    const cases = [...(await manifestCases(row.codec, row.carriers)), await row.executed()]
    const identical = cases.filter(item => item.verdict === 'identical')
    const manifestPath = `${MK2_CODECS}/${row.codec}/codec.manifest.json`
    const expected = {
      schemaVersion: 1,
      codec: row.codec,
      corpusKind: 'synthetic',
      verdict: identical.length === cases.length ? 'pass' : 'fail',
      tests: { passed: identical.length, failed: cases.length - identical.length, skipped: 0 },
      inputs: {
        operation: 'source-feature-audit',
        oracle: `the MK2 codec (${MK2_CODECS}/${row.codec} at ${MK2_COMMIT}) is its manifest alone, planned and unsupported; every extension it names against the MK3 carrier that matches it, and the carrier run on a file written for the test`,
        suite: SUITE,
        samples: [
          row.sample,
          { name: 'mk2 codec.manifest.json', fixture: manifestPath, sha256LF: sha256(await textOf(join(workspace, manifestPath))) },
        ],
      },
      cases,
      proofs: [
        {
          requirement: `legacy/codec-manifest/modkit/${row.codec}/audit`,
          kind: 'audit',
          adapterOperation: 'source-feature-audit',
          targetOperation: 'source-feature-audit',
          handlerId: 'source-feature-audit',
          contribution: row.contribution,
          executed: true,
          caseIds: identical.map(item => item.id),
        },
      ],
    }
    expect(cases.filter(item => item.verdict === 'different')).toEqual([])
    const file = join(receipts, `${row.codec}.audit.json`)
    const exists = await access(file).then(
      () => true,
      () => false,
    )
    if (!exists && write) {
      await mkdir(receipts, { recursive: true })
      await writeFile(file, `${JSON.stringify(expected, null, 2)}\n`)
    }
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(expected)
  })
})
