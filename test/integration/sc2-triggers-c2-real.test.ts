import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'
import {
  buildInventory,
  createBundledServiceDefinitionRegistry,
  createExecutionBackendRegistry,
  createHostContributionContractRegistry,
  createSubjectServices,
  registerServiceDefinitionsOrThrow,
  type SubjectServices,
} from '@modkit/host'
import { createPathSubjectOpener, loadExtensionDirectory } from '@modkit/host/node'
import type { ResourceBudget } from '@modkit/sdk'

const repoRoot = join(import.meta.dirname, '..', '..')
const extensionRoot = join(repoRoot, 'starcraft2')
const configuredSc2Root = process.env.MODKITX_SC2_ROOT?.trim() || 'C:\\Apps\\StarCraft II'
const triggerPath =
  process.env.MODKITX_TIBERIUM_TRIGGERS_PATH?.trim() ||
  join(configuredSc2Root, 'Mods', 'tiberium-crossover', 'mods', 'tib-data.SC2Mod', 'Triggers')
const target = {
  environment: 'node',
  operatingSystem:
    process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux',
  architecture: 'x64',
} as const
const grant = { id: 'sc2-tiberium-c2-real', classes: ['read-source'] } as const
const budget: ResourceBudget = {
  maxInputBytes: 16_777_216n,
  maxDepth: 64,
  maxNodes: 100_000,
  maxScalarBytes: 16_777_216,
  maxDiagnostics: 100,
}
const executionBackends = createExecutionBackendRegistry([
  {
    profile: 'trusted-in-process',
    supports: (_target, variant) => variant.executionProfile === 'trusted-in-process',
    async activate(activation) {
      return {
        module: (await import(activation.entrypoint.href)) as Record<string, unknown>,
        release: async () => undefined,
      }
    },
  },
])

let subjects: SubjectServices

beforeAll(async () => {
  const loaded = await loadExtensionDirectory(extensionRoot)
  const inventory = await buildInventory(
    [
      {
        ...loaded,
        execution: { origin: 'bundled' as const, allowTrustedInProcess: true },
      },
    ],
    createHostContributionContractRegistry(),
  )
  const serviceDefinitions = createBundledServiceDefinitionRegistry()
  await registerServiceDefinitionsOrThrow(inventory, serviceDefinitions)
  subjects = createSubjectServices({ inventory, target, executionBackends, serviceDefinitions })
}, 120_000)

describe('C2 installed Tiberium TriggerData through the product subject opener', () => {
  it('detects the root Triggers file as a blizzard/sc2-triggers candidate', async () => {
    if (!existsSync(triggerPath)) {
      throw new Error(
        `C2 installed corpus is required at ${triggerPath}; set MODKITX_TIBERIUM_TRIGGERS_PATH or MODKITX_SC2_ROOT`,
      )
    }

    const opener = createPathSubjectOpener({
      subjects,
      roots: [dirname(triggerPath)],
      budget,
      grant,
    })
    const opened = await opener(triggerPath)
    const candidate = opened.snapshot.candidates.find(
      item =>
        typeof item === 'object' &&
        item !== null &&
        'contributionId' in item &&
        item.contributionId === 'blizzard/sc2-triggers' &&
        'variantId' in item &&
        item.variantId === 'trusted-node',
    ) as { readonly state?: string; readonly confidence?: number } | undefined
    expect(candidate).toMatchObject({ state: 'detected', confidence: 0.995 })

    if (opened.snapshot.state !== 'opened' || opened.session === undefined) {
      const diagnostics = opened.snapshot.diagnostics
        .map(diagnostic => `${diagnostic.code}: ${diagnostic.message}`)
        .join('; ')
      expect(diagnostics).toContain('x3.host/subject-input-open-failed')
      expect(diagnostics).toContain('SC2 TriggerData elements exceed maxNodes budget')
      return
    }

    try {
      expect(opened.snapshot.state).toBe('opened')
      const descriptor = (await opened.session.descriptor()) as unknown as {
        readonly identity: { readonly codecId: string }
      }
      expect(descriptor.identity.codecId).toBe('blizzard/sc2-triggers')
    } finally {
      await opened.session.dispose()
    }
  })
})
