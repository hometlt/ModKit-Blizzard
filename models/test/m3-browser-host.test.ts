import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cpus, totalmem } from 'node:os'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { loadExtensionDirectory } from '@modkit/host/node'
import { findModkitCoreWorkspace } from './workspace-root.js'
import { portableBrowserWorker } from './helpers/portable-browser-worker.js'
import { createM3ModelParticleFixture } from './fixtures/m3-model-particles.fixture.mjs'

const coreRoot = findModkitCoreWorkspace(import.meta.dirname)
const modelsRoot = join(import.meta.dirname, '..')
const origin = 'http://127.0.0.1/'
const evidence = process.env['MODKIT_M3_BROWSER_HOST_EVIDENCE_DIR']
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('browser host evidence object is absent')
  return value as Record<string, unknown>
}
async function artifact(name: string, value: string | Uint8Array) {
  if (evidence === undefined) return
  await mkdir(evidence, { recursive: true })
  await writeFile(join(evidence, name), value, { flag: 'wx' })
}

it('activates M3/M3A through the real web host and commits a UVM edit to actual OPFS', async () => {
  const input = await loadExtensionDirectory(modelsRoot)
  const catalog = {
    schemaVersion: 1,
    extensions: [
      {
        name: 'models',
        source: 'blizzard/models',
        artifactRoot: './extensions/models/',
        containers: input.containers,
        files: input.files,
        documents: [...input.documents],
        documentDigests: [...input.documentDigests],
        artifact: {
          inventoryRecordId: input.artifact.inventoryRecordId,
          artifactDigest: input.artifact.artifactDigest,
          fileDigests: input.artifact.fileDigests,
        },
      },
    ],
    excluded: [],
  }
  const portableMeta = object(
    JSON.parse(await readFile(join(modelsRoot, 'dist/browser/bundle-metafile.json'), 'utf8')),
  )
  const assets = new Map<string, string | Uint8Array>()
  for (const path of Object.keys(object(portableMeta['outputs'])))
    assets.set(`${origin}extensions/models/${path}`, await readFile(join(modelsRoot, path)))
  for (const path of ['codecs/m3/runtime.browser.js', 'codecs/m3a/runtime.browser.js'])
    assets.set(`${origin}extensions/models/${path}`, await readFile(join(modelsRoot, path)))
  const workerBuild = await build({
    entryPoints: [join(coreRoot, 'packages/host/src/browser/worker-entry.ts')],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    write: false,
    metafile: true,
  })
  const workerEntry = workerBuild.outputFiles[0]
  if (workerEntry === undefined) throw new Error('production browser worker entry is absent')
  assets.set(`${origin}worker-entry.js`, workerEntry.text)
  const native = await readFile(
    new URL('./fixtures/m3/corpus/Harbinger.m3', import.meta.url),
  )
  const benchmarkSmall = await readFile(
    new URL('./fixtures/m3/model.m3', import.meta.url),
  )
  const benchmarkLarge = await readFile(
    new URL('./fixtures/m3/corpus/analysisterminal.m3', import.meta.url),
  )
  const m3a = Buffer.from(
    await readFile(new URL('./fixtures/m3/cybros-cover.m3a.b64', import.meta.url), 'utf8'),
    'base64',
  )
  expect(hash(native)).toBe('3a76330ab5126c26c303b50c47b1f957da09d62a1cbcf02ebbe82699e921809a')
  expect(hash(m3a)).toBe('07a632fb165b98e60b0e6803451e92c7d94ec527cae8252ca6ed2a3a0661b9e5')
  expect(hash(benchmarkSmall)).toBe(
    'a9a126d0a2b7b54bc6ac70948a40bf34bd26260f063af498cc94ff3d9a528cda',
  )
  expect(hash(benchmarkLarge)).toBe(
    '5dbc13ed236fd7fcd66191481901aa803ea6498cb3cae23d36f2f20d26986f90',
  )
  const page = await portableBrowserWorker({
    coreRoot,
    realm: 'page',
    assets,
    entrypoint: join(import.meta.dirname, 'fixtures/m3-browser-host.ts'),
    onConsole: message => {
      if (message.startsWith('[m3-host-stage]')) console.info(message)
    },
  })
  try {
    await artifact('catalog.json', JSON.stringify(catalog, null, 2))
    await artifact('page-metafile.json', JSON.stringify(page.metafile, null, 2))
    await artifact('worker-metafile.json', JSON.stringify(workerBuild.metafile, null, 2))
    await artifact('page-bundle.js', page.bundle)
    await artifact('page-styles.css', page.styles)
    await artifact('worker-entry.js', workerEntry.text)
    await artifact(
      'inputs.json',
      JSON.stringify(
        {
          native: hash(native),
          m3a: hash(m3a),
          benchmarkSmall: { bytes: benchmarkSmall.byteLength, sha256: hash(benchmarkSmall) },
          benchmarkLarge: { bytes: benchmarkLarge.byteLength, sha256: hash(benchmarkLarge) },
          performanceCorpus: [
            {
              role: 'small',
              path: 'models/test/fixtures/m3/model.m3',
              source: 'vendored repository fixture',
              format: 'M3',
              availability: 'committed',
              features: ['geometry', 'materials', 'skeleton', 'animation'],
              expectedLosses: [],
            },
            {
              role: 'large',
              path: 'models/test/fixtures/m3/corpus/analysisterminal.m3',
              source: 'vendored repository corpus',
              format: 'M3',
              availability: 'committed',
              features: ['geometry', 'materials', 'skeleton', 'animation'],
              expectedLosses: [],
            },
          ],
          assets: [...assets].map(([url, bytes]) => ({ url, sha256: hash(bytes) })),
        },
        null,
        2,
      ),
    )
    const result = object(
      await page.call({
        catalog,
        fixtures: {
          native: Array.from(native),
          m3a: Array.from(m3a),
          nestedParent: Array.from(await createM3ModelParticleFixture(['ParticleChild.m3'])),
          nestedChild: Array.from(native),
          benchmarkSmall: Array.from(benchmarkSmall),
          benchmarkLarge: Array.from(benchmarkLarge),
        },
      }),
    )
    result['benchmarkEnvironment'] = {
      capturedAt: new Date().toISOString(),
      operatingSystem: process.platform,
      architecture: process.arch,
      node: process.version,
      cpuModel: cpus()[0]?.model ?? 'unknown',
      logicalCpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      note: 'Timing and heap values are observational receipts, not universal FPS guarantees.',
    }
    await artifact('result.json', JSON.stringify(result, null, 2))
    expect(result['state']).toBe('passed')
    expect(result['runtime']).toEqual({
      secureContext: true,
      target: 'browser-worker',
      process: 'undefined',
      require: 'undefined',
      Buffer: 'undefined',
    })
    const model = object(result['m3'])
    expect(model['nestedModels']).toMatchObject({
      nativeChildResolved: true,
      sourceUnchanged: true,
    })
    expect(model['effectPixels']).toMatchObject({
      provider: 'modkit.browser-webgl',
      cases: 3,
      lightCases: 3,
      tintCases: 3,
      vertexColor: {
        expected: [128, 64, 32, 64],
        gpu: [128, 64, 32, 64],
        cpu: [128, 64, 32, 64],
      },
      standardMaterial: {
        gpu: [133, 133, 132, 255],
        cpu: [133, 133, 132, 255],
        gpuDiagnostics: [],
        cpuDiagnostics: [],
      },
    })
    const performanceReceipt = object(model['performanceReceipt'])
    expect(performanceReceipt).toMatchObject({
      schemaVersion: 1,
      renderer: 'modkit.browser-webgl',
      samples: { seek: 5, render: 3 },
    })
    for (const size of ['small', 'large']) {
      const measurement = object(performanceReceipt[size])
      expect(measurement['sourceBytes']).toBeGreaterThan(0)
      expect(measurement['initialLoadMs']).toBeGreaterThanOrEqual(0)
      expect(measurement['seekTimesMs']).toHaveLength(5)
      expect(measurement['renderTimesMs']).toHaveLength(3)
      expect(measurement['resourceRelease']).toEqual({
        disposeCompleted: true,
        sessionState: 'disposed',
      })
    }
    expect(model['editForm']).toEqual({
      formId: 'uvm-json-edit',
      operationId: 'model.edit',
      sourceUnchangedBeforeCommit: true,
      reopened: true,
      visibleVersionField: false,
    })
    expect(model['sourceHash']).toBe(hash(native))
    expect(model['editedHash']).not.toBe(model['sourceHash'])
    expect(model['historyHash']).not.toBe(model['editedHash'])
    expect(model['reopenedValue']).toBe(16)
    expect(model['historyValue']).toBe(32)
    expect(model['undo']).toBe('committed')
    expect(model['redo']).toBe('committed')
    expect(object(model['stale'])['failed']).toBe(true)
    const animation = object(result['m3a'])
    expect(animation['sourceHash']).toBe(hash(m3a))
    expect(animation['sourcePreserved']).toBe(true)
    expect(animation['unsupportedMaterialEdit']).toBe('rejected')
    expect(animation['renamed']).toBe(true)
    expect(animation['reopenedName']).toBe(animation['newName'])
    expect(animation['newName']).not.toBe(animation['originalName'])
    expect(animation['editedHash']).not.toBe(animation['sourceHash'])
    expect(animation['undo']).toBe('committed')
    expect(animation['redo']).toBe('committed')
    const diagnostics = result['diagnostics']
    if (!Array.isArray(diagnostics)) throw new TypeError('host diagnostics are absent')
    const activations = diagnostics
      .map(object)
      .filter(item => item['code'] === 'x3.host/worker-shared-origin')
    expect(activations.length).toBeGreaterThanOrEqual(2)
    expect(activations.every(item => String(item['message']).includes('0 unverified'))).toBe(true)
  } catch (error) {
    await artifact(
      'failure.json',
      JSON.stringify(
        {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        null,
        2,
      ),
    )
    throw error
  } finally {
    await page.close()
  }
  // Each reopen activates a fresh verified worker; this includes cold parser/module startup.
}, 180000)
