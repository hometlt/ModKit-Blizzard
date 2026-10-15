/**
 * K1 receipts for `war3-mdx`: each MK2 ledger row (`model.read`, `model.render`, the source feature
 * audit) runs through what MK3 publishes for it — the codec opened as the host opens it, its facets,
 * and the common scene renderer over its UVM export. A case is `identical` when the result equals
 * what was written into the authored model. The receipts under `test/receipts/k1` are pinned by the
 * core feature ledger, so this suite regenerates them and requires the committed files to match;
 * `MODKIT_WRITE_K1_RECEIPTS=1` writes a missing one.
 */
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type {
  ModelAnimationSource,
  ModelResourceRefsSource,
  ModelSceneSource,
  ModelSkeletonSource,
} from '@modkit/sdk'
import {
  authoredModelBytes,
  budget,
  extension,
  fixturePath,
  inspect,
  open,
} from './war3-harness.js'

const receipts = join(extension, 'test', 'receipts', 'k1')
const write = process.env['MODKIT_WRITE_K1_RECEIPTS'] === '1'
const MK2_MANIFEST =
  'references/modkitmk2/extensions/blizzard/warcraft-3/codecs/war3-mdx/codec.manifest.json'
const MK2_COMMIT = '1a14ba4eddd0ae88de273348ebd44cfb98a0581d'
const workspace = join(extension, '..', '..')
const CONTRIBUTION =
  'modkit-extensions-blizzard/blizzard-warcraft-3/contributions/codec-war3-mdx.json'
const SUITE = 'modkit-extensions-blizzard/blizzard-warcraft-3/test/k1-war3-mdx-receipts.test.ts'

const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex')

/** Key-sorted JSON, so a digest does not depend on property order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    ArrayBuffer.isView(item)
      ? Array.from(item as unknown as ArrayLike<number>)
      : item !== null && typeof item === 'object' && !Array.isArray(item)
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

/** What the harness writes into the authored model — the oracle every read case compares with. */
const AUTHORED = {
  summary: { geosets: 1, materials: 1, bones: 1, sequences: 1, textures: 1 },
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
  indices: [0, 1, 2],
  references: ['Textures\\Fixture.blp'],
  bones: ['Bone_Root'],
  clip: { name: 'Stand', startMilliseconds: 0, endMilliseconds: 1000 },
  translation: [
    [0, [0, 0, 0]],
    [1, [0, 0, 64]],
  ],
}

async function lease<T>(
  session: Awaited<ReturnType<typeof open>>,
  contract: string,
  read: (value: T) => Promise<unknown>,
): Promise<unknown> {
  const held = await session.dataSource(contract, 1)
  try {
    return await read(held.value as unknown as T)
  } finally {
    await held.release()
  }
}

async function readCases(): Promise<Case[]> {
  const bytes = await authoredModelBytes()
  const cases: Case[] = []
  for (const [encoding, model] of [
    ['mdx', bytes.mdx],
    ['mdl', bytes.mdl],
  ] as const) {
    const sample = `authored.${encoding}`
    const session = await open(model)
    try {
      const summary = (await inspect(session)) as Record<string, unknown>
      cases.push(
        compare(
          `${sample}:view.inspect`,
          'view.inspect',
          Object.fromEntries(Object.keys(AUTHORED.summary).map(key => [key, summary[key]])),
          AUTHORED.summary,
        ),
      )
      const geometry = await lease<ModelSceneSource>(
        session,
        'common.view/model-scene-source',
        async scene => {
          const meshes = await scene.meshes({ limit: 8 })
          const primitive = await scene.primitive(meshes.items[0]!.primitiveIds[0]!, {
            maxBytes: 1_000_000,
          })
          return { positions: primitive?.positions, indices: primitive?.indices }
        },
      )
      cases.push(
        compare(`${sample}:model-scene-source`, 'view.model-scene-source', geometry, {
          positions: AUTHORED.positions,
          indices: AUTHORED.indices,
        }),
      )
      const references = await lease<ModelResourceRefsSource>(
        session,
        'common.view/model-resource-refs-source',
        async source => (await source.references({ limit: 8 })).items.map(item => item.id),
      )
      cases.push(
        compare(
          `${sample}:model-resource-refs-source`,
          'view.model-resource-refs-source',
          references,
          AUTHORED.references,
        ),
      )
      const bones = await lease<ModelSkeletonSource>(
        session,
        'common.view/model-skeleton-source',
        async skeleton => (await skeleton.bindings({ limit: 8 })).items.map(item => item.boneName),
      )
      cases.push(
        compare(
          `${sample}:model-skeleton-source`,
          'view.model-skeleton-source',
          bones,
          AUTHORED.bones,
        ),
      )
      const animation = await lease<ModelAnimationSource>(
        session,
        'common.view/model-animation-source',
        async source => {
          const clip = (await source.clips({ limit: 8 })).items[0]
          const channel = clip?.channels?.find(item => item.kind === 'translation')
          return {
            clip: { name: clip?.name, ...clip?.nativeTimeBounds },
            translation: channel?.samples?.map(sample => [sample.timeSeconds, [...sample.value]]),
          }
        },
      )
      cases.push(
        compare(`${sample}:model-animation-source`, 'view.model-animation-source', animation, {
          clip: AUTHORED.clip,
          translation: AUTHORED.translation,
        }),
      )
    } finally {
      await session.dispose()
    }
  }
  return cases
}

async function renderCases(): Promise<Case[]> {
  const scene = join(extension, 'node_modules', '@modkit', 'scene', 'dist')
  const { renderUvm } = (await import(pathToFileURL(join(scene, 'uvm', 'render.js')).href)) as {
    renderUvm(
      bytes: Uint8Array,
      request: unknown,
      options: unknown,
    ): Promise<{
      width: number
      height: number
      rgba: Uint8Array
      statistics?: { triangles?: number }
    }>
  }
  const headless = (await import(pathToFileURL(join(scene, 'render', 'headless.js')).href)) as {
    createProvider(selection: { contract: string; major: number }): unknown
  }
  const session = await open((await authoredModelBytes()).mdx)
  let uvm: Uint8Array
  try {
    const exported = await session
      .operations()
      .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
    if (exported.state !== 'ok' || exported.output.kind !== 'bytes')
      throw new Error('UVM export failed')
    uvm = exported.output.value as Uint8Array
  } finally {
    await session.dispose()
  }
  // Looking down on the triangle, which the z-up to y-up frame lays in the XZ plane.
  const viewProjection = [0.8, 0, 0, 0, 0, 0, 0.5, 0, 0, 0.8, 0, 0, -0.4, 0.4, 0.5, 1]
  const frame = await renderUvm(
    uvm,
    {
      schemaVersion: 1,
      viewport: { width: 32, height: 32 },
      camera: { viewProjection },
      rendererId: 'modkit.headless',
      clearColor: [0, 0, 0, 1],
      time: 0,
    },
    {
      contracts: {
        resolve: async (request: { contract: string; major: number }) =>
          headless.createProvider(request),
        resolveUnknown: async () => {
          throw new Error('no foreign service is needed')
        },
      },
      budget,
    },
  )
  let drawn = 0
  for (let index = 0; index + 3 < frame.rgba.length; index += 4)
    if (frame.rgba[index]! + frame.rgba[index + 1]! + frame.rgba[index + 2]! > 0) drawn += 1
  const observed = { triangles: frame.statistics?.triangles, drawn: drawn > 0 }
  return [
    compare(
      'authored.mdx:model-export-uvm:scene-render',
      'model.export-uvm + scene render',
      observed,
      { triangles: 1, drawn: true },
    ),
  ]
}
const MK2_SOURCE = 'references/modkitmk2/extensions/blizzard/warcraft-3/codecs/war3-mdx'
const MK2_FILES = ['codec.manifest.json', 'src/detect.ts', 'src/implementation.ts', 'src/codec.ts']
/** A checkout may rewrite line endings; the digest is of the LF text so every machine agrees. */
const textOf = async (path: string) => (await readFile(path, 'utf8')).replaceAll('\r\n', '\n')

/**
 * The full source feature audit: every capability the MK2 codec source exports, run against the
 * MK3 module that carries it now. The MK2 source is read at its pinned commit; where MK3 keeps the
 * MK2 code (detect.ts verbatim, the replaceable-texture table), the case compares them directly.
 */
async function auditCases(): Promise<Case[]> {
  const mk2 = (file: string) => textOf(join(workspace, MK2_SOURCE, file))
  const detect = (await import(
    pathToFileURL(join(extension, 'dist', 'war3-mdx', 'detect.js')).href
  )) as {
    detectWar3ModelFormat(bytes: Uint8Array, hint?: string): string
  }
  const port = (await import(
    pathToFileURL(join(extension, 'dist', 'war3-mdx', 'render-model.js')).href
  )) as {
    WAR3_REPLACEABLE_TEXTURE_PATHS: Readonly<Record<number, string>>
    war3ReplaceableTexturePath(id: number | undefined, version?: number): string | undefined
    parseWar3Mdx(bytes: Uint8Array): { Geosets: unknown[]; Bones: unknown[]; Sequences: unknown[] }
    parseWar3Mdl(input: Uint8Array): { Geosets: unknown[]; Bones: unknown[]; Sequences: unknown[] }
    generateWar3Mdx(model: unknown): Uint8Array
    generateWar3Mdl(model: unknown): string
    parseWar3ModelToRenderModel(
      bytes: Uint8Array,
      hint?: string,
    ): {
      meshes: unknown[]
      materials: unknown[]
      skeleton?: { bones: unknown[] }
      animations: unknown[]
    }
    createMdxModelParser(): {
      canParse(bytes: Uint8Array): boolean
      parse(bytes: Uint8Array): { meshes: unknown[] }
    }
    createMdlModelParser(): {
      canParse(bytes: Uint8Array): boolean
      parse(bytes: Uint8Array): { meshes: unknown[] }
    }
  }
  const manifest = JSON.parse(await mk2('codec.manifest.json')) as {
    match: { extensions: string[] }
    runtimeVariants: { operations?: string[] }[]
  }
  const contribution = JSON.parse(
    await readFile(join(extension, 'contributions', 'codec-war3-mdx.json'), 'utf8'),
  ) as { spec: { match: { extensions: string[] }; operations: { id: string }[] } }
  const bytes = await authoredModelBytes()
  const counts = (model: { Geosets: unknown[]; Bones: unknown[]; Sequences: unknown[] }) => [
    model.Geosets.length,
    model.Bones.length,
    model.Sequences.length,
  ]
  const mk2Table = Object.fromEntries(
    [...(await mk2('src/implementation.ts')).matchAll(/^\s+(\d+): '([^']+)',$/gmu)].map(match => [
      Number(match[1]),
      match[2]!.replaceAll('\\\\', '\\'),
    ]),
  )
  // The MK2 formula, as src/implementation.ts states it: `ReplaceableTextures\<relative>.<blp|dds>`.
  const mk2Path = (id: number, version: number) =>
    mk2Table[id] === undefined
      ? undefined
      : `ReplaceableTextures\\${mk2Table[id]}.${version > 800 ? 'dds' : 'blp'}`
  const ids = [0, ...Object.keys(mk2Table).map(Number), 9999]
  const mdxRender = port.parseWar3ModelToRenderModel(bytes.mdx, 'model.mdx')
  const mdlRender = port.parseWar3ModelToRenderModel(bytes.mdl, 'model.mdl')
  const renderCounts = (model: typeof mdxRender) => [
    model.meshes.length,
    model.materials.length,
    model.skeleton?.bones.length ?? 0,
    model.animations.length,
  ]
  const opened: string[] = []
  for (const model of [bytes.mdx, bytes.mdl]) {
    const session = await open(model)
    opened.push(String(((await inspect(session)) as Record<string, unknown>)['encoding']))
    await session.dispose()
  }
  return [
    compare(
      'mk2-source:src/detect.ts',
      'src/war3-mdx/detect.ts',
      [
        sha256(await textOf(join(extension, 'src', 'war3-mdx', 'detect.ts'))),
        detect.detectWar3ModelFormat(bytes.mdx),
        detect.detectWar3ModelFormat(bytes.mdl),
      ],
      [sha256(await mk2('src/detect.ts')), 'mdx', 'mdl'],
    ),
    compare(
      'mk2-source:WAR3_REPLACEABLE_TEXTURE_PATHS',
      'src/war3-mdx/render-model.ts',
      port.WAR3_REPLACEABLE_TEXTURE_PATHS,
      mk2Table,
    ),
    compare(
      'mk2-source:war3ReplaceableTexturePath',
      'src/war3-mdx/render-model.ts',
      ids.flatMap(id =>
        [800, 1000].map(version => port.war3ReplaceableTexturePath(id, version) ?? null),
      ),
      ids.flatMap(id => [800, 1000].map(version => mk2Path(id, version) ?? null)),
    ),
    compare(
      'mk2-source:parseWar3Mdx+generateWar3Mdx',
      'src/lib/war3-model (vendored) via render-model.ts',
      counts(port.parseWar3Mdx(port.generateWar3Mdx(port.parseWar3Mdx(bytes.mdx)))),
      [1, 1, 1],
    ),
    compare(
      'mk2-source:parseWar3Mdl+generateWar3Mdl',
      'src/lib/war3-model (vendored) via render-model.ts',
      counts(
        port.parseWar3Mdl(
          new TextEncoder().encode(port.generateWar3Mdl(port.parseWar3Mdl(bytes.mdl))),
        ),
      ),
      [1, 1, 1],
    ),
    compare(
      'mk2-source:parseWar3ModelToRenderModel',
      'src/war3-mdx/render-model.ts',
      [renderCounts(mdxRender), renderCounts(mdlRender)],
      [
        [1, 1, 1, 1],
        [1, 1, 1, 1],
      ],
    ),
    compare(
      'mk2-source:MdxModelParser+MdlModelParser',
      'src/war3-mdx/render-model.ts',
      [
        port.createMdxModelParser().canParse(bytes.mdx),
        port.createMdlModelParser().canParse(bytes.mdl),
        port.createMdxModelParser().parse(bytes.mdx).meshes.length,
        port.createMdlModelParser().parse(bytes.mdl).meshes.length,
      ],
      [true, true, 1, 1],
    ),
    compare('mk2-source:src/codec.ts', 'src/war3-mdx/codec.ts (view.inspect)', opened, [
      'mdx',
      'mdl',
    ]),
    compare(
      'mk2-manifest:match.extensions',
      'spec.match.extensions',
      contribution.spec.match.extensions.map(extensionName => `.${extensionName}`).sort(),
      [...manifest.match.extensions].sort(),
    ),
    compare(
      'mk2-manifest:operations',
      'view.inspect, model.export-uvm',
      [
        [...new Set(manifest.runtimeVariants.flatMap(variant => variant.operations ?? []))].sort(),
        ['view.inspect', 'model.export-uvm'].every(id =>
          contribution.spec.operations.some(operation => operation.id === id),
        ),
      ],
      [['model.read', 'model.render'], true],
    ),
  ]
}

interface Row {
  readonly requirement: string
  readonly kind: 'operation' | 'audit'
  /** The MK2 operation as the ledger labels it; an audit row has none. */
  readonly legacyOperation?: string
  readonly operation: string
  readonly handlerId: string
  readonly oracle: string
  readonly cases: () => Promise<Case[]>
}

const ROWS: Readonly<Record<string, Row>> = {
  'model-read': {
    requirement: 'legacy/codec-manifest/modkit/war3-mdx/operation/model.read',
    kind: 'operation',
    legacyOperation: 'model.read',
    operation: 'view.inspect',
    handlerId: 'inspect',
    oracle: 'the geometry, texture, bone and sequence written into the authored model',
    cases: readCases,
  },
  'model-render': {
    requirement: 'legacy/codec-manifest/modkit/war3-mdx/operation/model.render',
    kind: 'operation',
    legacyOperation: 'model.render',
    operation: 'model.export-uvm',
    handlerId: 'model-export-uvm',
    oracle: 'the authored triangle drawn by the common scene renderer from the codec UVM',
    cases: renderCases,
  },
  audit: {
    requirement: 'legacy/codec-manifest/modkit/war3-mdx/audit',
    kind: 'audit',
    operation: 'source-feature-audit',
    handlerId: 'source-feature-audit',
    oracle: `every export of the MK2 source (${MK2_SOURCE} at ${MK2_COMMIT}) and its manifest, against the MK3 module that carries it`,
    cases: auditCases,
  },
}

describe('K1 receipts of war3-mdx', () => {
  it.each(Object.entries(ROWS))('%s matches the authored model', async (name, row) => {
    const cases = await row.cases()
    const identical = cases.filter(item => item.verdict === 'identical')
    const expected = {
      schemaVersion: 1,
      codec: 'war3-mdx',
      corpusKind: 'synthetic',
      verdict: identical.length === cases.length ? 'pass' : 'fail',
      tests: {
        passed: identical.length,
        failed: cases.length - identical.length,
        skipped: 0,
      },
      inputs: {
        operation: row.operation,
        oracle: row.oracle,
        suite: SUITE,
        samples: [
          {
            name: 'authored.mdx / authored.mdl',
            builder:
              'modkit-extensions-blizzard/blizzard-warcraft-3/test/war3-harness.ts#authoredModelBytes',
            fixture: 'modkit-extensions-blizzard/test/behavior/fixtures/minimal.mdx',
            sha256: sha256(await readFile(fixturePath)),
          },
          ...(row.kind === 'audit'
            ? await Promise.all(
                MK2_FILES.map(async file => ({
                  name: `mk2 ${file}`,
                  fixture: `${MK2_SOURCE}/${file}`,
                  sha256LF: sha256(await textOf(join(workspace, MK2_SOURCE, file))),
                })),
              )
            : []),
        ],
      },
      cases,
      proofs: [
        {
          requirement: row.requirement,
          kind: row.kind,
          ...(row.legacyOperation === undefined ? {} : { legacyOperation: row.legacyOperation }),
          adapterOperation: row.operation,
          targetOperation: row.operation,
          handlerId: row.handlerId,
          contribution: CONTRIBUTION,
          executed: true,
          caseIds: identical.map(item => item.id),
        },
      ],
    }
    expect(cases.filter(item => item.verdict === 'different')).toEqual([])
    const file = join(receipts, `war3-mdx.${name}.json`)
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
