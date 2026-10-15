import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { JsonValue, ResourceBudget } from '@modkit/sdk'
import {
  buildInventory,
  createExecutionBackendRegistry,
  createHostContributionContractRegistry,
  openSubject,
} from '@modkit/host'
import {
  createFilesystemInputResolver,
  loadExtensionDirectory,
  openFileArtifactSource,
} from '@modkit/host/node'
import { openUvmDocument, type UvmJsonEdit } from '@modkit/scene/uvm'
import { readUvmContainer, writeUvmContainer, type UvmContainer } from '@modkit/uv/model/container'
import { exportM3FromUvm } from '../dist/m3/uvm/converter.js'

const budget: ResourceBudget = {
  maxInputBytes: 268_435_456n,
  maxScalarBytes: 268_435_456,
  maxDepth: 128,
  maxNodes: 1_000_000,
  maxDiagnostics: 1000,
}
const limits = {
  ...budget,
  maxInputBytes: Number(budget.maxInputBytes),
  maxJsonBytes: budget.maxScalarBytes,
}
const standard = (index = 0) =>
  `/materials/${index}/extensions/UV_game_material/params/renderModel/standard`
const layer = (index = 0, slot = 'diffuse') => `${standard(index)}/layers/${slot}`

function at(value: unknown, path: string): unknown {
  let current = value
  for (const key of path.split('/').filter(Boolean)) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

let inventoryPromise: ReturnType<typeof buildInventory> | undefined
function inventory() {
  return (inventoryPromise ??= (async () =>
    buildInventory(
      [
        {
          ...(await loadExtensionDirectory(join(import.meta.dirname, '..'))),
          execution: { origin: 'bundled', allowTrustedInProcess: true },
        },
      ],
      createHostContributionContractRegistry(),
    ))())
}

async function ordinaryUvm(bytes: Uint8Array): Promise<UvmContainer> {
  const directory = await mkdtemp(join(tmpdir(), 'm3-material-export-'))
  try {
    const primaryPath = join(directory, 'Material.m3')
    const available = await inventory()
    await writeFile(primaryPath, bytes, { flag: 'wx' })
    const opened = await openSubject({
      source: await openFileArtifactSource(primaryPath),
      path: primaryPath,
      inventory: available,
      intent: 'full',
      target: { environment: 'node', operatingSystem: 'windows', architecture: 'x64' },
      grant: { id: 'm3-material-export-owner', classes: ['read-source'] },
      budget,
      resolveInput: createFilesystemInputResolver({
        primaryPath,
        roots: [directory],
        inventory: available,
      }),
      executionBackends: createExecutionBackendRegistry([
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
      ]),
    })
    if (opened.state !== 'opened')
      throw new Error(`ordinary material open failed: ${JSON.stringify(opened)}`)
    try {
      expect(opened.selected.contributionId).toBe('blizzard/m3')
      const output = await opened.session
        .operations()
        .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
      if (output.state !== 'ok' || output.output.kind !== 'bytes')
        throw new Error(`material UVM export failed: ${JSON.stringify(output)}`)
      expect(Uint8Array.from(await readFile(primaryPath))).toEqual(bytes)
      return readUvmContainer(output.output.value, limits)
    } finally {
      await opened.session.dispose()
    }
  } finally {
    const child = relative(tmpdir(), directory)
    if (
      child.startsWith('..') ||
      isAbsolute(child) ||
      !basename(directory).startsWith('m3-material-export-')
    )
      throw new Error('unexpected material export scratch directory')
    await rm(directory, { recursive: true, force: true })
  }
}

function edit(container: UvmContainer, edits: readonly UvmJsonEdit[]): UvmContainer {
  const state = openUvmDocument(writeUvmContainer(container, limits), { budget: limits })
  try {
    state.apply({ expectedRevision: 0, json: edits })
    return state.snapshot()
  } finally {
    state.dispose()
  }
}

function set(container: UvmContainer, path: string, value: JsonValue): UvmJsonEdit {
  return { op: at(container.document, path) === undefined ? 'add' : 'replace', path, value }
}

let authored: UvmContainer | undefined
beforeAll(async () => {
  authored = await ordinaryUvm(
    Uint8Array.from(
      await readFile(new URL('./fixtures/m3/corpus/Harbinger.m3', import.meta.url)),
    ),
  )
}, 60_000)

describe('source-free canonical M3 material writes', () => {
  it('encodes deterministically from UVM without retaining native bytes', async () => {
    const bytes = Uint8Array.from(
      await readFile(new URL('./fixtures/m3/corpus/Harbinger.m3', import.meta.url)),
    )
    const container = await ordinaryUvm(bytes)
    expect(at(container.document, '/extras/BlizzardM3/source')).toBeUndefined()
    const first = await exportM3FromUvm(container, limits)
    const second = await exportM3FromUvm(container, limits)
    expect(Buffer.from(first.subarray(0, 4)).toString()).toBe('43DM')
    expect(second).toEqual(first)
  }, 60_000)

  it('round-trips standard-material and UV transform values semantically', async () => {
    if (!authored) throw new Error('authored fixture absent')
    const authoredMaterials = authored.document['materials']
    const sourceName = Array.isArray(authoredMaterials)
      ? (authoredMaterials[0] as Record<string, unknown> | undefined)?.['name']
      : undefined
    if (typeof sourceName !== 'string') throw new Error('authored material name absent')
    const edited = edit(authored, [
      set(authored, `${standard()}/specularity`, 16),
      set(authored, `${standard()}/specMult`, 4),
      set(authored, `${standard()}/emisMult`, 6),
      set(authored, `${standard()}/environmentMultipliers`, [2, 4, 8]),
      set(authored, `${standard()}/parallaxHeight`, { value: 0.5 }),
      set(authored, `${layer()}/uvOffset`, { value: [0.25, -0.5] }),
      set(authored, `${layer()}/uvTiling`, { value: [2, 4] }),
      set(authored, `${layer()}/uvAngle`, { value: [0.25, 0.5, 1] }),
    ])
    const native = await exportM3FromUvm(edited, limits)
    const reopened = await ordinaryUvm(native)
    const reopenedMaterials = reopened.document['materials']
    const reopenedIndex = Array.isArray(reopenedMaterials)
      ? reopenedMaterials.findIndex(value =>
          value !== null && typeof value === 'object' && !Array.isArray(value) && value['name'] === sourceName,
        )
      : -1
    if (reopenedIndex < 0)
      throw new Error(
        `reopened material ${sourceName} absent: ${JSON.stringify(Array.isArray(reopenedMaterials) ? reopenedMaterials.map(value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value['name'] : undefined) : [])}`,
      )
    for (const [path, expected] of [
      [`${standard(reopenedIndex)}/specularity`, 16],
      [`${standard(reopenedIndex)}/specMult`, 4],
      [`${standard(reopenedIndex)}/emisMult`, 6],
      [`${standard(reopenedIndex)}/environmentMultipliers`, [2, 4, 8]],
      [`${standard(reopenedIndex)}/parallaxHeight/value`, 0.5],
      [`${layer(reopenedIndex)}/uvOffset/value`, [0.25, -0.5]],
      [`${layer(reopenedIndex)}/uvTiling/value`, [2, 4]],
      [`${layer(reopenedIndex)}/uvAngle/value`, [0.25, 0.5, 1]],
    ] as const)
      expect(at(reopened.document, path)).toEqual(expected)
  }, 60_000)

  it('rejects unrelated document extras that fresh M3 cannot represent', async () => {
    if (!authored) throw new Error('authored fixture absent')
    await expect(
      exportM3FromUvm(
        edit(authored, [{ op: 'add', path: '/extras/ForeignMetadata', value: { keep: true } }]),
        limits,
      ),
    ).rejects.toThrow(/extras/u)
  })
})
