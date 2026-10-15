/**
 * K1 source feature audits for the StarCraft codecs MK2 only planned: `starcraft-chk`,
 * `starcraft-grp` and `blizzard-tbl`. In MK2 each was a manifest with status `unsupported`, one
 * `planned` runtime variant with no entrypoint, and no source (`blizzard-tbl` also named Diablo II and
 * Warcraft II, both dropped by the owner; Diablo II's `.tbl` is another format). The audit shows that
 * nothing else existed to carry over, that MK3 matches every extension the manifest named, and that
 * the MK3 carrier opens a file written for the test and returns what was written into it.
 * `starcraft-replay` stays pending until its codec exists. The receipts under
 * `test/receipts/k1` are pinned by the core feature ledger; `MODKIT_WRITE_K1_RECEIPTS=1` writes a
 * missing one.
 */
import { createHash } from 'node:crypto'
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  revisionId,
  type ArtifactByteSource,
  type AssetInput,
  type Codec,
  type ContributionContext,
  type RasterImageSource,
  type ResourceBudget,
  type TableDataSource,
} from '@modkit/sdk'
import { authoredGrp, authoredScenario, authoredTbl } from './sc1-fixtures.js'

const extension = join(import.meta.dirname, '..')
const receipts = join(extension, 'test', 'receipts', 'k1')
const write = process.env['MODKIT_WRITE_K1_RECEIPTS'] === '1'
const workspace = join(extension, '..', '..')
const MK2_COMMIT = '1a14ba4eddd0ae88de273348ebd44cfb98a0581d'
const SUITE = 'modkit-extensions-blizzard/blizzard-starcraft-1/test/k1-sc1-manifest-audits.test.ts'
const HERE = 'modkit-extensions-blizzard/blizzard-starcraft-1'

const budget: ResourceBudget = { maxInputBytes: 1_000_000n, maxDepth: 32, maxNodes: 1000, maxScalarBytes: 1_000_000, maxDiagnostics: 100 }
const context: ContributionContext = {
  budgets: budget,
  diagnostics: { report: () => undefined },
  contracts: {
    async resolve() {
      throw new Error('StarCraft codecs have no service dependency')
    },
    async resolveUnknown() {
      throw new Error('StarCraft codecs have no foreign service dependency')
    },
  },
}

function input(bytes: Uint8Array): AssetInput {
  const uri = 'memory://blizzard-starcraft-1/audit'
  const value: ArtifactByteSource = {
    kind: 'bytes',
    ref: { id: uri, uri },
    revision: revisionId('content-hash.sha256:blizzard-starcraft1-audit'),
    size: BigInt(bytes.byteLength),
    async read(offset, length) {
      return bytes.slice(Number(offset), Number(offset) + length)
    },
    async *stream() {
      yield bytes
    },
  }
  const binding = { sourceKind: 'candidate' as const, bindingId: 'content', role: 'content', ownership: 'owned' as const, source: value.ref, revision: value.revision }
  return {
    originKind: 'single',
    bindings: [binding],
    primaryBindingId: 'content',
    revisions: { topology: 'single', revision: value.revision, bindings: [{ bindingId: 'content', revision: value.revision }], compositionFingerprint: value.ref.id },
    bindingsFor: () => [],
    async openBinding() {
      return { value, async release() {} }
    },
  }
}

async function open(codec: string, bytes: Uint8Array) {
  const { createCodec } = (await import(pathToFileURL(join(extension, 'dist', codec, 'codec.js')).href)) as {
    createCodec(context: ContributionContext): Codec
  }
  return createCodec(context).open(input(bytes), 'inspect', budget)
}

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
  readonly testedGames: readonly string[]
  readonly runtimeVariants: readonly { readonly id: string; readonly availability: string; readonly entrypoints: object }[]
}

async function extensionsOf(path: string): Promise<string[]> {
  const text = await readFile(join(workspace, path), 'utf8')
  return [...text.matchAll(/"extensions":\s*\[([^\]]*)\]/gu)].flatMap(match => [...match[1]!.matchAll(/"([^"]+)"/gu)].map(item => `.${item[1]!}`))
}

async function manifestCases(directory: string, carriers: readonly string[]): Promise<Case[]> {
  const manifest = JSON.parse(await textOf(join(workspace, directory, 'codec.manifest.json'))) as Mk2Manifest
  const matched = new Set((await Promise.all(carriers.map(extensionsOf))).flat())
  return [
    compare('mk2-source:files', 'no MK2 source to carry', (await readdir(join(workspace, directory), { recursive: true })).sort(), ['codec.manifest.json']),
    compare(
      'mk2-manifest:runtimeVariants',
      'no MK2 runtime to carry',
      [manifest.status, manifest.capabilities, manifest.runtimeVariants.map(variant => [variant.id, variant.availability, Object.keys(variant.entrypoints)])],
      ['unsupported', [], [['planned', 'unavailable', []]]],
    ),
    compare('mk2-manifest:match.extensions', carriers.join(', '), manifest.match.extensions.filter(name => matched.has(name)), manifest.match.extensions),
  ]
}

interface Row {
  readonly codec: string
  readonly directory: string
  readonly contribution: string
  readonly carriers: readonly string[]
  readonly sample: { readonly name: string; readonly builder: string; readonly sha256: string }
  /** What the MK2 manifest named that MK3 does not carry, and why. */
  readonly notCarried?: readonly string[]
  readonly executed: () => Promise<readonly Case[]>
}

const ROWS: Record<string, () => Row> = {
  'starcraft-chk': () => {
    const bytes = authoredScenario()
    return {
      codec: 'starcraft-chk',
      directory: 'references/modkitmk2/extensions/blizzard/starcraft-1/codecs/starcraft-chk',
      contribution: `${HERE}/contributions/codec-starcraft1-chk.json`,
      carriers: [`${HERE}/contributions/codec-starcraft1-chk.json`, `${HERE}/contributions/codec-starcraft1-map.json`],
      sample: { name: 'authored.chk', builder: `${HERE}/test/sc1-fixtures.ts#authoredScenario`, sha256: sha256(bytes) },
      async executed() {
        const session = await open('chk', bytes)
        try {
          const inspected = await session.operations().invoke('inspect', null)
          const layer = await session.operations().invoke('map-layer-read', { layer: 'tiles' } as never)
          if (inspected.state !== 'ok' || layer.state !== 'ok') throw new Error(JSON.stringify([inspected, layer]))
          const summary = (inspected.output as { value: Record<string, unknown> }).value
          return [
            compare(
              'mk3-carrier:view.inspect',
              'blizzard/starcraft1-chk view.inspect',
              [summary['name'], summary['version'], summary['tileset'], summary['width'], summary['height'], summary['players'], summary['units'], summary['locations']],
              ['Lantern Isle', 205, 'Jungle', 4, 2, 2, 1, 1],
            ),
            compare(
              'mk3-carrier:map.layer-read',
              'blizzard/starcraft1-chk map.layer-read',
              (layer.output as { value: { values: number[] } }).value.values,
              [16, 17, 18, 19, 32, 33, 34, 35],
            ),
          ]
        } finally {
          await session.dispose()
        }
      },
    }
  },
  'starcraft-grp': () => {
    const bytes = authoredGrp()
    return {
      codec: 'starcraft-grp',
      directory: 'references/modkitmk2/extensions/blizzard/starcraft-1/codecs/starcraft-grp',
      contribution: `${HERE}/contributions/codec-starcraft1-grp.json`,
      carriers: [`${HERE}/contributions/codec-starcraft1-grp.json`],
      sample: { name: 'authored.grp', builder: `${HERE}/test/sc1-fixtures.ts#authoredGrp`, sha256: sha256(bytes) },
      async executed() {
        const session = await open('grp', bytes)
        try {
          const raster = await session.dataSource('common.view/raster-image-source', 1)
          try {
            const source = raster.value as RasterImageSource
            const info = await source.info()
            const region = await source.readRegion!({ x: 0, y: 0, width: 4, height: 2, frame: 0, pixelFormat: 'rgba8', maxBytes: 64 })
            // Without a bound tileset palette the indices draw in grey; index 0 is transparent.
            const indices = Array.from({ length: 8 }, (_, pixel) => (region.pixels[pixel * 4 + 3] === 0 ? 0 : region.pixels[pixel * 4]!))
            return [
              compare('mk3-carrier:raster-image-source', 'blizzard/starcraft1-grp common.view/raster-image-source', [info.width, info.height, info.frames, indices], [4, 2, 1, [0, 5, 6, 0, 0, 0, 7, 0]]),
            ]
          } finally {
            await raster.release()
          }
        } finally {
          await session.dispose()
        }
      },
    }
  },
  'blizzard-tbl': () => {
    const bytes = authoredTbl()
    return {
      codec: 'blizzard-tbl',
      directory: 'references/modkitmk2/extensions/blizzard/common-formats/codecs/blizzard-tbl',
      contribution: `${HERE}/contributions/codec-starcraft1-tbl.json`,
      carriers: [`${HERE}/contributions/codec-starcraft1-tbl.json`],
      sample: { name: 'authored.tbl', builder: `${HERE}/test/sc1-fixtures.ts#authoredTbl`, sha256: sha256(bytes) },
      notCarried: [
        'testedGames diablo-2 and warcraft-2: both games were dropped by the owner (core 6ef4a334, b7961357); Diablo II .tbl is a hashed table, another format, and would be a codec of its own',
      ],
      async executed() {
        const session = await open('tbl', bytes)
        try {
          const table = await session.dataSource('common.view/table-data-source', 1)
          const rows = await (table.value as TableDataSource).rows({ kind: 'range', from: 0, count: 10 }).finally(() => table.release())
          return [
            compare(
              'mk3-carrier:table-data-source',
              'blizzard/starcraft1-tbl common.view/table-data-source',
              rows.items.map(row => row.cells),
              [['1', 'Terran Marine', 'Terran / Ground Units'], ['2', 'M<1><3>M<1>arine', '']],
            ),
          ]
        } finally {
          await session.dispose()
        }
      },
    }
  },
}

describe('K1 source feature audits of the StarCraft codecs MK2 only planned', () => {
  it.each(Object.keys(ROWS))('%s: nothing to carry, every extension matched, the carrier runs', async name => {
    const row = ROWS[name]!()
    const cases = [...(await manifestCases(row.directory, row.carriers)), ...(await row.executed())]
    const identical = cases.filter(item => item.verdict === 'identical')
    const manifestPath = `${row.directory}/codec.manifest.json`
    const expected = {
      schemaVersion: 1,
      codec: row.codec,
      corpusKind: 'synthetic',
      verdict: identical.length === cases.length ? 'pass' : 'fail',
      tests: { passed: identical.length, failed: cases.length - identical.length, skipped: 0 },
      inputs: {
        operation: 'source-feature-audit',
        oracle: `the MK2 codec (${row.directory} at ${MK2_COMMIT}) is its manifest alone, planned and unsupported; every extension it names against the MK3 carrier that matches it, and the carrier run on a file written for the test`,
        suite: SUITE,
        samples: [row.sample, { name: 'mk2 codec.manifest.json', fixture: manifestPath, sha256LF: sha256(await textOf(join(workspace, manifestPath))) }],
        ...(row.notCarried === undefined ? {} : { notCarried: row.notCarried }),
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
    const exists = await access(file).then(() => true, () => false)
    if (!exists && write) {
      await mkdir(receipts, { recursive: true })
      await writeFile(file, `${JSON.stringify(expected, null, 2)}\n`)
    }
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(expected)
  })
})
