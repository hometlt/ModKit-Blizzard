import { describe, expect, it } from 'vitest'
import type { DataWorkspaceListing } from '@modkit/sdk/data'
import { createProvider } from '../services/catalog/provider.js'

const GAME_ID = 'blizzard/starcraft-2'

function root(rootId: string, dependencies: readonly string[] = []) {
  return {
    rootId,
    sourceId: `source-${rootId}`,
    sourcePath: `${rootId}.SC2Mod`,
    displayName: rootId,
    kind: 'mod',
    dependencies: dependencies.map(targetRootId => ({
      targetRootId,
      ref: targetRootId,
      required: true,
      provenance: 'declared',
    })),
  }
}

function workspace(workspaceId: string, roots: readonly ReturnType<typeof root>[]) {
  const active = roots.at(-1)!
  return {
    schemaVersion: 1,
    workspaceId,
    gameId: GAME_ID,
    activeRootId: active.rootId,
    sources: roots.map(item => ({
      sourceId: item.sourceId,
      kind: 'directory',
      location: item.sourcePath,
    })),
    loadOrder: roots,
    dependencyOrder: roots.slice(0, -1),
    logicalRoots: [...roots].reverse(),
    diagnostics: [],
    complete: true,
  }
}

const catalog = (...entities: string[]) =>
  ['<?xml version="1.0" encoding="utf-8"?>', '<Catalog>', ...entities, '</Catalog>', ''].join('\n')

const declaration = (fields: string) => `    <CUnit id="Marine">\n${fields}\n    </CUnit>`

function document(rootId: string, text: string, revision = `revision:${rootId}`) {
  return {
    rootId,
    path: `${rootId.toLowerCase()}.sc2mod/base.sc2data/gamedata/unitdata.xml`,
    text,
    revision,
  }
}

async function analyzedContext(
  workspaceId: string,
  roots: readonly ReturnType<typeof root>[],
  documents: readonly ReturnType<typeof document>[],
  maxRequirements = 1_000,
  listings?: readonly DataWorkspaceListing[],
) {
  const lease = createProvider({ contract: 'common.data/resolved-workspace', major: 1 })
  const service = lease.value as any
  const dataPlan = await service.plan({
    workspace: workspace(workspaceId, roots),
    locales: ['enUS'],
    maxRequirements,
    ...(listings === undefined ? {} : { listings }),
  })
  const supplied = new Set(documents.map(item => `${item.rootId}\0${item.path.toLowerCase()}`))
  const unresolvedRequirementIds = dataPlan.requirements
    .filter(
      (item: { rootId: string; path: string }) =>
        !supplied.has(`${item.rootId}\0${item.path.toLowerCase()}`),
    )
    .map((item: { requirementId: string }) => item.requirementId)
  const snapshot = await service.analyze({
    workspaceId,
    gameId: GAME_ID,
    documents,
    localizationDocuments: [],
    locales: ['enUS'],
    localizationKeys: [],
    queries: [{ namespace: 'Unit', entityId: 'Marine' }],
    maxDocuments: 16_384,
    maxTextBytes: 32_000_000,
    maxEntities: 100_000,
    maxDepth: 64,
    plannedDocumentCount: dataPlan.requirements.length,
    unresolvedRequirementIds,
  })
  return { lease, service, snapshot, dataPlan }
}

const request = (snapshotId: string, selectedRootId: string, value: string) => ({
  snapshotId,
  selectedRootId,
  writableRootIds: [selectedRootId],
  subject: { namespace: 'Unit', entityId: 'Marine' },
  fieldPath: ['LifeMax'],
  intent: { kind: 'set-field', value },
})

describe('SC2 resolved-data edit target', () => {
  it('creates a canonical catalog after a complete empty active-root listing without adding reads', async () => {
    const context = await analyzedContext(
      'empty-listed-mod',
      [root('A'), root('D', ['A'])],
      [document('A', catalog(declaration('        <LifeMax value="45"/>')))],
      1_000,
      [
        { rootId: 'A', prefix: 'base.sc2data/gamedata', paths: ['Base.SC2Data/GameData/UnitData.xml'], complete: true },
        { rootId: 'D', prefix: 'base.sc2data/gamedata', paths: [], complete: true },
      ],
    )
    try {
      expect(context.dataPlan.requirements.filter((item: { rootId: string }) => item.rootId === 'D').map((item: { path: string }) => item.path)).toEqual([
        'd.sc2mod/base.sc2data/editordata/editorcategories.xml',
        'd.sc2mod/enus.sc2data/localizeddata/gamestrings.txt',
      ])
      expect(context.dataPlan.creationCandidates).toContainEqual({ rootId: 'D', path: 'd.sc2mod/base.sc2data/gamedata/unitdata.xml' })
      expect(context.dataPlan.creationCandidates).toHaveLength(109)
      expect(context.dataPlan.creationCandidates.every((item: { rootId: string }) => item.rootId === 'D')).toBe(true)
      const edit = request(context.snapshot.snapshotId, 'D', '70')
      await expect(context.service.planEdit({ ...edit, writableRootIds: [] })).rejects.toThrow(/not open for writing/u)
      const plan = await context.service.planEdit(edit)
      expect(plan.target).toMatchObject({
        action: 'declare-local-entity',
        selectionReason: 'canonical-namespace-document',
        target: { rootId: 'D', path: 'd.sc2mod/Base.SC2Data/GameData/UnitData.xml', mode: 'create' },
        effectiveFieldSource: { rootId: 'A' },
      })
      expect(plan.target.guards.map((item: { rootId: string }) => item.rootId)).toEqual(['A'])
      expect(plan.replacementText).toContain('<CUnit id="Marine">')
      expect(plan.replacementText).toContain('<LifeMax value="70"/>')
      expect(plan.replacementText).not.toContain('value="45"')
      expect(plan.expectedEffectiveValue).toBe(70)
    } finally {
      await context.lease.release()
    }
  })
  it('writes an inherited field into the last declaration in active C and re-resolves the preview', async () => {
    const roots = [root('A'), root('B', ['A']), root('C', ['B'])]
    const documents = [
      document('A', catalog(declaration('        <LifeMax value="45"/>'))),
      document('B', catalog(declaration('        <LifeMax value="50"/>'))),
      document('C', catalog(declaration('        <Mover value="Ground"/>'))),
    ]
    const context = await analyzedContext('context-c', roots, documents)
    try {
      const target = await context.service.resolveEditTarget(
        request(context.snapshot.snapshotId, 'C', '60'),
      )
      expect(target).toMatchObject({
        state: 'resolved',
        selectedRootId: 'C',
        action: 'create-local-field',
        selectionReason: 'last-local-declaration',
        target: { rootId: 'C', mode: 'replace', revision: 'revision:C' },
        effectiveFieldSource: { rootId: 'B' },
      })
      expect(target.guards.map((item: { rootId: string }) => item.rootId)).toEqual(['A', 'B', 'C'])

      const plan = await context.service.planEdit(request(context.snapshot.snapshotId, 'C', '60'))
      expect(plan.replacementText).toContain('<LifeMax value="60"/>')
      expect(plan.replacementText).toContain('<Mover value="Ground"/>')
      expect(plan.expectedEffectiveValue).toBe(60)
      expect(plan.previewSnapshotId).not.toBe(context.snapshot.snapshotId)
      await expect(
        context.service.planEdit({
          ...request(context.snapshot.snapshotId, 'C', 'unused'),
          intent: { kind: 'remove-local-override' },
        }),
      ).rejects.toThrow(/not declared in the selected mod/u)
    } finally {
      await context.lease.release()
    }
  })

  it('requires a separately resolved B context and never imports C into B', async () => {
    const context = await analyzedContext(
      'context-b',
      [root('A'), root('B', ['A'])],
      [
        document('A', catalog(declaration('        <LifeMax value="45"/>'))),
        document('B', catalog(declaration('        <LifeMax value="50"/>'))),
      ],
    )
    try {
      const plan = await context.service.planEdit(request(context.snapshot.snapshotId, 'B', '55'))
      expect(plan.target).toMatchObject({
        selectedRootId: 'B',
        action: 'update-local-field',
        effectiveFieldSource: { rootId: 'B' },
      })
      expect(plan.expectedEffectiveValue).toBe(55)
      const removed = await context.service.planEdit({
        ...request(context.snapshot.snapshotId, 'B', 'unused'),
        intent: { kind: 'remove-local-override' },
      })
      expect(removed.intent).toEqual({ kind: 'remove-local-override' })
      expect(removed.replacementText).not.toContain('<LifeMax')
      expect(removed.expectedEffectiveValue).toBe(45)
      await expect(
        context.service.resolveEditTarget(request(context.snapshot.snapshotId, 'A', '1')),
      ).rejects.toThrow(/not the active context B/u)
    } finally {
      await context.lease.release()
    }
  })

  it('declares the inherited entity minimally in active D and refuses a read-only context', async () => {
    const context = await analyzedContext(
      'context-d',
      [root('A'), root('D', ['A'])],
      [
        document('A', catalog(declaration('        <LifeMax value="45"/>'))),
        document('D', catalog()),
      ],
    )
    try {
      await expect(
        context.service.resolveEditTarget({
          ...request(context.snapshot.snapshotId, 'D', '70'),
          writableRootIds: [],
        }),
      ).rejects.toThrow(/not open for writing/u)

      const plan = await context.service.planEdit(request(context.snapshot.snapshotId, 'D', '70'))
      expect(plan.target).toMatchObject({
        action: 'declare-local-entity',
        selectionReason: 'canonical-namespace-document',
        target: { rootId: 'D', mode: 'replace' },
        effectiveFieldSource: { rootId: 'A' },
      })
      expect(plan.replacementText).toContain('<CUnit id="Marine">')
      expect(plan.replacementText).toContain('<LifeMax value="70"/>')
      expect(plan.replacementText).not.toContain('value="45"')
      expect(plan.expectedEffectiveValue).toBe(70)
    } finally {
      await context.lease.release()
    }
  })

  it('refuses an ambiguous destination until one is named, and refuses stale or conflicting targets', async () => {
    /*
     * A budget of A's priority catalogs plus two for D plans only D's sc2data.xml and
     * abildata.xml: the active mod has no canonical Unit catalog, so no destination can be chosen
     * for it. The priority list length comes from the provider's own budget diagnostic.
     */
    const roots = [root('A'), root('D', ['A'])]
    const probe = createProvider({ contract: 'common.data/resolved-workspace', major: 1 })
    const budget = await (probe.value as any).plan({
      workspace: workspace('probe', roots),
      locales: ['enUS'],
      maxRequirements: 1,
    })
    await probe.release()
    const priority = /and (\d+) Product-GA/u.exec(JSON.stringify(budget.diagnostics))
    if (priority === null) throw new Error('the provider no longer reports its priority budget')
    const planned = 'd.sc2mod/base.sc2data/gamedata/abildata.xml'
    const context = await analyzedContext(
      'context-d-ambiguous',
      roots,
      [document('A', catalog(declaration('        <LifeMax value="45"/>')))],
      // A: its priority catalogs, the sc2data.xml bootstrap and EditorCategories.xml; D: two.
      Number(priority[1]) + 2 + 2,
    )
    try {
      const ambiguous = request(context.snapshot.snapshotId, 'D', '70')
      const target = await context.service.resolveEditTarget(ambiguous)
      expect(target).toMatchObject({
        state: 'selection-required',
        selectedRootId: 'D',
        reason: expect.stringMatching(/no canonical Unit catalog/u),
      })
      expect(target.candidates.map((item: { path: string }) => item.path)).toEqual([
        'd.sc2mod/base.sc2data/gamedata/sc2data.xml',
        planned,
      ])
      // No bytes are planned while the destination is not chosen.
      const refused = await context.service.planEdit(ambiguous)
      expect(refused.state).toBe('selection-required')
      expect(refused).not.toHaveProperty('replacementText')

      // Naming a candidate is an explicit declaration in the active mod, with provenance.
      const plan = await context.service.planEdit({
        ...ambiguous,
        targetDocument: { rootId: 'D', path: planned },
      })
      expect(plan.target).toMatchObject({
        selectedRootId: 'D',
        action: 'declare-local-entity',
        selectionReason: 'explicit-local-document',
        // A created file takes the editor's spelling; the planned id stays case-folded.
        target: { rootId: 'D', path: 'd.sc2mod/Base.SC2Data/GameData/AbilData.xml', mode: 'create' },
        effectiveFieldSource: { rootId: 'A' },
      })
      expect(plan.target.guards.map((item: { rootId: string }) => item.rootId)).toEqual(['A'])
      expect(plan.replacementText).toContain('<CUnit id="Marine">')
      expect(plan.replacementText).toContain('<LifeMax value="70"/>')
      expect(plan.replacementText).not.toContain('value="45"')
      expect(plan.expectedEffectiveValue).toBe(70)

      await expect(
        context.service.planEdit({ ...ambiguous, targetDocument: { rootId: 'A', path: 'x.xml' } }),
      ).rejects.toThrow(/must equal selectedRootId/u)
      await expect(
        context.service.planEdit({
          ...ambiguous,
          targetDocument: { rootId: 'D', path: 'd.sc2mod/base.sc2data/gamedata/unitdata.xml' },
        }),
      ).rejects.toThrow(/not an existing or planned catalog document/u)
      await expect(
        context.service.planEdit({ ...ambiguous, snapshotId: `${context.snapshot.snapshotId}-old` }),
      ).rejects.toThrow()
    } finally {
      await context.lease.release()
    }

    // Once the active mod declares the entity, an ordinary edit may only go to that declaration.
    const declared = await analyzedContext(
      'context-c-declared',
      [root('A'), root('C', ['A'])],
      [
        document('A', catalog(declaration('        <LifeMax value="45"/>'))),
        document('C', catalog(declaration('        <Mover value="Ground"/>'))),
      ],
    )
    try {
      await expect(
        declared.service.planEdit({
          ...request(declared.snapshot.snapshotId, 'C', '60'),
          targetDocument: { rootId: 'C', path: 'c.sc2mod/base.sc2data/gamedata/abildata.xml' },
        }),
      ).rejects.toThrow(/must target the last declaration/u)
    } finally {
      await declared.lease.release()
    }
  })

  it('removes an inherited indexed entry by writing a local SC2 tombstone', async () => {
    const context = await analyzedContext(
      'context-indexed-remove',
      [root('A'), root('D', ['A'])],
      [
        document(
          'A',
          catalog(declaration('        <CostResource index="Minerals" value="50"/>')),
        ),
        document('D', catalog()),
      ],
    )
    try {
      const plan = await context.service.planEdit({
        ...request(context.snapshot.snapshotId, 'D', 'unused'),
        fieldPath: ['CostResource'],
        intent: { kind: 'remove-indexed-entry', index: 'Minerals' },
      })
      expect(plan.target).toMatchObject({
        action: 'declare-local-entity',
        target: { rootId: 'D', mode: 'replace' },
        effectiveFieldSource: { rootId: 'A' },
      })
      expect(plan.intent).toEqual({ kind: 'remove-indexed-entry', index: 'Minerals' })
      expect(plan.replacementText).toContain('<CostResource index="Minerals" removed="1"/>')
      expect(plan.replacementText).not.toContain('value="50"')
      expect(plan.expectedEffectiveValue ?? []).toEqual([])

      const restored = await context.service.planEdit({
        ...request(context.snapshot.snapshotId, 'D', 'unused'),
        fieldPath: ['CostResource'],
        intent: { kind: 'set-indexed-entry', index: 'Minerals', value: 75 },
      })
      expect(restored.intent).toEqual({
        kind: 'set-indexed-entry',
        index: 'Minerals',
        value: 75,
      })
      expect(restored.replacementText).toContain(
        '<CostResource index="Minerals" value="75"/>',
      )
      expect(restored.replacementText).not.toContain('value="50"')

      await expect(
        context.service.planEdit({
          ...request(context.snapshot.snapshotId, 'D', 'unused'),
          intent: { kind: 'remove-indexed-entry', index: 0 },
        }),
      ).rejects.toThrow(/indexed schema field/u)
      await expect(
        context.service.planEdit({
          ...request(context.snapshot.snapshotId, 'D', 'unused'),
          fieldPath: ['CostResource'],
          intent: { kind: 'remove-indexed-entry', index: -1 },
        }),
      ).rejects.toThrow(/valid named or non-negative numeric index/u)
    } finally {
      await context.lease.release()
    }
  })

  it('declares a structured indexed entry in the active mod', async () => {
    const context = await analyzedContext(
      'context-structured-indexed-entry',
      [root('A'), root('D', ['A'])],
      [
        document(
          'A',
          catalog('    <CAbilAttack id="Attack"><CmdButtonArray index="Execute" DefaultButtonFace="Old"/></CAbilAttack>'),
        ),
        document('D', catalog()),
      ],
    )
    try {
      const plan = await context.service.planEdit({
        snapshotId: context.snapshot.snapshotId,
        selectedRootId: 'D',
        writableRootIds: ['D'],
        subject: { namespace: 'Abil', entityId: 'Attack' },
        fieldPath: ['CmdButtonArray'],
        intent: {
          kind: 'set-indexed-entry',
          index: 'Execute',
          value: { DefaultButtonFace: 'Attack', State: 'Enabled' },
        },
      })
      expect(plan.target).toMatchObject({
        action: 'declare-local-entity',
        target: { rootId: 'D', mode: 'create' },
        effectiveFieldSource: { rootId: 'A' },
      })
      expect(plan.replacementText).toContain('<CAbilAttack id="Attack">')
      expect(plan.replacementText).toContain(
        '<CmdButtonArray index="Execute" DefaultButtonFace="Attack" State="Enabled"/>',
      )
      expect(plan.replacementText).not.toContain('DefaultButtonFace="Old"')
      expect(plan.expectedEffectiveValue).toEqual([
        {
          index: 'Execute',
          value: { DefaultButtonFace: 'Attack', State: 'Enabled' },
        },
      ])
    } finally {
      await context.lease.release()
    }
  })
})
