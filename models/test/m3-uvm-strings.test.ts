import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative } from 'node:path'
import { beforeAll, expect, it } from 'vitest'
import type { ResourceBudget } from '@modkit/sdk'
import {
  buildInventory,
  createExecutionBackendRegistry,
  createHostContributionContractRegistry,
  openSubject,
  type Inventory,
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
  maxNodes: 1_000_000,
  maxDepth: 128,
  maxDiagnostics: 1000,
}
const limits = {
  ...budget,
  maxInputBytes: Number(budget.maxInputBytes),
  maxJsonBytes: budget.maxScalarBytes,
}
let inventory: Inventory
beforeAll(async () => {
  inventory = await buildInventory(
    [
      {
        ...(await loadExtensionDirectory(join(import.meta.dirname, '..'))),
        execution: { origin: 'bundled', allowTrustedInProcess: true },
      },
    ],
    createHostContributionContractRegistry(),
  )
})

async function nativeFixture(kind: 'm3' | 'm3a'): Promise<Uint8Array> {
  const stored = await readFile(
    new URL(
      kind === 'm3'
        ? './fixtures/m3/corpus/Harbinger.m3'
        : './fixtures/m3/cybros-cover.m3a.b64',
      import.meta.url,
    ),
  )
  return kind === 'm3'
    ? Uint8Array.from(stored)
    : Uint8Array.from(Buffer.from(stored.toString().trim(), 'base64'))
}

async function ordinaryUvm(bytes: Uint8Array, kind: 'm3' | 'm3a'): Promise<UvmContainer> {
  const directory = await mkdtemp(join(tmpdir(), 'm3-uvm-strings-'))
  try {
    const path = join(directory, `model.${kind}`)
    await writeFile(path, bytes)
    const opened = await openSubject({
      inventory,
      source: await openFileArtifactSource(path),
      path,
      intent: 'full',
      target: { environment: 'node', operatingSystem: 'windows', architecture: 'x64' },
      grant: { id: 'm3-native-strings', classes: ['read-source'] },
      budget,
      resolveInput: createFilesystemInputResolver({
        primaryPath: path,
        roots: [directory],
        inventory,
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
    if (opened.state !== 'opened') throw new Error(`${kind} fixture failed to open`)
    try {
      expect(opened.selected.contributionId).toBe(`blizzard/${kind}`)
      const output = await opened.session
        .operations()
        .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
      if (output.state !== 'ok' || output.output.kind !== 'bytes') throw new Error('no UVM export')
      return readUvmContainer(output.output.value, limits)
    } finally {
      await opened.session.dispose()
    }
  } finally {
    const child = relative(tmpdir(), directory)
    if (
      child.startsWith('..') ||
      isAbsolute(child) ||
      !basename(directory).startsWith('m3-uvm-strings-')
    )
      throw new Error('invalid scratch path')
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

function at(value: unknown, path: string): unknown {
  let current = value
  for (const key of path.split('/').filter(Boolean)) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function texturePaths(document: unknown): string[] {
  const result: string[] = []
  const visit = (value: unknown, path: string) => {
    if (Array.isArray(value)) return value.forEach((item, index) => visit(item, `${path}/${index}`))
    if (value === null || typeof value !== 'object') return
    for (const [key, item] of Object.entries(value)) {
      const next = `${path}/${key}`
      if (key === 'texturePath' && typeof item === 'string' && item.length > 0) result.push(next)
      visit(item, next)
    }
  }
  visit(document, '')
  return result
}

function stringPaths(document: unknown, expected: string): string[] {
  const result: string[] = []
  const visit = (value: unknown, path: string) => {
    if (value === expected) {
      result.push(path)
      return
    }
    if (Array.isArray(value)) return value.forEach((item, index) => visit(item, `${path}/${index}`))
    if (value === null || typeof value !== 'object') return
    for (const [key, item] of Object.entries(value)) visit(item, `${path}/${key}`)
  }
  visit(document, '')
  return result
}

it('round-trips a canonical UVM texture path through fresh M3', async () => {
  const container = await ordinaryUvm(await nativeFixture('m3'), 'm3')
  const extras = container.document['extras']
  const residual = extras !== null && typeof extras === 'object' && !Array.isArray(extras)
    ? (extras as Record<string, unknown>)['BlizzardM3']
    : undefined
  expect(residual !== null && typeof residual === 'object' && !Array.isArray(residual) ? (residual as Record<string, unknown>)['source'] : undefined).toBeUndefined()
  const path = texturePaths(container.document)[0]
  if (path === undefined) throw new Error('texture path absent')
  const original = at(container.document, path)
  if (typeof original !== 'string') throw new Error('texture value absent')
  const name = 'Assets/Textures/New/Harbinger_UVM_Roundtrip_Diffuse.dds'
  const encoded = await exportM3FromUvm(
    edit(
      container,
      stringPaths(container.document, original).map(path => ({ op: 'replace', path, value: name })),
    ),
    limits,
  )
  const reopened = await ordinaryUvm(encoded, 'm3')
  expect(texturePaths(reopened.document).length).toBeGreaterThan(0)
  expect(JSON.stringify(reopened.document)).toContain(name)
}, 60_000)

it('round-trips a canonical UVM animation name through fresh standalone M3A', async () => {
  const container = await ordinaryUvm(await nativeFixture('m3a'), 'm3a')
  const animations = container.document['animations']
  const original = Array.isArray(animations) && animations[0] !== null && typeof animations[0] === 'object' && !Array.isArray(animations[0])
    ? animations[0]['name']
    : undefined
  if (typeof original !== 'string') throw new Error('animation name absent')
  const name = 'Cybros_UVM_Renamed'
  const encoded = await exportM3FromUvm(
    edit(
      container,
      stringPaths(container.document, original).map(path => ({ op: 'replace', path, value: name })),
    ),
    limits,
  )
  const reopened = await ordinaryUvm(encoded, 'm3a')
  const reopenedAnimations = reopened.document['animations']
  expect(Array.isArray(reopenedAnimations) && reopenedAnimations[0] !== null && typeof reopenedAnimations[0] === 'object' && !Array.isArray(reopenedAnimations[0]) ? reopenedAnimations[0]['name'] : undefined).toBe(name)
}, 60_000)

it('rejects absolute texture paths and unrelated document metadata', async () => {
  const container = await ordinaryUvm(await nativeFixture('m3'), 'm3')
  const path = texturePaths(container.document)[0]
  if (path === undefined) throw new Error('texture path absent')
  const original = at(container.document, path)
  if (typeof original !== 'string') throw new Error('texture value absent')
  await expect(
    exportM3FromUvm(
      edit(
        container,
        stringPaths(container.document, original).map(path => ({
          op: 'replace',
          path,
          value: 'C:/outside.dds',
        })),
      ),
      limits,
    ),
  ).rejects.toThrow(/portable asset reference/iu)
  await expect(
    exportM3FromUvm(
      edit(container, [{ op: 'add', path: '/extras/ForeignMetadata', value: true }]),
      limits,
    ),
  ).rejects.toThrow(/extras/u)
}, 60_000)
