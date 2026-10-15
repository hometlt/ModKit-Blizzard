import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { canonicalJsonStringify } from '@modkit/core'
import { analyzeResolvedDataWorkspace } from '@modkit/host'
import {
  createModkit,
  openDirectoryArtifactSource,
  openFileArtifactSource,
} from '@modkit/host/node'
import { revisionId } from '@modkit/sdk'
import { describe, expect, it } from 'vitest'

const extension = resolve(import.meta.dirname, '..', '..', '..')
const relativeDataPath = join('Base.SC2Data', 'GameData', 'UnitData.xml')
const xml = (life: number) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<Catalog>\n  <CUnit id="Marine"><LifeMax value="${life}"/></CUnit>\n</Catalog>\n`

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

describe('resolved SC2 data follows the selected workspace context', () => {
  it('opening B excludes its dependent C and writes the effective value in B', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'sc2-data-open-b-'))
    const paths = new Map<string, string>()
    for (const [rootId, life] of [
      ['A', 45],
      ['B', 50],
      ['C', 99],
    ] as const) {
      const path = join(scratch, `${rootId}.SC2Mod`, relativeDataPath)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, xml(life))
      paths.set(`${rootId.toLowerCase()}.sc2mod/base.sc2data/gamedata/unitdata.xml`, path)
    }

    const host = await createModkit({ extensions: [extension], roots: [scratch] })
    const resolvedLogicalIds: string[] = []
    const resources = {
      sessionId: 'sc2-data-open-b-resources',
      revision: revisionId('provider-token:sc2-data-open-b'),
      state: () => 'live' as const,
      async resolve(requirement: {
        id: string
        logicalId: string
        role: string
        scopes: string[]
      }) {
        resolvedLogicalIds.push(requirement.logicalId)
        const path = paths.get(requirement.logicalId.toLowerCase())
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
      const bRoot = join(scratch, 'B.SC2Mod')
      const bSource = await openDirectoryArtifactSource(bRoot)
      const bTarget = {
        targetId: bSource.ref.id,
        subjectUri: bSource.ref.uri,
        ownerSource: bSource.ref,
        semanticPath: [],
        expectedRevision: {
          bindings: { [bSource.ref.id]: bSource.revision },
          namespaceRevision: bSource.revision,
          compositionFingerprint: canonicalJsonStringify({
            topology: 'namespace',
            root: { id: bSource.ref.id, uri: bSource.ref.uri },
            revision: bSource.revision,
          }),
        },
      }
      const a = graphRoot('A')
      const b = graphRoot('B', ['A'])
      const workspace = {
        schemaVersion: 1 as const,
        workspaceId: 'sc2-data-open-b',
        gameId: 'blizzard/starcraft-2',
        activeRootId: 'B',
        sources: [a, b].map(root => ({
          sourceId: root.sourceId,
          kind: 'directory' as const,
          location: root.sourcePath,
        })),
        loadOrder: [a, b],
        dependencyOrder: [a],
        logicalRoots: [b, a],
        diagnostics: [],
        complete: true,
      }
      const analyzed = await analyzeResolvedDataWorkspace({
        services: host.services,
        grant: { id: 'sc2-data-open-b-read', classes: [] },
        budgets: {
          maxInputBytes: 4_000_000n,
          maxDepth: 64,
          maxNodes: 100_000,
          maxScalarBytes: 4_000_000,
          maxDiagnostics: 1_000,
        },
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
        writableRoots: [{ rootId: 'B', sourcePath: 'B.SC2Mod', target: bTarget }],
      })
      expect(
        analyzed.state,
        analyzed.diagnostics.map(item => `${item.code}: ${item.message}`).join('\n'),
      ).toBe('resolved')
      if (analyzed.state !== 'resolved' || analyzed.buildEditChange === undefined) return
      try {
        expect(resolvedLogicalIds.some(id => id.toLowerCase().startsWith('c.sc2mod/'))).toBe(false)
        expect(existsSync(paths.get('c.sc2mod/base.sc2data/gamedata/unitdata.xml')!)).toBe(true)

        const target = await analyzed.resolveEditTarget?.({
          subject: { namespace: 'Unit', entityId: 'Marine' },
          fieldPath: ['LifeMax'],
        })
        expect(target).toMatchObject({
          state: 'resolved',
          effectiveFieldSource: { rootId: 'B' },
          writeTarget: {
            rootId: 'B',
            path: 'B.SC2Mod/Base.SC2Data/GameData/UnitData.xml',
            mode: 'replace',
          },
        })

        const change = await analyzed.buildEditChange({
          subject: { namespace: 'Unit', entityId: 'Marine' },
          fieldPath: ['LifeMax'],
          intent: { kind: 'set-field', value: 60 },
        })
        expect(change.edits).toHaveLength(1)
        expect(change.edits[0]).toMatchObject({ operation: 'replace' })
        if (change.edits[0]?.payload.kind === 'text') {
          expect(change.edits[0].payload.text).toContain('<LifeMax value="60"/>')
          expect(change.edits[0].payload.text).not.toContain('value="99"')
        }
      } finally {
        await analyzed.release()
      }
    } finally {
      await host.close()
      rmSync(scratch, { recursive: true, force: true })
    }
  }, 60_000)
})
