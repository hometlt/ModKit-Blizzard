import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { canonicalJsonStringify } from '@modkit/core'
import {
  createCommitCoordinator,
  createGrantSnapshot,
  createHostServiceResolver,
  analyzeResolvedDataWorkspace,
  createResolvedDataSubjectSelectorLease,
} from '@modkit/host'
import {
  createFileEditingBackend,
  createModkit,
  openDirectoryArtifactSource,
  openFileArtifactSource,
} from '@modkit/host/node'
import { revisionId } from '@modkit/sdk'
import { describe, expect, it } from 'vitest'
import { createProvider as createAuthoredTextWriter } from '../../../shared/editing/providers/authored-text/runtime.js'

const extension = resolve(import.meta.dirname, '..', '..', '..')
const budget = {
  maxInputBytes: 4_000_000n,
  maxDepth: 64,
  maxNodes: 100_000,
  maxScalarBytes: 4_000_000,
  maxDiagnostics: 1_000,
}

const xml = (life: number, mover?: string) => `<?xml version="1.0" encoding="utf-8"?>
<Catalog>
  <CUnit id="Marine">${mover === undefined ? '' : `<Mover value="${mover}"/>`}<LifeMax value="${life}"/></CUnit>
</Catalog>
`

const contextXml = (life = 50) => `<?xml version="1.0" encoding="utf-8"?>
<Catalog>
  <CUnit id="Marine"><WeaponArray index="0" Link="GaussRifle"/><Mover value="Ground"/><LifeMax value="${life}"/></CUnit>
  <CUnit id="Marauder"><WeaponArray index="0" Link="GaussRifle"/></CUnit>
  <CWeaponLegacy id="GaussRifle"><DisplayEffect value="GaussDamage"/></CWeaponLegacy>
</Catalog>
`

const abilityXml = (buttonFace = 'Old', state = 'Available') =>
  `<?xml version="1.0" encoding="utf-8"?>
<Catalog>
  <CAbilAttack id="Attack"><CmdButtonArray index="Execute" DefaultButtonFace="${buttonFace}" State="${state}"/></CAbilAttack>
</Catalog>
`

function graphRoot(rootId: string, dependencies: readonly string[] = []) {
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

describe('resolved SC2 data edit through host targets and writer', () => {
  it('isolates one shared Weapon in C and supports reopen, undo and redo', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'sc2-data-context-'))
    const aRoot = join(scratch, 'A.SC2Mod')
    const cRoot = join(scratch, 'C.SC2Mod')
    const relative = join('Base.SC2Data', 'GameData', 'UnitData.xml')
    const aPath = join(aRoot, relative)
    const cPath = join(cRoot, relative)
    mkdirSync(dirname(aPath), { recursive: true })
    mkdirSync(dirname(cPath), { recursive: true })
    writeFileSync(aPath, xml(45))
    writeFileSync(cPath, contextXml())

    const host = await createModkit({ extensions: [extension], roots: [scratch] })
    const backend = createFileEditingBackend({ roots: [scratch] })
    const opened = new Map([
      ['a.sc2mod/base.sc2data/gamedata/unitdata.xml', aPath],
      ['c.sc2mod/base.sc2data/gamedata/unitdata.xml', cPath],
    ])
    const resources = {
      sessionId: 'sc2-data-context-resources',
      revision: revisionId('provider-token:sc2-data-context'),
      state: () => 'live' as const,
      async resolve(requirement: {
        id: string
        logicalId: string
        role: string
        scopes: string[]
      }) {
        const path = opened.get(requirement.logicalId.toLowerCase())
        if (path === undefined) {
          return {
            state: 'unresolved' as const,
            reason: 'not-found' as const,
            diagnostic: {
              severity: 'information' as const,
              code: 'test/not-found',
              message: requirement.logicalId,
            },
            provenance: {
              requirementId: requirement.id,
              logicalId: requirement.logicalId,
              role: requirement.role,
              state: 'unresolved' as const,
              reason: 'not-found' as const,
              cached: false,
              scopes: requirement.scopes,
            },
          }
        }
        const source = await openFileArtifactSource(path)
        return {
          state: 'resolved' as const,
          lease: { value: source, release: async () => undefined },
          revision: source.revision,
          provenance: {
            requirementId: requirement.id,
            logicalId: requirement.logicalId,
            role: requirement.role,
            state: 'resolved' as const,
            revision: source.revision,
            bytes: source.size,
            cached: false,
            scopes: requirement.scopes,
          },
        }
      },
      provenance: () => [],
      dispose: async () => undefined,
    }
    try {
      const rootSource = await openDirectoryArtifactSource(cRoot)
      const rootRevision = rootSource.revision
      const rootTarget = {
        targetId: rootSource.ref.id,
        subjectUri: rootSource.ref.uri,
        ownerSource: rootSource.ref,
        semanticPath: [],
        expectedRevision: {
          bindings: { [rootSource.ref.id]: rootRevision },
          namespaceRevision: rootRevision,
          compositionFingerprint: canonicalJsonStringify({
            topology: 'namespace',
            root: { id: rootSource.ref.id, uri: rootSource.ref.uri },
            revision: rootRevision,
          }),
        },
      }
      const a = graphRoot('A')
      const c = graphRoot('C', ['A'])
      const workspace = {
        schemaVersion: 1 as const,
        workspaceId: 'sc2-data-context',
        gameId: 'blizzard/starcraft-2',
        activeRootId: 'C',
        sources: [a, c].map(root => ({
          sourceId: root.sourceId,
          kind: 'directory' as const,
          location: root.sourcePath,
        })),
        loadOrder: [a, c],
        dependencyOrder: [a],
        logicalRoots: [c, a],
        diagnostics: [],
        complete: true,
      }
      const analyzed = await analyzeResolvedDataWorkspace({
        services: host.services,
        grant: { id: 'sc2-data-context-read', classes: [] },
        budgets: budget,
        workspace,
        resources: resources as never,
        locales: ['enUS'],
        queries: [{ namespace: 'Unit', entityId: 'Marine' }],
        limits: {
          maxRequirements: 1_000,
          maxDocumentBytes: 1_000_000,
          maxTextBytes: 2_000_000,
          maxEntities: 1_000,
          maxDepth: 64,
          maxPageSize: 100,
        },
        writableRoots: [{ rootId: 'C', sourcePath: 'C.SC2Mod', target: rootTarget }],
      })
      expect(
        analyzed.state,
        analyzed.diagnostics.map(item => `${item.code}: ${item.message}`).join('\n'),
      ).toBe('resolved')
      if (analyzed.state !== 'resolved' || analyzed.buildEditChange === undefined) return
      try {
        const previewTarget = await analyzed.resolveEditTarget?.({
          subject: { namespace: 'Unit', entityId: 'Marine' },
          fieldPath: ['LifeMax'],
        })
        expect(previewTarget).toMatchObject({
          state: 'resolved',
          writeTarget: {
            rootId: 'C',
            path: 'C.SC2Mod/Base.SC2Data/GameData/UnitData.xml',
            mode: 'replace',
            label: 'Write: C → C.SC2Mod/Base.SC2Data/GameData/UnitData.xml',
          },
        })
        const selector = createResolvedDataSubjectSelectorLease(analyzed, {
          maxPageSize: 100,
          maxEntities: 1_000,
          maxRelations: 1_000,
          maxCalculations: 256,
        })
        expect(selector).toBeDefined()
        try {
          const sharedTarget = await selector?.value.editTarget?.({
            subjectId: 'Unit/Marine',
            fieldPath: ['LifeMax'],
          })
          expect(sharedTarget).toMatchObject({
            state: 'resolved',
            subjectId: 'Unit/Marine',
            action: 'update-local-field',
            destination: {
              rootId: 'C',
              path: 'C.SC2Mod/Base.SC2Data/GameData/UnitData.xml',
              targetId: previewTarget?.state === 'resolved' ? previewTarget.writeTarget.targetId : '',
            },
            effectiveFieldSource: { rootId: 'C' },
          })
          const clientPlan = await selector?.value.isolationPlan?.({
            schemaVersion: 1,
            ownerSubjectId: 'Unit/Marine',
            targetSubjectId: 'Weapon/GaussRifle',
            cloneSubjectId: 'Weapon/MarineGaussRifle',
            ownerFieldPath: ['WeaponArray', '0', 'Link'],
            maxEdges: 1_000,
          })
          expect(clientPlan).toMatchObject({
            schemaVersion: 1,
            state: 'planned',
            ownerSubjectId: 'Unit/Marine',
            targetSubjectId: 'Weapon/GaussRifle',
            cloneSubjectId: 'Weapon/MarineGaussRifle',
            replacements: [
              {
                purpose: 'clone-and-rewire',
                destination: {
                  rootId: 'C',
                  path: 'C.SC2Mod/Base.SC2Data/GameData/UnitData.xml',
                  mode: 'replace',
                },
                replacementBytes: expect.any(Number),
              },
            ],
          })
          expect(clientPlan?.state === 'planned' && clientPlan.replacements[0]?.replacementBytes).toBeGreaterThan(0)
          const factsLease = await selector?.value.openFacts('Unit/Marine')
          try {
            const fieldFacts = await factsLease?.value.facts('resolved-fields', { limit: 100 })
            const life = fieldFacts?.items.find(item => item.label === 'LifeMax')
            expect(life?.editTarget).toMatchObject({
              state: 'resolved',
              subjectId: 'Unit/Marine',
              fieldPath: ['LifeMax'],
              destination: {
                rootId: 'C',
                path: 'C.SC2Mod/Base.SC2Data/GameData/UnitData.xml',
                label: 'Write: C → C.SC2Mod/Base.SC2Data/GameData/UnitData.xml',
              },
            })
          } finally {
            await factsLease?.release()
          }
        } finally {
          await selector?.release()
        }
        expect(analyzed.buildIsolationChange).toBeDefined()
        const isolationChange = await analyzed.buildIsolationChange?.({
          schemaVersion: 1,
          owner: { namespace: 'Unit', entityId: 'Marine' },
          target: { namespace: 'Weapon', entityId: 'GaussRifle' },
          ownerFieldPath: ['WeaponArray', '0', 'Link'],
          maxEdges: 1_000,
          cloneEntityId: 'MarineGaussRifle',
        })
        expect(isolationChange?.targets).toHaveLength(2)
        expect(isolationChange?.edits).toHaveLength(1)
        expect(isolationChange?.edits[0]).toMatchObject({ operation: 'replace' })
        if (isolationChange?.edits[0]?.payload.kind === 'text') {
          expect(isolationChange.edits[0].payload.text).toContain(
            '<CUnit id="Marine"><WeaponArray index="0" Link="MarineGaussRifle"/>',
          )
          expect(isolationChange.edits[0].payload.text).toContain(
            '<CUnit id="Marauder"><WeaponArray index="0" Link="GaussRifle"/>',
          )
          expect(isolationChange.edits[0].payload.text).toContain(
            '<CWeaponLegacy id="MarineGaussRifle">',
          )
        }
        const change = isolationChange
        if (change === undefined) throw new Error('isolation ChangeSet is unavailable')
        expect(change.targets).toHaveLength(2)
        expect(change.edits).toHaveLength(1)
        expect(change.edits[0]).toMatchObject({ operation: 'replace' })

        if (host.services.serviceDefinitions === undefined) throw new Error('missing definitions')
        const resolver = createHostServiceResolver({
          inventory: host.services.inventory,
          target: host.services.target,
          executionBackends: host.services.executionBackends,
          definitions: host.services.serviceDefinitions,
          grant: { id: 'sc2-data-context-writer', classes: ['write-source'] },
          budgets: budget,
        })
        const lease = await resolver.port.resolve({
          contract: 'common.edit/writer',
          major: 1,
          facet: {
            formatId: 'sc2-data',
            representationId: 'source',
            mutationMode: 'mutate',
            minimumRoundTrip: 'byte-identical',
          },
        })
        try {
          const writer = lease.value as any
          const plan = await writer.plan(change)
          const grant = createGrantSnapshot({
            snapshotId: 'sc2-data-context-grant',
            permissions: ['write-source'],
            sourceIds: [change.edits[0]!.source.id],
          })
          const coordinator = createCommitCoordinator({
            payloads: {
              async open() {
                throw new Error('no staged payload')
              },
            },
            backendFor: () => backend,
            evidenceFor: () => ({
              ...plan.fidelity,
              evidenceId: 'sc2-data-context-evidence',
              corpusId: 'sc2-data-context-corpus',
              corpusDigest: `sha256:${createHash('sha256').update(contextXml()).digest('hex')}`,
              conformanceProfile: 'modkit/sc2-data-context-v1',
              writer: writer.identity,
              optionsFingerprint: 'sc2-data-context-default',
              inputClass: 'loose-sc2mod-gamedata',
              provenAt: '2026-09-11T00:00:00.000Z',
            }),
            isGrantValid: value => value.snapshotId === grant.snapshotId,
            digest: value =>
              createHash('sha256')
                .update(canonicalJsonStringify(value as never))
                .digest('hex'),
          })
          const beforeDirectEdit = readFileSync(cPath, 'utf8')
          writeFileSync(cPath, beforeDirectEdit.replace('LifeMax value="50"', 'LifeMax value="51"'))
          expect(await coordinator.prepare(plan, { grant })).toMatchObject({ state: 'conflict' })
          expect(readFileSync(aPath, 'utf8')).toBe(xml(45))
          writeFileSync(cPath, beforeDirectEdit)
          /*
           * Restored bytes are still a new revision of the file (revisions are the file's stat, not
           * its content): the stale plan stays refused, and a fresh analysis plans it again.
           */
          expect(await coordinator.prepare(plan, { grant })).toMatchObject({ state: 'conflict' })
          const fresh = await analyzeResolvedDataWorkspace({
            services: host.services,
            grant: { id: 'sc2-data-context-replan', classes: [] },
            budgets: budget,
            workspace,
            resources: resources as never,
            locales: ['enUS'],
            queries: [{ namespace: 'Unit', entityId: 'Marine' }],
            limits: {
              maxRequirements: 1_000,
              maxDocumentBytes: 1_000_000,
              maxTextBytes: 2_000_000,
              maxEntities: 1_000,
              maxDepth: 64,
              maxPageSize: 100,
            },
            writableRoots: [{ rootId: 'C', sourcePath: 'C.SC2Mod', target: rootTarget }],
          })
          if (fresh.state !== 'resolved' || fresh.buildIsolationChange === undefined) {
            throw new Error('the restored workspace did not analyze')
          }
          const replanned = await writer.plan(
            await fresh.buildIsolationChange({
              schemaVersion: 1,
              owner: { namespace: 'Unit', entityId: 'Marine' },
              target: { namespace: 'Weapon', entityId: 'GaussRifle' },
              ownerFieldPath: ['WeaponArray', '0', 'Link'],
              maxEdges: 1_000,
              cloneEntityId: 'MarineGaussRifle',
            }),
          )
          await fresh.release()

          const prepared = await coordinator.prepare(replanned, { grant })
          expect(prepared.state).toBe('ready')
          if (prepared.state !== 'ready') return
          const committed = await coordinator.commit(prepared.prepared, { grant })
          expect(committed.state).toBe('committed')
          if (committed.state !== 'committed') return
          expect(readFileSync(cPath, 'utf8')).toContain('Link="MarineGaussRifle"')
          expect(readFileSync(cPath, 'utf8')).toContain(
            '<CUnit id="Marauder"><WeaponArray index="0" Link="GaussRifle"/></CUnit>',
          )
          expect(readFileSync(cPath, 'utf8')).toContain('<CWeaponLegacy id="MarineGaussRifle">')
          expect(readFileSync(aPath, 'utf8')).toBe(xml(45))
          const reopened = await analyzeResolvedDataWorkspace({
            services: host.services,
            grant: { id: 'sc2-data-context-reopen', classes: [] },
            budgets: budget,
            workspace,
            resources: resources as never,
            locales: ['enUS'],
            queries: [
              { namespace: 'Unit', entityId: 'Marine' },
              { namespace: 'Weapon', entityId: 'MarineGaussRifle' },
            ],
            limits: {
              maxRequirements: 1_000,
              maxDocumentBytes: 1_000_000,
              maxTextBytes: 2_000_000,
              maxEntities: 1_000,
              maxDepth: 64,
              maxPageSize: 100,
            },
          })
          expect(reopened.state).toBe('resolved')
          if (reopened.state === 'resolved') {
            const originalWeapon = reopened.snapshot.definitions.find(
              entity => entity.namespace === 'Weapon' && entity.entityId === 'GaussRifle',
            )
            const clonedWeapon = reopened.snapshot.definitions.find(
              entity => entity.namespace === 'Weapon' && entity.entityId === 'MarineGaussRifle',
            )
            expect(
              clonedWeapon?.fields,
            ).toEqual(originalWeapon?.fields)
            expect(
              reopened.snapshot.relations.some(
                relation =>
                  relation.from.namespace === 'Unit' &&
                  relation.from.entityId === 'Marine' &&
                  relation.to.namespace === 'Weapon' &&
                  relation.to.entityId === 'MarineGaussRifle',
              ),
            ).toBe(true)
            expect(
              reopened.snapshot.relations.some(
                relation =>
                  relation.from.namespace === 'Unit' &&
                  relation.from.entityId === 'Marauder' &&
                  relation.to.namespace === 'Weapon' &&
                  relation.to.entityId === 'GaussRifle',
              ),
            ).toBe(true)
            expect(
              reopened.snapshot.relations.some(
                relation =>
                  relation.from.namespace === 'Unit' &&
                  relation.from.entityId === 'Marauder' &&
                  relation.to.namespace === 'Weapon' &&
                  relation.to.entityId === 'MarineGaussRifle',
              ),
            ).toBe(false)
            await reopened.release()
          }
          expect(
            await coordinator.undo(committed.receipt.transactionId, { grant }),
          ).toMatchObject({ state: 'committed' })
          expect(readFileSync(cPath, 'utf8')).toBe(contextXml())
          expect(readFileSync(aPath, 'utf8')).toBe(xml(45))
          expect(
            await coordinator.redo(committed.receipt.transactionId, { grant }),
          ).toMatchObject({ state: 'committed' })
          expect(readFileSync(cPath, 'utf8')).toContain('Link="MarineGaussRifle"')
        } finally {
          await lease.release()
          await resolver.release()
        }
      } finally {
        await analyzed.release()
      }
    } finally {
      await backend.dispose()
      await host.close()
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it('commits and reopens a structured indexed declaration in D while rechecking authority', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'sc2-data-create-context-'))
    const aRoot = join(scratch, 'A.SC2Mod')
    const dRoot = join(scratch, 'D.SC2Mod')
    const relative = join('Base.SC2Data', 'GameData', 'AbilData.xml')
    const aPath = join(aRoot, relative)
    const dPath = join(dRoot, relative)
    mkdirSync(dirname(aPath), { recursive: true })
    mkdirSync(dRoot, { recursive: true })
    writeFileSync(aPath, abilityXml())

    const host = await createModkit({ extensions: [extension], roots: [scratch] })
    const backend = createFileEditingBackend({ roots: [scratch] })
    const resources = {
      sessionId: 'sc2-data-create-context-resources',
      revision: revisionId('provider-token:sc2-data-create-context'),
      state: () => 'live' as const,
      async resolve(requirement: {
        id: string
        logicalId: string
        role: string
        scopes: string[]
      }) {
        const path =
          requirement.logicalId.toLowerCase() ===
          'a.sc2mod/base.sc2data/gamedata/abildata.xml'
            ? aPath
            : undefined
        if (path === undefined) {
          return {
            state: 'unresolved' as const,
            reason: 'not-found' as const,
            diagnostic: {
              severity: 'information' as const,
              code: 'test/not-found',
              message: requirement.logicalId,
            },
            provenance: {
              requirementId: requirement.id,
              logicalId: requirement.logicalId,
              role: requirement.role,
              state: 'unresolved' as const,
              reason: 'not-found' as const,
              cached: false,
              scopes: requirement.scopes,
            },
          }
        }
        const source = await openFileArtifactSource(path)
        return {
          state: 'resolved' as const,
          lease: { value: source, release: async () => undefined },
          revision: source.revision,
          provenance: {
            requirementId: requirement.id,
            logicalId: requirement.logicalId,
            role: requirement.role,
            state: 'resolved' as const,
            revision: source.revision,
            bytes: source.size,
            cached: false,
            scopes: requirement.scopes,
          },
        }
      },
      provenance: () => [],
      dispose: async () => undefined,
    }
    try {
      const rootSource = await openDirectoryArtifactSource(dRoot)
      const rootRevision = rootSource.revision
      const rootTarget = {
        targetId: rootSource.ref.id,
        subjectUri: rootSource.ref.uri,
        ownerSource: rootSource.ref,
        semanticPath: [],
        expectedRevision: {
          bindings: { [rootSource.ref.id]: rootRevision },
          namespaceRevision: rootRevision,
          compositionFingerprint: canonicalJsonStringify({
            topology: 'namespace',
            root: { id: rootSource.ref.id, uri: rootSource.ref.uri },
            revision: rootRevision,
          }),
        },
      }
      const a = graphRoot('A')
      const d = graphRoot('D', ['A'])
      const workspace = {
        schemaVersion: 1 as const,
        workspaceId: 'sc2-data-create-context',
        gameId: 'blizzard/starcraft-2',
        activeRootId: 'D',
        sources: [a, d].map(root => ({
          sourceId: root.sourceId,
          kind: 'directory' as const,
          location: root.sourcePath,
        })),
        loadOrder: [a, d],
        dependencyOrder: [a],
        logicalRoots: [d, a],
        diagnostics: [],
        complete: true,
      }
      const analyzed = await analyzeResolvedDataWorkspace({
        services: host.services,
        grant: { id: 'sc2-data-create-context-read', classes: [] },
        budgets: budget,
        workspace,
        resources: resources as never,
        locales: ['enUS'],
        queries: [{ namespace: 'Abil', entityId: 'Attack' }],
        limits: {
          maxRequirements: 1_000,
          maxDocumentBytes: 1_000_000,
          maxTextBytes: 2_000_000,
          maxEntities: 1_000,
          maxDepth: 64,
          maxPageSize: 100,
        },
        writableRoots: [{ rootId: 'D', sourcePath: 'D.SC2Mod', target: rootTarget }],
      })
      expect(
        analyzed.state,
        analyzed.diagnostics.map(item => `${item.code}: ${item.message}`).join('\n'),
      ).toBe('resolved')
      if (analyzed.state !== 'resolved' || analyzed.buildEditChange === undefined) return
      try {
        const change = await analyzed.buildEditChange({
          subject: { namespace: 'Abil', entityId: 'Attack' },
          fieldPath: ['CmdButtonArray'],
          intent: {
            kind: 'set-indexed-entry',
            index: 'Execute',
            value: { DefaultButtonFace: 'Attack', State: 'Enabled' },
          },
        })
        expect(change.edits).toHaveLength(1)
        expect(change.edits[0]).toMatchObject({
          operation: 'create',
          newPath: 'Base.SC2Data/GameData/AbilData.xml',
        })
        expect(existsSync(dPath)).toBe(false)

        const writer = createAuthoredTextWriter(
          { contract: 'common.edit/writer', major: 1, offerId: 'sc2-data-source' },
          { budgets: budget },
        ).value as any
        const plan = await writer.plan(change)
        const grant = createGrantSnapshot({
          snapshotId: 'sc2-data-create-context-grant',
          permissions: ['write-source'],
          sourceIds: [change.edits[0]!.source.id],
        })
        const validGrants = new Set([grant.snapshotId])
        let writable = true
        const coordinator = createCommitCoordinator({
          payloads: {
            async open() {
              throw new Error('no staged payload')
            },
          },
          // Revoked writability is the same backend reporting read-only; a missing backend would be
          // an invalid plan, not a read-only source.
          backendFor: () => (writable ? backend : Object.freeze({ ...backend, writable: false })),
          evidenceFor: () => ({
            ...plan.fidelity,
            evidenceId: 'sc2-data-create-context-evidence',
            corpusId: 'sc2-data-create-context-corpus',
            corpusDigest: `sha256:${createHash('sha256').update(abilityXml()).digest('hex')}`,
            conformanceProfile: 'modkit/sc2-data-create-context-v1',
            writer: writer.identity,
            optionsFingerprint: 'sc2-data-create-context-default',
            inputClass: 'loose-sc2mod-create-gamedata',
            provenAt: '2026-09-11T00:00:00.000Z',
          }),
          isGrantValid: value => validGrants.has(value.snapshotId),
          digest: value =>
            createHash('sha256')
              .update(canonicalJsonStringify(value as never))
              .digest('hex'),
        })

        writable = false
        expect(await coordinator.prepare(plan, { grant })).toMatchObject({
          state: 'rejected',
          reason: 'source-read-only',
        })
        writable = true
        const revokedAfterPreview = await coordinator.prepare(plan, { grant })
        expect(revokedAfterPreview.state).toBe('ready')
        if (revokedAfterPreview.state !== 'ready') return
        validGrants.delete(grant.snapshotId)
        expect(await coordinator.commit(revokedAfterPreview.prepared, { grant })).toMatchObject({
          state: 'not-applied',
          reason: 'permission-missing',
        })
        expect(existsSync(dPath)).toBe(false)

        validGrants.add(grant.snapshotId)
        const closedAfterPreview = await coordinator.prepare(plan, { grant })
        expect(closedAfterPreview.state).toBe('ready')
        if (closedAfterPreview.state !== 'ready') return
        writable = false
        expect(await coordinator.commit(closedAfterPreview.prepared, { grant })).toMatchObject({
          state: 'not-applied',
          reason: 'source-read-only',
        })
        expect(existsSync(dPath)).toBe(false)

        writable = true
        const ready = await coordinator.prepare(plan, { grant })
        expect(ready.state).toBe('ready')
        if (ready.state !== 'ready') return
        const committed = await coordinator.commit(ready.prepared, { grant })
        expect(committed.state).toBe('committed')
        if (committed.state !== 'committed') return
        expect(readFileSync(dPath, 'utf8')).toContain(
          '<CmdButtonArray index="Execute" DefaultButtonFace="Attack" State="Enabled"/>',
        )
        expect(readFileSync(dPath, 'utf8')).not.toContain('DefaultButtonFace="Old"')

        const reopened = await analyzeResolvedDataWorkspace({
          services: host.services,
          grant: { id: 'sc2-data-create-context-reopen', classes: [] },
          budgets: budget,
          workspace,
          resources: {
            ...resources,
            async resolve(requirement: {
              id: string
              logicalId: string
              role: string
              scopes: string[]
            }) {
              const key = requirement.logicalId.toLowerCase()
              const path =
                key === 'a.sc2mod/base.sc2data/gamedata/abildata.xml'
                  ? aPath
                  : key === 'd.sc2mod/base.sc2data/gamedata/abildata.xml'
                    ? dPath
                    : undefined
              if (path === undefined) return resources.resolve(requirement)
              const source = await openFileArtifactSource(path)
              return {
                state: 'resolved' as const,
                lease: { value: source, release: async () => undefined },
                revision: source.revision,
                provenance: {
                  requirementId: requirement.id,
                  logicalId: requirement.logicalId,
                  role: requirement.role,
                  state: 'resolved' as const,
                  revision: source.revision,
                  bytes: source.size,
                  cached: false,
                  scopes: requirement.scopes,
                },
              }
            },
          } as never,
          locales: ['enUS'],
          queries: [{ namespace: 'Abil', entityId: 'Attack' }],
          limits: {
            maxRequirements: 1_000,
            maxDocumentBytes: 1_000_000,
            maxTextBytes: 2_000_000,
            maxEntities: 1_000,
            maxDepth: 64,
            maxPageSize: 100,
          },
        })
        expect(reopened.state).toBe('resolved')
        if (reopened.state === 'resolved') {
          const attack = reopened.snapshot.definitions.find(
            entity => entity.namespace === 'Abil' && entity.entityId === 'Attack',
          )
          expect(attack?.fields.CmdButtonArray).toEqual([
            {
              index: 'Execute',
              value: { DefaultButtonFace: 'Attack', State: 'Enabled' },
            },
          ])
          expect(attack?.sources.at(-1)?.rootId).toBe('D')
          await reopened.release()
        }

        expect(await coordinator.undo(committed.receipt.transactionId, { grant })).toMatchObject({
          state: 'committed',
        })
        expect(existsSync(dPath)).toBe(false)
        expect(readFileSync(aPath, 'utf8')).toBe(abilityXml())
      } finally {
        await analyzed.release()
      }
    } finally {
      await backend.dispose()
      await host.close()
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})
