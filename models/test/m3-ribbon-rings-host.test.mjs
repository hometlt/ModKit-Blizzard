import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join, dirname, basename, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildInventory,
  createHostContributionContractRegistry,
  createExecutionBackendRegistry,
  linkedExtensionInputs,
  linkedInProcessBackend,
  openSubject,
  createBundledServiceDefinitionRegistry,
  registerServiceDefinitionsOrThrow,
  createHostServiceResolver,
} from '@modkit/host'
import {
  loadExtensionDirectory,
  openFileArtifactSource,
  createFilesystemInputResolver,
} from '@modkit/host/node'
import { sceneModule } from '@modkit/scene/module'
import { renderUvm } from '@modkit/scene/uvm/render'
import { readUvmContainer, writeUvmContainer } from '@modkit/uv/model/container'
import { readUvmAnimationClips } from '@modkit/uv/model/animation-clips'
import { createM3RibbonRingsFixture } from './fixtures/m3-ribbon-rings.fixture.mjs'
const budget = {
    maxInputBytes: 64000000n,
    maxScalarBytes: 64000000,
    maxNodes: 1000000,
    maxDepth: 128,
    maxDiagnostics: 1000,
  },
  grant = { id: 'effect-shading-host', classes: ['read-source'] },
  target = {
    environment: 'node',
    operatingSystem: 'windows',
    architecture: 'x64',
  }
test('native RIB_ planar/cylinder/star declarations reach shared complete ring geometry and per-point RGBA', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'modkit-m3-ribbon-rings-'))
  try {
    const bytes = await createM3RibbonRingsFixture(),
      primaryPath = join(directory, 'Shading.m3')
    await writeFile(primaryPath, bytes, { flag: 'wx' })
    const source = await openFileArtifactSource(primaryPath),
      linked = linkedExtensionInputs([sceneModule]),
      backends = createExecutionBackendRegistry([linkedInProcessBackend(linked.modules)]),
      inventory = await buildInventory(
        [
          ...linked.inputs,
          {
            ...(await loadExtensionDirectory(join(import.meta.dirname, '..'))),
            execution: { origin: 'bundled', allowTrustedInProcess: true },
          },
        ],
        createHostContributionContractRegistry(),
      ),
      definitions = createBundledServiceDefinitionRegistry()
    await registerServiceDefinitionsOrThrow(inventory, definitions)
    const opened = await openSubject({
      inventory,
      source,
      path: primaryPath,
      intent: 'full',
      target,
      grant,
      budget,
      executionBackends: backends,
      serviceDefinitions: definitions,
      resolveInput: createFilesystemInputResolver({
        primaryPath,
        roots: [directory],
        inventory,
      }),
    })
    if (opened.state !== 'opened') throw new Error(`M3 collision open refused: ${opened.reason}`)
    try {
      const converted = await opened.session.operations().invoke('model-export-uvm', {
        schemaVersion: 1,
        metersPerSourceUnit: 1,
      })
      assert.equal(converted.state, 'ok')
      assert.equal(converted.output.kind, 'bytes')
      const container = readUvmContainer(converted.output.value),
        nativeEffects = container.document.extensions.UV_game_effects
      const document = container.document
      assert.deepEqual(
        nativeEffects.ribbons.map(value => value.ribbonType),
        ['planar', 'cylinder', 'star'],
      )
      assert(
        nativeEffects.ribbons.every(
          value => value.emissionRate === 10 && value.lifeSpan === 2 && value.speed === 1,
        ),
      )
      const services = createHostServiceResolver({
        inventory,
        definitions,
        executionBackends: backends,
        target,
        grant,
        budgets: budget,
      })
      let captured, rendered
      const contracts = {
        async resolve(request) {
          const lease = await services.port.resolve(request)
          return {
            ...lease,
            value: {
              ...lease.value,
              async render(request) {
                captured = request
                rendered = await lease.value.render(request)
                return rendered
              },
            },
          }
        },
      }
      const clip = readUvmAnimationClips(document)?.[0],
        identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
      const request = {
        schemaVersion: 1,
        viewport: { width: 32, height: 32 },
        camera: { viewProjection: identity, viewMatrix: identity },
        time: 0.8,
        rendererId: 'modkit.headless',
        ...(clip === undefined ? {} : { clipId: clip.id }),
      }
      const result = await renderUvm(writeUvmContainer(container), request, {
        contracts,
        budget,
      })
      const close = (actual, expected) => {
        assert.equal(actual.length, expected.length)
        for (let i = 0; i < actual.length; i++)
          assert(
            Math.abs(actual[i] - expected[i]) < 1e-5,
            `component ${i}: ${actual[i]} != ${expected[i]}`,
          )
      }
      const ribbons = captured.scene.primitives.filter(primitive =>
        primitive.id.startsWith('uvm-effect-ribbon-'),
      )
      assert.equal(ribbons.length, 3)
      for (const [index, primitive] of ribbons.entries()) {
        const ring = [2, 4, 7][index],
          points = 8,
          positions = [],
          colors = [],
          uv = [],
          indices = []
        for (let point = 0; point < points; point++) {
          const age = 0.7 - point * 0.1,
            phase = age / 2,
            t = phase / 0.5
          for (let cross = 0; cross < ring; cross++) {
            if (ring === 2) positions.push(0, cross === 0 ? 0.5 : -0.5, age)
            else {
              const angle = (cross / (ring - 1)) * Math.PI * 2,
                scale = index === 2 && cross % 2 === 1 ? 0.25 : 1
              positions.push(Math.cos(angle) * 0.5 * scale, Math.sin(angle) * 0.5 * scale, age)
            }
            colors.push(1 - t, t, 0, 1 + (128 / 255 - 1) * t)
            uv.push(cross / (ring - 1), point / (points - 1))
          }
          if (point > 0)
            for (let edge = 0; edge < ring - 1; edge++) {
              const a = (point - 1) * ring + edge,
                b = point * ring + edge
              indices.push(a, a + 1, b + 1, a, b + 1, b)
            }
        }
        close(primitive.positions, positions)
        close(primitive.colors, colors)
        close(primitive.textureCoordinates, uv)
        assert.deepEqual([...primitive.indices], indices)
        assert.deepEqual(
          captured.scene.materials.find(value => value.id === primitive.materialId).baseColor,
          [1, 1, 1, 1],
        )
      }
      assert(!result.diagnostics.some(item => item.severity === 'error'))
    } finally {
      await opened.session.dispose()
    }
  } finally {
    const cleanup = resolve(directory)
    if (
      dirname(cleanup) !== resolve(tmpdir()) ||
      !basename(cleanup).startsWith('modkit-m3-ribbon-rings-')
    )
      throw new Error('unexpected collision fixture cleanup path')
    await rm(cleanup, { recursive: true, force: true })
  }
})
