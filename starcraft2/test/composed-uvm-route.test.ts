import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildInventory,
  createExecutionBackendRegistry,
  createHostContributionContractRegistry,
  openSubject,
} from '@modkit/host'
import { loadExtensionDirectory, openFileArtifactSource } from '@modkit/host/node'

const repoRoot = join(import.meta.dirname, '..', '..')
const coreRoot = join(repoRoot, '..', 'modkit-core')
const fixture = join(
  coreRoot,
  'packages',
  'testkit',
  'test',
  'fixtures',
  'mk2-synthetic',
  'minimal.uvm.glb',
)

describe('composed Blizzard and Core model inventory', () => {
  it('opens UVM through the same contribution composition used by SC2 maps', async () => {
    const inputs = await Promise.all(
      [
        join(repoRoot, 'starcraft2'),
        join(repoRoot, 'mpq'),
        join(repoRoot, 'casc'),
        join(repoRoot, 'models'),
        join(coreRoot, 'extensions', 'images'),
        join(coreRoot, 'extensions', 'models'),
      ].map(directory => loadExtensionDirectory(directory)),
    )
    const inventory = await buildInventory(
      inputs.map((input, index) => ({
        ...input,
        ...(index === 0
          ? {
              artifact: {
                ...input.artifact,
                verifyArtifactDigest: (expected: string) =>
                  expected === input.artifact.artifactDigest,
              },
            }
          : {}),
        execution: { origin: 'bundled' as const, allowTrustedInProcess: true },
      })),
      createHostContributionContractRegistry(),
    )
    const executionBackends = createExecutionBackendRegistry([
      {
        profile: 'trusted-in-process',
        supports: (_target, variant) => variant.executionProfile === 'trusted-in-process',
        async activate(context) {
          return {
            module: (await import(context.entrypoint.href)) as Record<string, unknown>,
            release: async () => undefined,
          }
        },
      },
    ])
    const opened = await openSubject({
      inventory,
      source: await openFileArtifactSource(fixture),
      path: fixture,
      intent: 'full',
      target: { environment: 'node', operatingSystem: 'windows', architecture: 'x64' },
      grant: { id: 'composed-uvm-route', classes: ['read-source'] },
      executionBackends,
      budget: {
        maxInputBytes: 16_777_216n,
        maxDepth: 32,
        maxNodes: 100_000,
        maxScalarBytes: 16_777_216,
        maxDiagnostics: 1_000,
      },
    })
    expect(opened.state, JSON.stringify(opened)).toBe('opened')
    if (opened.state !== 'opened') return
    try {
      expect(opened.selected.contributionId).toBe('modkit/model-uvm')
    } finally {
      await opened.session.dispose()
    }
  }, 30_000)
})
