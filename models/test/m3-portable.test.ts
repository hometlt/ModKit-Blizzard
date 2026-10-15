import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { findModkitCoreWorkspace } from './workspace-root.js'
import {
  portableBrowserWorker,
  type PortableBrowserWorker,
} from './helpers/portable-browser-worker.js'

const coreRoot = findModkitCoreWorkspace(import.meta.dirname)
const results = new Map<string, Record<string, unknown>>()
const portableManifests = new Map<string, Record<string, unknown>>()
let worker: PortableBrowserWorker | undefined
let operations: readonly Record<string, unknown>[] = []
const evidence = process.env['MODKIT_M3_PORTABLE_EVIDENCE_DIR']

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('portable proof object is absent')
  return value as Record<string, unknown>
}
function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError('portable proof list is absent')
  return value
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new TypeError('portable proof value is absent')
  return value
}
function result(name: string): Record<string, unknown> {
  return required(results.get(name))
}
function bytes(value: unknown): Uint8Array {
  return Uint8Array.from(
    list(value).map(item => {
      if (typeof item !== 'number' || !Number.isInteger(item) || item < 0 || item > 255)
        throw new TypeError('portable proof byte is invalid')
      return item
    }),
  )
}
const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
async function artifact(name: string, value: string | Uint8Array) {
  if (evidence === undefined) return
  await mkdir(evidence, { recursive: true })
  await writeFile(join(evidence, `m3-portable-browser-${name}`), value, { flag: 'wx' })
}
async function capture(name: string, input: object) {
  const output = object(await required(worker).call(input))
  results.set(name, output)
  await artifact(`${name}.json`, `${JSON.stringify(output, null, 2)}\n`)
  return output
}

beforeAll(async () => {
  const manifest = object(
    JSON.parse(await readFile(new URL('../codecs/m3/codec.json', import.meta.url), 'utf8')),
  )
  operations = list(object(manifest['spec'])['operations']).map(object)
  for (const [name, path] of [
    ['codec-m3a', '../codecs/m3a/codec.json'],
    ['writer-m3', '../providers/m3-writer/provider.json'],
  ] as const) {
    portableManifests.set(
      name,
      object(JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'))),
    )
  }
  const fixture = async (url: URL | string, expected: string) => {
    const stored = await readFile(url)
    const value =
      typeof url !== 'string' && url.pathname.endsWith('.b64')
        ? Uint8Array.from(Buffer.from(stored.toString().trim(), 'base64'))
        : Uint8Array.from(stored)
    expect(sha256(value)).toBe(expected)
    return Array.from(value)
  }
  const fixtures = {
    triangle: await fixture(
      join(coreRoot, 'packages/testkit/test/fixtures/models/triangle.m3'),
      'd34480c1b726c37bfeea9dd75fc71a13ca7e47d6ff15b2d66487c6a4b3369de7',
    ),
    native: await fixture(
      new URL('./fixtures/m3/model.m3', import.meta.url),
      'a9a126d0a2b7b54bc6ac70948a40bf34bd26260f063af498cc94ff3d9a528cda',
    ),
    m3a: await fixture(
      new URL('./fixtures/m3/cybros-cover.m3a.b64', import.meta.url),
      '07a632fb165b98e60b0e6803451e92c7d94ec527cae8252ca6ed2a3a0661b9e5',
    ),
  }
  worker = await portableBrowserWorker({
    coreRoot,
    entrypoint: join(import.meta.dirname, 'fixtures/m3-portable-worker.mjs'),
  })
  await artifact('bundle.js', worker.bundle)
  await artifact('metafile.json', `${JSON.stringify(worker.metafile, null, 2)}\n`)
  // This hook includes the real cold browser, module, parser, writer and PNG encoder startup.
  // Tests below assert one captured run; no retries and no hidden Node-side decoder fallback.
  await capture('setup', { action: 'setup', fixtures })
  await capture('m3-facets', { action: 'inspect' })
  await capture('m3-native-edit', { action: 'native-edit' })
  for (const [name, handler] of [
    ['inspect', 'inspect'],
    ['validate', 'validate'],
    ['raw', 'export-raw'],
  ] as const)
    await capture(name, { action: 'operation', handler })
  await capture('write', { action: 'write', fixture: 'triangle' })
  await capture('convert', { action: 'convert', fixture: 'native' })
  await capture('edit', { action: 'edit', fixture: 'neutral' })
  await capture('render', { action: 'render', fixture: 'neutral' })
  await capture('m3a-facets', { action: 'inspect', fixture: 'm3a' })
  await capture('m3a-native-edit', { action: 'native-edit', fixture: 'm3a' })
  await capture('m3a-convert', { action: 'convert', fixture: 'm3a' })
  await capture('m3a-edit', { action: 'unsupported-edit', fixture: 'm3a' })
  await capture('writer-m3', { action: 'writer-provider', fixture: 'native' })
  await capture('writer-m3a', { action: 'writer-provider', fixture: 'm3a' })
}, 60000)

afterAll(async () => {
  await worker?.close()
})

it('bundles the actual M3/M3A/writer and common scene modules without Node imports and runs in a real isolated worker', async () => {
  const built = required(worker)
  const inputs = Object.keys(built.metafile.inputs).map(path => path.replaceAll('\\', '/'))
  for (const suffix of [
    'src/m3/codec.js',
    'src/m3/codec-m3a.js',
    'src/m3/writer.js',
    'dist/m3/structures.generated.js',
  ])
    expect(
      inputs.some(path => path.endsWith(suffix)),
      suffix,
    ).toBe(true)
  expect(
    inputs.some(path => path.includes('@modkit/scene') && path.endsWith('/render/headless.js')),
  ).toBe(true)
  expect(Object.values(built.metafile.outputs).every(output => output.imports.length === 0)).toBe(
    true,
  )
  for (const [name, entrypoint] of [
    ['codec-m3a', './codecs/m3a/runtime.browser.js'],
    ['writer-m3', './providers/m3-writer/runtime.browser.js'],
  ] as const) {
    const variants = list(required(portableManifests.get(name))['runtimeVariants'])
      .map(object)
      .filter(variant => variant['executionProfile'] === 'worker-brokered')
    expect(variants, name).toHaveLength(1)
    const variant = required(variants[0])
    expect(variant['entrypoint']).toBe(entrypoint)
    expect([...list(object(variant['target'])['environments'])].sort()).toEqual([
      'browser-worker',
      'node-worker',
    ])
  }
  for (const [name, output] of results) {
    expect(output['isolation'], name).toEqual({
      process: 'undefined',
      require: 'undefined',
      Buffer: 'undefined',
      document: 'undefined',
      dedicatedWorker: true,
      secureContext: true,
      webCrypto: 'function',
    })
    expect(output['sourceLeases'], name).toBe(0)
  }
  await artifact(
    'isolation-proof.json',
    `${JSON.stringify(
      {
        bundleSha256: sha256(built.bundle),
        importedFiles: inputs.length,
        runtime: result('setup')['isolation'],
        boundary:
          'Actual Dedicated Worker; explicit common renderer broker; browser host inventory/activation is not exercised.',
      },
      null,
      2,
    )}\n`,
  )
})

it('executes all eight declared M3 operations and reads geometry, animation, skeleton, materials and texture references', async () => {
  expect(operations.map(operation => operation['id']).sort()).toEqual([
    'asset.validate',
    'edit.field',
    'export.raw',
    'model.edit',
    'model.export-uvm',
    'model.render',
    'model.write',
    'view.inspect',
  ])
  const read = result('m3-facets'),
    descriptor = object(read['descriptor'])
  expect(object(descriptor['identity'])['codecId']).toBe('blizzard/m3')
  for (const operation of operations)
    expect(list(descriptor['operations'])).toContainEqual(
      expect.objectContaining({ id: operation['id'], state: 'available' }),
    )
  const traits = list(descriptor['traits']).map(item => object(item)['id'])
  for (const trait of [
    'model.animations',
    'model.geometry',
    'model.materials',
    'model.skeleton',
    'model.textures',
  ])
    expect(traits).toContain(trait)
  const scene = object(read['scene']),
    primitive = object(list(scene['primitives'])[0])
  expect(object(scene['info'])).toMatchObject({
    geometryAccess: 'decoded',
    meshes: 1,
    primitives: 1,
    materials: 1,
  })
  expect(primitive['indices']).toEqual([0, 1, 2])
  for (const key of ['positions', 'normals', 'tangents', 'boneIndices', 'boneWeights'])
    expect(list(primitive[key]).length, key).toBeGreaterThan(0)
  expect(list(read['skeleton'])).toContainEqual(
    expect.objectContaining({ boneName: 'PortableRoot' }),
  )
  const clip = object(list(read['animations'])[0])
  expect(clip).toMatchObject({ name: 'PortableWalk', kind: 'animation', durationSeconds: 1 })
  expect(list(clip['channels']).some(channel => list(object(channel)['samples']).length > 1)).toBe(
    true,
  )
  expect(list(read['materials'])).toContainEqual(
    expect.objectContaining({
      name: 'PortableHull',
      shader: expect.objectContaining({ id: 'modkit.render-material.v1' }),
    }),
  )
  expect(list(read['textures'])).toContainEqual(
    expect.objectContaining({
      id: 'Assets/PortableHull.dds',
      role: 'texture',
      provenance: 'reference-only',
    }),
  )

  expect(object(result('inspect')['result'])['kind']).toBe('json')
  expect(Object.keys(object(object(result('inspect')['result'])['value'])).length).toBeGreaterThan(
    0,
  )
  expect(object(result('validate')['result'])['kind']).toBe('none')
  expect(object(result('raw')['result'])['kind']).toBe('bytes')
  expect(bytes(object(result('raw')['result'])['value'])).toEqual(bytes(result('raw')['source']))
  for (const name of ['m3-facets', 'm3a-facets']) {
    const tree = object(result(name)['nativeTree'])
    expect(list(tree['branches']).map(item => object(item)['label'])).toEqual([
      'Header',
      'Sections',
      'Raw native bytes',
    ])
    expect(object(tree['row'])).toMatchObject({
      semanticPath: ['raw', '0'],
      editable: { write: { operation: 'edit.field' } },
    })
  }
  for (const name of ['m3-native-edit', 'm3a-native-edit']) {
    expect(bytes(result(name)['after'])).not.toEqual(bytes(result(name)['before']))
    expect(object(object(result(name)['tree'])['row'])).toMatchObject({
      editable: { write: { operation: 'edit.field' } },
    })
  }
  expect(bytes(result('write')['bytes'])).toEqual(bytes(result('write')['repeat']))
  expect(new TextDecoder().decode(bytes(result('write')['bytes']).subarray(0, 4))).toBe('43DM')
  expect(object(list(object(result('write')['scene'])['primitives'])[0])['indices']).toEqual([
    0, 1, 2,
  ])
  expect(new TextDecoder().decode(bytes(result('convert')['native']).subarray(0, 4))).toBe('43DM')
  const native = object(object(object(result('convert')['document'])['extras'])['BlizzardM3'])
  expect(native['schemaVersion']).toBe(1)
  expect(native['source']).toBeUndefined()
  expect(Object.keys(object(native['residual'])).length).toBeGreaterThan(0)
  const edit = result('edit'),
    plan = object(edit['plan'])
  expect(bytes(edit['after'])).not.toEqual(bytes(edit['before']))
  expect(object(edit['standard'])['specularity']).toBe(23)
  expect(list(plan['targets'])).toContainEqual(
    expect.objectContaining({
      targetId: 'content',
      expectedRevision: expect.objectContaining({ bindings: { content: edit['sourceRevision'] } }),
    }),
  )
  expect(list(plan['edits'])).toHaveLength(1)

  const rendered = result('render'),
    output = object(rendered['result']),
    broker = object(rendered['broker'])
  const png = bytes(output['value'])
  expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  expect(png).toEqual(bytes(rendered['expectedPng']))
  expect(broker['requests']).toEqual([
    {
      contract: 'common.render/scene-3d',
      major: 1,
      facet: { outputKind: 'rgba8', rendererId: 'modkit.headless' },
    },
  ])
  expect(broker).toMatchObject({ acquired: 1, released: 1 })
  const frame = object(list(broker['frames'])[0])
  expect(object(frame['statistics'])['fragments']).toBeGreaterThan(0)
  expect(
    list(frame['rgba']).filter((value, index) => index % 4 === 3 && value !== 0).length,
  ).toBeGreaterThan(0)
  await artifact('frame.png', png)
})

it('decodes standalone M3A and freshly re-encodes native bytes from source-free UVM through the real writer-provider while refusing an absent material edit', () => {
  const read = result('m3a-facets'),
    descriptor = object(read['descriptor'])
  expect(object(descriptor['identity'])['codecId']).toBe('blizzard/m3a')
  expect(object(object(read['scene'])['info'])).toMatchObject({
    meshes: 0,
    primitives: 0,
    materials: 0,
  })
  expect(list(read['animations']).length).toBeGreaterThan(0)
  expect(list(read['skeleton']).length).toBeGreaterThan(0)
  const converted = result('m3a-convert'),
    document = object(converted['document'])
  expect(new TextDecoder().decode(bytes(converted['native']).subarray(0, 4))).toBe('43DM')
  const residual = object(object(document['extras'])['BlizzardM3'])
  expect(residual['schemaVersion']).toBe(1)
  expect(residual['source']).toBeUndefined()
  expect(residual['format']).toBe('m3a')
  expect(
    list(object(object(document['extensions'])['UV_game_animation_clips'])['clips']).length,
  ).toBe(list(read['animations']).length)
  const refused = result('m3a-edit')
  expect(list(object(refused['descriptor'])['operations'])).toContainEqual(
    expect.objectContaining({ id: 'model.edit', state: 'available' }),
  )
  expect(object(refused['refusal'])['message']).toMatch(
    /JSON Pointer (?:array index is out of bounds|target does not exist)/u,
  )
  for (const name of ['writer-m3', 'writer-m3a']) {
    const value = result(name),
      plan = object(value['plan'])
    expect(value['validation']).toEqual({ valid: true, diagnostics: [] })
    expect(object(value['invalid'])['valid']).toBe(false)
    expect(JSON.stringify(object(value['invalid'])['diagnostics'])).toContain('sourceContentDigest')
    expect(list(plan['edits'])).toHaveLength(1)
    expect(bytes(object(object(list(plan['edits'])[0])['payload'])['bytes'])).toEqual(
      bytes(value['source']),
    )
    expect(list(plan['targets'])).toContainEqual(
      expect.objectContaining({
        targetId: 'content',
        expectedRevision: { sourceRevision: value['sourceRevision'] },
      }),
    )
  }
})
