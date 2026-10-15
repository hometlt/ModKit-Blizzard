import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { it, expect } from 'vitest'
import { buildInventory, createBundledServiceDefinitionRegistry, createExecutionBackendRegistry, createHostContributionContractRegistry, createHostServiceResolver, linkedExtensionInputs, linkedInProcessBackend, openSubject, registerServiceDefinitionsOrThrow } from '@modkit/host'
import { loadExtensionDirectory, createFilesystemInputResolver, openFileArtifactSource } from '@modkit/host/node'
import { sceneModule } from '@modkit/scene/module'
import { readUvmModel } from '@modkit/scene/uvm/model'
import { createModelSceneSampler } from '@modkit/scene/model'
import { readUvmContainer, writeUvmContainer } from '@modkit/uv/model/container'
import { renderUvm } from '@modkit/scene/uvm/render'
import { encodeRgbaPng } from '@modkit/scene/output/png'
import { findModkitCoreWorkspace } from './workspace-root.js'
import { camera } from './uvm-conversion-render.js'
import type { JsonObject } from '@modkit/sdk'

// Run acquisition first: no direct installation/MPQ/CASC data access in this codec proof.
it.skipIf(process.env.MODKIT_WATER_EFFECTS_RENDER !== '1')('renders the resolved water effect assets with the M3 codec', async () => {
  const root = resolve('../artifacts/water-effects/assets')
  const out = resolve('../artifacts/water-effects/codec')
  const receipt = JSON.parse(await readFile(join(root, 'receipt.json'), 'utf8'))
  const core = findModkitCoreWorkspace(import.meta.dirname)
  const linked = linkedExtensionInputs([sceneModule])
  const inventory = await buildInventory([
    ...linked.inputs,
    ...await Promise.all([resolve('models'), join(core, 'extensions/images'), join(core, 'extensions/models')].map(async directory => ({ ...await loadExtensionDirectory(directory), execution: { origin: 'bundled' as const, allowTrustedInProcess: true } }))),
  ], createHostContributionContractRegistry())
  const serviceDefinitions = createBundledServiceDefinitionRegistry()
  await registerServiceDefinitionsOrThrow(inventory, serviceDefinitions)
  const budget = { maxInputBytes: 268_435_456n, maxDepth: 128, maxNodes: 8_000_000, maxScalarBytes: 268_435_456, maxDiagnostics: 1000 }
  await mkdir(out, { recursive: true })
  const evidence = []
  for (const logical of receipt.models) {
    const path = join(root, logical.split('/').at(-1)!)
    const opened = await openSubject({
      inventory, source: await openFileArtifactSource(join(root, logical)), path,
      target: { environment: 'node', operatingSystem: 'windows', architecture: 'x64' },
      grant: { id: 'water-effects-codec-proof', classes: ['read-source'] }, budget, intent: 'full',
      executionBackends: createExecutionBackendRegistry([linkedInProcessBackend(linked.modules)]), serviceDefinitions,
      resolveInput: createFilesystemInputResolver({ primaryPath: path, roots: [root], inventory }),
    })
    if (opened.state !== 'opened') throw new Error(JSON.stringify(opened.diagnostics))
    try {
      const invoke = async (handler: string, input: JsonObject) => {
        const result = await opened.session.operations().invoke(handler, input)
        if (result.state !== 'ok' || result.output.kind !== 'bytes') throw new Error(JSON.stringify(result))
        return { bytes: result.output.value, diagnostics: result.diagnostics }
      }
      const exported = await invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
      const container = readUvmContainer(exported.bytes)
      const { document, binary } = container
      const { scene, rig } = readUvmModel(document, binary, budget)
      const sampler = createModelSceneSampler({ ...scene, skeleton: rig.bindings, nodePoses: rig.nodePoses }, { maxBytes: budget.maxScalarBytes, clip: rig.clips[0] })
      const primitives = sampler.sample(0).primitives
      const bounds = [0, 2, 4].flatMap(time => sampler.sample(time).primitives)
      const viewProjection = Array.from(camera(bounds), (value, index) => index % 4 === 2 ? -value * 0.8 : index % 4 < 2 ? value * 0.8 : value)
      const viewMatrix = [0.70710678,-0.40824829,0.57735027,0,0,0.81649658,0.57735027,0,-0.70710678,-0.40824829,0.57735027,0,0,0,0,1]
      const stem = logical.split('/').at(-1)!.replace(/\.m3$/iu, '')
      await writeFile(join(out, `${stem}.uvm.glb`), exported.bytes)
      await writeFile(join(out, `${stem}.materials.json`), JSON.stringify({ materials: (document as any).materials, extensions: (document as any).extensions }, null, 2))
      const frames = []
      const request = (time: number): JsonObject => ({ schemaVersion: 1, metersPerSourceUnit: 1, viewport: { width: 512, height: 512 }, camera: { viewProjection, viewMatrix }, clearColor: [0.16,0.24,0.24,1], rendererId: 'modkit.headless', collisions: false, time, clipId: rig.clips[0]!.id, materialContext: { teamColorIntensity: 0 } })
      for (const time of [0, 2, 4]) {
        const frame = await invoke('render-m3-scene', request(time))
        const file = `${stem}.t${time}.png`
        await writeFile(join(out, file), frame.bytes)
        frames.push({ file, diagnostics: [...new Set(frame.diagnostics.map(x => `${x.code}: ${x.message}`))] })
        expect(frame.diagnostics.filter(x => /resource-not-found/u.test(x.code) || (/texture-unresolved/u.test(x.code) && !/uvm-effect-particle/u.test(x.message)))).toEqual([])
      }
      // Controlled data-only ablations. These are not production renderer fixes or engine oracles.
      const services = createHostServiceResolver({ inventory, definitions: serviceDefinitions, executionBackends: createExecutionBackendRegistry([linkedInProcessBackend(linked.modules)]), target: { environment: 'node', operatingSystem: 'windows', architecture: 'x64' }, grant: { id: 'water-effect-ablation', classes: ['read-source'] }, budgets: budget })
      const experiments = []
      try {
        const edited = structuredClone(document) as any
        const label = stem === 'Elsecaro_Waves' ? 'no-projectors' : 'surface-only'
        if (label === 'no-projectors') edited.extensions.UV_game_effects.projectors = []
        else for (const material of edited.materials) {
          const model = material.extensions?.UV_game_material?.params?.renderModel
          if (model?.composite) model.composite.passes = model.composite.passes.slice(0, 1)
        }
        const { metersPerSourceUnit, ...input } = request(2)
        void metersPerSourceUnit
        const frame = await renderUvm(writeUvmContainer({ ...container, document: edited }), input, { contracts: services.port, budget, rasterResources: opened.rasterResources })
        const file = `${stem}.${label}.t2.png`
        await writeFile(join(out, file), await encodeRgbaPng(frame))
        experiments.push({ label, file, diagnostics: [...new Set(frame.diagnostics.map(x => `${x.code}: ${x.message}`))] })
      } finally { await services.release() }
      evidence.push({ logical, primitives: primitives.length, clips: rig.clips.map(x => ({ id: x.id, name: x.name, duration: x.durationSeconds })), exportDiagnostics: exported.diagnostics, frames, experiments })
      expect(primitives.length).toBeGreaterThan(0)
    } finally { await opened.session.dispose() }
  }
  await writeFile(join(out, 'receipt.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence.map(x => ({ logical: x.logical, primitives: x.primitives, frames: x.frames.map(x => ({ file: x.file, diagnosticCount: x.diagnostics.length })) }))))
}, 600_000)
