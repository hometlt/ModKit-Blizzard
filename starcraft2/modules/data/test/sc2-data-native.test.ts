import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  A1_SPEC_SCHEMA_ENTRIES,
  createSpecSchemaRegistry,
  validateContributionManifest,
} from '@modkit/sdk'
import { createCodec, operations, SC2_DATA_OPERATION_MAP } from '../../../dist/modules/data/codecs/sc2data/src/codec.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const xml = `<?xml version="1.0" encoding="utf-8"?>
<Catalog>
    <CUnit id="BaseUnit">
        <LifeMax value="40"/>
    </CUnit>
    <CUnit id="Marine" parent="BaseUnit">
        <LifeMax value="45"/>
    </CUnit>
    <CWeapon id="GaussRifle"/>
</Catalog>
`

const budget = {
  maxInputBytes: 4_000_000n,
  maxDepth: 64,
  maxNodes: 100_000,
  maxScalarBytes: 4_000_000,
  maxDiagnostics: 1_000,
}

function dataInput(bytes: Uint8Array, uri = 'memory://Mods/Test.SC2Mod/GameData/UnitData.xml') {
  const revision = 'content-hash.sha256:sc2-data-native-fixture'
  const ref = { id: uri, uri }
  const source = {
    kind: 'bytes' as const,
    ref,
    revision,
    size: BigInt(bytes.length),
    async read(offset: bigint, length: number, signal?: AbortSignal) {
      signal?.throwIfAborted()
      return bytes.slice(Number(offset), Number(offset) + length)
    },
    async *stream() {
      yield bytes
    },
  }
  return {
    originKind: 'single' as const,
    bindings: [
      {
        sourceKind: 'candidate' as const,
        bindingId: 'content',
        role: 'content',
        ownership: 'owned' as const,
        source: ref,
        revision,
      },
    ],
    primaryBindingId: 'content',
    revisions: {
      topology: 'single' as const,
      revision,
      bindings: [{ bindingId: 'content', revision }],
      compositionFingerprint: 'sc2-data-native',
    },
    bindingsFor: () => [],
    async openBinding() {
      return { value: source, release: async () => {} }
    },
  }
}

async function opened(source = xml) {
  return createCodec().open(dataInput(encoder.encode(source)) as never, 'full', budget)
}

describe('SC2 GameData native M5 codec', () => {
  it('publishes valid codec and subject-kind manifests with the executable operation table', async () => {
    const contributionDirectory = resolve(import.meta.dirname, '../codecs/sc2data')
    const manifest = JSON.parse(
      readFileSync(resolve(contributionDirectory, 'codec.json'), 'utf8'),
    )
    expect(manifest.spec.operations).toEqual(
      expect.arrayContaining(operations.map(item => expect.objectContaining(item))),
    )
    for (const path of [
      resolve(contributionDirectory, 'codec.json'),
      resolve(import.meta.dirname, '../../../contributions/subject-kind-sc2-data.json'),
    ]) {
      const value = JSON.parse(readFileSync(path, 'utf8'))
      const validation = await validateContributionManifest(
        value,
        createSpecSchemaRegistry(A1_SPEC_SCHEMA_ENTRIES),
      )
      expect(validation.specState, JSON.stringify(validation.diagnostics)).toBe('validated')
      expect(validation.diagnostics.filter(item => item.severity === 'error')).toEqual([])
    }
  })

  it('publishes a complete, versioned map for the legacy codec operations', () => {
    expect(Object.keys(SC2_DATA_OPERATION_MAP)).toEqual([
      'view.inspect',
      'asset.search',
      'sc2-data.resolve-inheritance',
      'sc2-data.references',
      'asset.validate',
      'asset.compare',
      'edit.content',
      'export.convert',
      'sc2-data.entity-cards',
      'sc2-data.resolved-view',
    ])
    expect(operations).toHaveLength(10)
    expect(operations.map(operation => operation.handlerId)).toContain('resolve-inheritance')
  })

  it('projects catalog metadata, text, table, tree and per-document operation state', async () => {
    const session = await opened()
    try {
      const descriptor = await session.descriptor()
      expect(descriptor.constraints.readOnly).toBe(false)
      expect(descriptor.dataSources.map(source => source.contract)).toEqual(
        expect.arrayContaining([
          'common.view/text-data-source',
          'common.view/byte-range-source',
          'common.view/table-data-source',
          'common.view/tree-data-source',
        ]),
      )
      expect(descriptor.metadata.map(group => group.id)).toEqual([
        'identity',
        'catalog',
        'resolution',
      ])
      expect(descriptor.operations.find(operation => operation.handlerId === 'compare')).toMatchObject(
        { state: 'disabled' },
      )

      const table = await session.dataSource('common.view/table-data-source', 1)
      try {
        expect(await (table.value as any).shape()).toMatchObject({ rows: 3, columns: 5 })
        expect(await (table.value as any).rows({ kind: 'range', from: 0, count: 10 })).toEqual(
          expect.objectContaining({
            items: expect.arrayContaining([
              expect.objectContaining({ cells: expect.arrayContaining(['Unit', 'Marine']) }),
            ]),
          }),
        )
      } finally {
        await table.release()
      }
    } finally {
      await session.dispose()
    }
  })

  it('invokes inspect, query, inheritance, references, validation and byte-exact export handlers', async () => {
    const session = await opened()
    try {
      expect(await session.operations().invoke('inspect', {})).toMatchObject({
        state: 'ok',
        output: { kind: 'json', value: expect.any(Array) },
      })
      expect(await session.operations().invoke('search', { namespace: 'Unit', id: 'mar' })).toMatchObject({
        state: 'ok',
        output: { kind: 'json', value: [expect.objectContaining({ id: 'Marine' })] },
      })
      expect(
        await session.operations().invoke('resolve-inheritance', {
          namespace: 'Unit',
          id: 'Marine',
        }),
      ).toMatchObject({
        state: 'ok',
        output: {
          kind: 'json',
          value: expect.objectContaining({ chain: ['BaseUnit', 'Marine'], partial: false }),
        },
      })
      expect(
        await session.operations().invoke('references', {
          namespace: 'Unit',
          id: 'BaseUnit',
        }),
      ).toMatchObject({
        state: 'ok',
        output: { kind: 'json', value: expect.arrayContaining([expect.objectContaining({ kind: 'parent' })]) },
      })
      expect(await session.operations().invoke('validate', {})).toMatchObject({
        state: 'ok',
        output: { kind: 'json' },
      })

      const exported = await session.operations().invoke('export-catalog', {
        format: 'json',
        mode: 'raw',
      })
      expect(exported.state).toBe('ok')
      if (exported.state !== 'ok' || exported.output.kind !== 'bytes') return
      expect(JSON.parse(decoder.decode(exported.output.value))).toMatchObject({
        Unit: { Marine: expect.any(Object) },
        Weapon: { GaussRifle: expect.any(Object) },
      })
    } finally {
      await session.dispose()
    }
  })

  it('builds an entity rename as a native semantic MK3 edit plan over the selected source', async () => {
    const session = await opened()
    try {
      const result = await session.operations().invoke('rename-entity', {
        renames: [{ namespace: 'Unit', oldId: 'Marine', newId: 'MarineElite' }],
      })
      expect(result.state).toBe('ok')
      if (result.state !== 'ok' || result.output.kind !== 'edit-plan') return
      expect(result.output.plan.fidelity).toMatchObject({
        roundTrip: 'semantic',
        preservesUnknownData: false,
      })
      expect(result.output.plan.edits).toHaveLength(1)
      const edit = result.output.plan.edits[0]!
      expect(edit.operation).toBe('replace')
      expect(edit.payload.kind).toBe('inline')
      if (edit.payload.kind === 'inline') {
        expect(decoder.decode(edit.payload.bytes)).toContain('id="MarineElite"')
      }
    } finally {
      await session.dispose()
    }
  })

  it('returns a committable source-identical plan when an entity rename is a no-op', async () => {
    const session = await opened()
    try {
      const result = await session.operations().invoke('rename-entity', {
        renames: [{ namespace: 'Unit', oldId: 'Marine', newId: 'Marine' }],
      })
      expect(result.state).toBe('ok')
      if (result.state !== 'ok' || result.output.kind !== 'edit-plan') return
      expect(result.output.plan.edits).toHaveLength(1)
      expect(result.output.plan.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'blizzard/sc2-data-rename-no-op',
            severity: 'information',
          }),
        ]),
      )
      const edit = result.output.plan.edits[0]!
      expect(edit.payload.kind).toBe('inline')
      if (edit.payload.kind === 'inline') expect(decoder.decode(edit.payload.bytes)).toBe(xml)
    } finally {
      await session.dispose()
    }
  })
})
