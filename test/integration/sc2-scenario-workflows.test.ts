import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
import type { ResourceBudget, TreeDataSource } from '@modkit/sdk'
import { proves } from '@modkit/testkit'

const TEST_PATH = 'test/integration/sc2-scenario-workflows.test.ts'
const repoRoot = join(import.meta.dirname, '..', '..')
const extensionRoot = join(repoRoot, 'starcraft2')
const fixtures = join(import.meta.dirname, 'fixtures')
const target = {
  environment: 'node',
  operatingSystem:
    process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux',
  architecture: 'x64',
} as const
const grant = { id: 'sc2-scenario-workflows', classes: ['read-source'] } as const
const budget: ResourceBudget = {
  maxInputBytes: 1_000_000n,
  maxDepth: 32,
  maxNodes: 1_000,
  maxScalarBytes: 1_000_000,
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
let directory: string

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
  directory = await mkdtemp(join(tmpdir(), 'x3-sc2-scenario-'))
}, 120_000)

afterAll(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
})

describe('Block 15 SC2 scenario workflows', () => {
  it('opens TriggerData through product composition and reports nested external libraries', async () => {
    const path = join(directory, 'Triggers')
    await copyFile(join(fixtures, 'Triggers.external-library'), path)
    const opener = createPathSubjectOpener({ subjects, roots: [directory], budget, grant })
    const opened = await opener(path)
    expect(opened.snapshot.state).toBe('opened')
    if (opened.session === undefined) throw new Error('TriggerData product session did not open')

    try {
      const descriptor = (await opened.session.descriptor()) as unknown as {
        readonly identity: { readonly codecId: string }
        readonly constraints: {
          readonly readOnly: boolean
          readonly unsupportedFeatures?: readonly string[]
        }
        readonly operations: readonly { readonly id: string }[]
      }
      expect(descriptor.identity.codecId).toBe('blizzard/sc2-triggers')
      expect(descriptor.constraints).toMatchObject({
        readOnly: true,
        unsupportedFeatures: expect.arrayContaining([
          'automatic-trigger-library-dependency-resolution',
          'automatic-installed-game-native-library-loading',
          'lossless-trigger-galaxy-roundtrip',
          'arbitrary-galaxy-to-trigger-reconstruction',
          'catalog-gamelink-rename',
          'execution',
          'source-writing',
        ]),
      })
      expect(descriptor.operations.map(operation => operation.id).toSorted()).toEqual([
        'asset.validate',
        'blizzard/sc2-triggers.galaxy-to-triggers',
        'blizzard/sc2-triggers.trigger-to-galaxy',
        'export.raw',
        'view.inspect',
      ])

      const inspected = await opened.session.operations().invoke('inspect', null)
      expect(inspected.state).toBe('ok')
      if (inspected.state !== 'ok' || inspected.output.kind !== 'json') {
        throw new Error('TriggerData inspection did not return JSON')
      }
      expect(inspected.output.value).toMatchObject({
        format: 'sc2-triggers',
        libraries: ['DEMO'],
        elements: 4,
        typeCounts: { Trigger: 1, FunctionCall: 3 },
        externalLibraries: ['Ntve'],
      })

      const treeLease = await opened.session.dataSource('common.view/tree-data-source', 1)
      try {
        const tree = treeLease.value as TreeDataSource
        const root = await tree.root()
        expect((await tree.children(root, { limit: 8 })).items).toHaveLength(4)
      } finally {
        await treeLease.release()
      }

      proves({
        capabilityId: 'format/sc2-triggers/open-inspect',
        operation: 'inspect',
        test: TEST_PATH,
        note: 'host composition selects TriggerData, inspects nested external library references and publishes explicit dependency-resolution refusal',
      })
    } finally {
      await opened.session.dispose()
    }
  })

  it('fails closed through the same product seam when TriggerData nesting is malformed', async () => {
    const path = join(directory, 'Malformed.Triggers')
    await writeFile(path, '<TriggerData><Library Id="DEMO"><Element/></TriggerData>', 'utf8')
    const opener = createPathSubjectOpener({ subjects, roots: [directory], budget, grant })
    const refused = await opener(path)
    expect(refused.session).toBeUndefined()
    expect(refused.snapshot).toMatchObject({
      state: 'unresolved',
      reason: 'input-unresolved',
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'x3.host/subject-input-open-failed' }),
      ]),
    })
  })
})
