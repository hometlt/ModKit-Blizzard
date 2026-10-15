import { describe, expect, it } from 'vitest'
import { createProvider } from '../../../shared/editing/providers/authored-text/runtime.js'

const context = {
  budgets: {
    maxInputBytes: 1_000_000n,
    maxDepth: 32,
    maxNodes: 10_000,
    maxScalarBytes: 1_000_000,
    maxDiagnostics: 100,
  },
}

const revision = (id: string, namespace = false) => ({
  bindings: { [id]: `provider-token:${id}` },
  ...(namespace ? { namespaceRevision: `provider-token:${id}` } : {}),
  compositionFingerprint: id,
})

const target = (id: string, namespace = false) => ({
  targetId: id,
  subjectUri: `file:///${id}`,
  ownerSource: { id, uri: `file:///${id}` },
  semanticPath: [],
  expectedRevision: revision(id, namespace),
})

const intent = {
  kind: 'sc2-authored-text-save-v1',
  formatId: 'sc2-data',
  sourceComplete: true,
  unknownDataPolicy: 'preserve-from-complete-snapshot',
}

async function writer() {
  return createProvider(
    {
      contract: 'common.edit/writer',
      major: 1,
      offerId: 'sc2-data-source',
    },
    context,
  ).value as any
}

describe('SC2 resolved data writer handoff', () => {
  it('retains dependency targets as guards while replacing only the selected active file', async () => {
    const a = target('A.xml')
    const c = target('C.xml')
    const change = {
      targets: [a, c],
      edits: [
        {
          operation: 'replace',
          targetId: c.targetId,
          source: c.ownerSource,
          payload: { kind: 'text', text: '<Catalog><CUnit id="Marine"/></Catalog>' },
        },
      ],
      semanticIntent: intent,
      provenance: { actor: 'user' },
    }
    const service = await writer()
    expect(await service.validate(change)).toEqual({ valid: true, diagnostics: [] })
    const plan = await service.plan(change)
    expect(plan.targets).toEqual([a, c])
    expect(plan.edits).toHaveLength(1)
    expect(plan.edits[0].targetId).toBe(c.targetId)
  })

  it('admits a confined GameData create only inside a revision-pinned namespace', async () => {
    const root = target('C.SC2Mod', true)
    const service = await writer()
    const change = {
      targets: [target('A.xml'), root],
      edits: [
        {
          operation: 'create',
          targetId: root.targetId,
          source: root.ownerSource,
          newPath: 'Base.SC2Data/GameData/UnitData.xml',
          payload: { kind: 'text', text: '<Catalog><CUnit id="Marine"/></Catalog>' },
        },
      ],
      semanticIntent: intent,
      provenance: { actor: 'user' },
    }
    expect(await service.validate(change)).toEqual({ valid: true, diagnostics: [] })
    expect(
      await service.validate({
        ...change,
        edits: [{ ...change.edits[0], newPath: '../B.SC2Mod/UnitData.xml' }],
      }),
    ).toMatchObject({ valid: false })
    expect(
      await service.validate({
        ...change,
        targets: [target('A.xml'), target('C.SC2Mod')],
      }),
    ).toMatchObject({ valid: false })
  })
})
