// Ordinary-host acceptance for source-free M3 UVM residuals.
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative } from 'node:path'
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
import { readUvmContainer } from '@modkit/uv/model/container'
import { exportM3FromUvm } from '../dist/m3/uvm/converter.js'
import { M3SectionList } from '../dist/m3/native/binary/sections.js'
import { createMetadataBuilderFixture } from './fixtures/metadata-builders.mjs'

const budget = {
  maxInputBytes: 67_108_864n,
  maxScalarBytes: 67_108_864,
  maxNodes: 1_000_000,
  maxDepth: 128,
  maxDiagnostics: 1000,
}
const limits = { ...budget, maxInputBytes: Number(budget.maxInputBytes), maxJsonBytes: budget.maxScalarBytes }
const executionBackends = createExecutionBackendRegistry([{
  profile: 'trusted-in-process',
  supports: (_target, variant) => variant.executionProfile === 'trusted-in-process',
  async activate(context) {
    return { module: await import(context.entrypoint.href), release: async () => undefined }
  },
}])

for (const profile of ['solvers', 'physics']) {
  test(`ordinary host exports ${profile} through source-free BlizzardM3`, async () => {
    const [base, schema] = await Promise.all([
      readFile(new URL('./fixtures/m3/model.m3', import.meta.url)),
      readFile(new URL('../src/m3/native/structures.xml', import.meta.url), 'utf8'),
    ])
    const { bytes } = await createMetadataBuilderFixture(base, schema, profile)
    const inventory = await buildInventory(
      [{
        ...(await loadExtensionDirectory(join(import.meta.dirname, '..'))),
        execution: { origin: 'bundled', allowTrustedInProcess: true },
      }],
      createHostContributionContractRegistry(),
    )
    const directory = await mkdtemp(join(tmpdir(), 'm3-source-free-'))
    let opened
    try {
      const path = join(directory, `${profile}.m3`)
      await writeFile(path, bytes)
      opened = await openSubject({
        inventory,
        source: await openFileArtifactSource(path),
        path,
        intent: 'full',
        grant: { id: 'source-free-read', classes: ['read-source'] },
        budget,
        executionBackends,
        target: {
          environment: 'node',
          operatingSystem: { win32: 'windows', linux: 'linux', darwin: 'macos' }[process.platform],
          architecture: process.arch,
        },
        resolveInput: createFilesystemInputResolver({ primaryPath: path, roots: [directory], inventory }),
      })
      assert.equal(opened.state, 'opened')
      const output = await opened.session.operations().invoke('model-export-uvm', {
        schemaVersion: 1,
        metersPerSourceUnit: 1,
      })
      assert.equal(output.state, 'ok')
      assert.equal(output.output.kind, 'bytes')
      const container = readUvmContainer(output.output.value, limits)
      assert.equal(container.document.extensions?.UV_source_blob, undefined)
      const residual = container.document.extras?.BlizzardM3
      assert.equal(residual?.schemaVersion, 1)
      assert.equal(residual?.format, 'm3')
      assert.equal(residual?.source, undefined)
      assert.equal(residual?.metadata?.sections, undefined)
      const canonical = await exportM3FromUvm(container, limits)
      assert.deepEqual([...canonical.subarray(0, 4)], [0x34, 0x33, 0x44, 0x4d])
      const reopened = await M3SectionList.load(
        canonical.slice().buffer,
        schema,
      )
      assert.ok(reopened.model)

      const evidenceDirectory = process.env.MODKIT_A6_SCHEMA_EVIDENCE_DIR
      if (evidenceDirectory) {
        await mkdir(evidenceDirectory, { recursive: true })
        await writeFile(
          join(evidenceDirectory, `${profile}.source-free.json`),
          `${JSON.stringify({
            schemaVersion: 1,
            route: 'ordinary host open -> model-export-uvm -> common UVM + BlizzardM3 residual -> M3',
            fixtureKind: 'authored-synthetic-native-M3',
            sourceBytesEmbedded: false,
            canonicalNativeOutput: true,
          }, null, 2)}\n`,
        )
      }
    } finally {
      if (opened?.state === 'opened') await opened.session.dispose()
      const child = relative(tmpdir(), directory)
      if (!child || child.startsWith('..') || isAbsolute(child) || !basename(directory).startsWith('m3-source-free-'))
        throw new Error('unsafe source-free fixture scratch path')
      await rm(directory, { recursive: true, force: true })
    }
  })
}
