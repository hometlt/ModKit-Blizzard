import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  TRUSTED_IN_PROCESS_EXECUTION_BACKEND,
  analyzeResolvedDataWorkspace,
  buildInventory,
  createBundledServiceDefinitionRegistry,
  createExecutionBackendRegistry,
  createHostContributionContractRegistry,
  createHostServiceResolver,
  createModContextDataWorkspaceInputs,
  openNestedSubject,
  openSubject,
  registerServiceDefinitionsOrThrow,
  resolveContentLanguageSources,
} from '@modkit/host'
import { createContentSourceMapPreviewResourcePlanResolver, loadExtensionDirectory, openDirectoryArtifactSource, openFileArtifactSource, resolveContentSources } from '@modkit/host/node'
import { coordinateMapPreviewAssetSession } from '@modkit/host/maps'
import { mapQualificationTupleBytes, type WorldSceneSource } from '@modkit/sdk/maps'
import { sha256Hex } from '@modkit/codec-kit/crypto/digest'
import { decodeInput, parseIni } from '@modkit/codec-kit/text'
import { inspectCandidateWorld } from '@modkit/ui/world'
import { materializeWorldToUvw } from '@modkit/uv/world'
import type { Codec, LanguageProvider, ModelResourceRef, ModelResourceRefsSource, NamespaceEntrySource, TreeDataSource } from '@modkit/sdk'
import { openMpqReader } from '@modkit/blizzard-mpq/reader'
import { resolveModelViewerTextures } from '@modkit/ui/model'
import { readUvmContainer, writeUvmContainer, type UvmContainer } from '@modkit/uv/model/container'
import { context, input, open, source } from './war3-harness.js'

/**
 * Evidence route on the installed game: installation discovery → the game's own archives opened as
 * ordinary host subjects → a shipped model opened inside its archive, the way the VS Code viewer
 * opens it. The installation comes from the provider's discovery (MODKIT_WARCRAFT3_ROOT, the
 * registry through host probes, platform defaults), never from a path written here.
 */
const extension = join(import.meta.dirname, '..')
const { discoverWarcraft3Installations } = (await import(
  pathToFileURL(join(extension, 'dist', 'game', 'installation.js')).href
)) as typeof import('../dist/game/installation.js')
const models = join(extension, '..', 'models')
const { exportM3FromUvm } = (await import(
  pathToFileURL(join(models, 'dist', 'm3', 'uvm', 'converter.js')).href
)) as {
  exportM3FromUvm(container: UvmContainer, budget: typeof containerBudget): Promise<Uint8Array>
}
const m3Codec = (await import(pathToFileURL(join(models, 'src', 'm3', 'codec.js')).href)) as {
  createCodec(context: unknown): Codec
}

const target = { environment: 'node', operatingSystem: 'windows', architecture: 'x64' } as const
const grant = { id: 'war3-installed-corpus', classes: ['read-source'] } as const
const budget = {
  maxInputBytes: 1_073_741_824n,
  maxDepth: 128,
  maxNodes: 4_000_000,
  maxScalarBytes: 268_435_456,
  maxDiagnostics: 1000,
}
const containerBudget = {
  maxInputBytes: 268_435_456,
  maxJsonBytes: 67_108_864,
  maxDepth: 128,
  maxNodes: 4_000_000,
}

/** The discovered Reforged installation (a CASC product), if the one discovered is Reforged. */
async function reforgedInstallation() {
  const discovery = await discoverWarcraft3Installations({ gameId: 'blizzard/warcraft-3', maxCandidates: 16 })
  return discovery.installations.find(installation =>
    installation.evidence.some(entry => entry.kind === 'casc-build-info-file' && entry.found),
  )
}

async function classicInstallation() {
  const discovery = await discoverWarcraft3Installations({
    gameId: 'blizzard/warcraft-3',
    maxCandidates: 16,
  })
  const installation = discovery.installations[0]
  if (installation === undefined)
    throw new Error(
      `no Warcraft III installation discovered (set MODKIT_WARCRAFT3_ROOT): ${JSON.stringify(discovery.probes)}`,
    )
  const evidence = new Map(installation.evidence.map(entry => [entry.kind, entry]))
  // Reforged is a CASC product; the routes below are the classic ones.
  return evidence.get('warcraft3-classic-archive')?.found === true
    ? { root: installation.normalizedPath, war3: evidence.get('warcraft3-classic-archive')!.path }
    : undefined
}

/** A map from the installation, opened inside the game, its object data resolved through the host. */
async function withMapData(
  root: string,
  mapPath: string,
  check: (analyzed: Extract<Awaited<ReturnType<typeof analyzeResolvedDataWorkspace>>, { state: 'resolved' }>) => Promise<void>,
) {
  const { createContentSources } = (await import(pathToFileURL(join(extension, 'dist', 'game', 'content-sources.js')).href)) as typeof import('../dist/game/content-sources.js')
  const sources = await createContentSources({ installationDirectory: root })
  const folder = await mkdtemp(join(tmpdir(), 'modkit-war3-data-'))
  try {
    const map = join(folder, mapPath.split('/').at(-1)!)
    await writeFile(map, await sources.read('local:warcraft3', mapPath, 64 << 20))
    const context = await sources.openModContext!({ schemaVersion: 1, target: map })
    const { workspace, resources } = createModContextDataWorkspaceInputs(context)
    try {
      const inventory = await buildInventory(
        [{ ...(await loadExtensionDirectory(extension)), execution: { origin: 'bundled' as const, allowTrustedInProcess: true } }],
        createHostContributionContractRegistry(),
      )
      const serviceDefinitions = createBundledServiceDefinitionRegistry()
      await registerServiceDefinitionsOrThrow(inventory, serviceDefinitions)
      const analyzed = await analyzeResolvedDataWorkspace({
        services: { inventory, target, executionBackends: createExecutionBackendRegistry([TRUSTED_IN_PROCESS_EXECUTION_BACKEND]), serviceDefinitions },
        grant: { id: 'war3-data-host-route', classes: [] },
        budgets: budget,
        workspace,
        resources,
        locales: [],
        queries: [{ namespace: 'unit', entityId: 'hfoo' }],
        localizationKeys: [],
        limits: { maxRequirements: 512, maxDocumentBytes: 16_777_216, maxTextBytes: 134_217_728, maxEntities: 20_000, maxDepth: 16, maxPageSize: 128 },
      })
      if (analyzed.state !== 'resolved')
        throw new Error(`${analyzed.state}: ${JSON.stringify(analyzed.diagnostics.map(item => [item.code, item.message.slice(0, 160)])).slice(0, 3000)}`)
      await check(analyzed)
    } finally {
      await resources.dispose()
      await context.dispose()
    }
  } finally {
    await sources.dispose()
    await rm(folder, { recursive: true, force: true })
  }
}

async function host(extraRoots: readonly string[] = []) {
  const inventory = await buildInventory(
    await Promise.all(
      ['mpq', 'blizzard-warcraft-3', 'blizzard-common-formats', ...extraRoots].map(async name => ({
        ...(await loadExtensionDirectory(join(extension, '..', name))),
        execution: { origin: 'bundled' as const, allowTrustedInProcess: true },
      })),
    ),
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
  return { inventory, executionBackends, target, grant, budget, intent: 'full' as const }
}

async function openArchive(common: Awaited<ReturnType<typeof host>>, path: string) {
  const opened = await openSubject({ ...common, source: await openFileArtifactSource(path), path })
  if (opened.state !== 'opened') throw new Error(`${path} did not open: ${JSON.stringify(opened)}`)
  expect(opened.selected.contributionId).toBe('blizzard/mpq')
  return opened
}

describe.skipIf(process.env['MODKIT_TEST_INSTALLED_CORPUS'] !== '1')(
  'installed Warcraft III',
  () => {
    it('preserves shipped SD PRE2 material facts through source-free Host native export', async ({ skip }) => {
      const discovery = await discoverWarcraft3Installations({ gameId: 'blizzard/warcraft-3', maxCandidates: 16 })
      const installation = discovery.installations[0]
      if (installation === undefined) { skip(); return }
      const { createContentSources } = await import('../dist/game/content-sources.js')
      const { parseWar3Mdx, parseWar3Mdl } = await import('../dist/war3-mdx/render-model.js')
      // Reforged HD replaces this effect with Popcorn, so qualify PRE2 explicitly on the SD art set.
      const sources = await createContentSources({ installationDirectory: installation.normalizedPath, artSet: 'sd' })
      const path = 'Abilities/Spells/Other/BreathOfFire/BreathOfFireMissile.mdx'
      try {
        const bytes = await sources.read('local:warcraft3', path, 16_777_216)
        const native = parseWar3Mdx(bytes)
        expect(native.ParticleEmitters2.length).toBeGreaterThan(0)
        const common = await host()
        const opened = await openSubject({ ...common, source: source(bytes), path })
        if (opened.state !== 'opened') throw new Error(`PRE2 model did not open: ${JSON.stringify(opened).slice(0, 1000)}`)
        try {
          const exported = await opened.session.operations().invoke('model-export-uvm', { schemaVersion: 1 })
          if (exported.state !== 'ok' || exported.output.kind !== 'bytes') throw new Error('PRE2 UVM export failed')
          const parsed = readUvmContainer(exported.output.value as Uint8Array, containerBudget)
          const document = { ...parsed.document }
          delete document['extras']
          const uvm = writeUvmContainer({ ...parsed, document }, containerBudget)
          const definitions = createBundledServiceDefinitionRegistry()
          await registerServiceDefinitionsOrThrow(common.inventory, definitions)
          const resolver = createHostServiceResolver({ inventory: common.inventory, definitions, target,
            executionBackends: common.executionBackends, grant: { id: 'wc3-pre2-corpus', classes: [] }, budgets: budget })
          try {
            const encoder = await resolver.port.resolve({ contract: 'common.model/native-encoder', major: 1, facet: { formatId: 'war3-mdx' } })
            try {
              // Only the claimed PRE2 material storage facts, not simulation or visual equivalence.
              const facts = (model: typeof native) => model.ParticleEmitters2.map(emitter => ({
                name: emitter.Name, priority: emitter.PriorityPlane ?? 0, replaceableId: emitter.ReplaceableId ?? 0,
                unshaded: (emitter.Flags & 0x8000) !== 0, sortPrimsFarZ: (emitter.Flags & 0x10000) !== 0,
                lineEmitter: (emitter.Flags & 0x20000) !== 0, unfogged: (emitter.Flags & 0x40000) !== 0,
                modelSpace: (emitter.Flags & 0x80000) !== 0, xyQuad: (emitter.Flags & 0x100000) !== 0,
                frameFlags: emitter.FrameFlags, squirt: Boolean(emitter.Squirt),
              }))
              for (const encoding of ['mdx', 'mdl'] as const) {
                const result = await encoder.value.encode({ uvm, options: { encoding } })
                const back = encoding === 'mdx' ? parseWar3Mdx(result.bytes) : parseWar3Mdl(new TextDecoder().decode(result.bytes))
                expect(facts(back)).toEqual(facts(native))
              }
              console.log('WC3_PRE2_NATIVE', JSON.stringify({ version: installation.version, artSet: 'sd', path, bytes: bytes.length, facts: facts(native),
                activation: resolver.activationFacts.map(({ providerId, runtimeVariant }) => ({ providerId, runtimeVariant })) }))
            } finally { await encoder.release() }
          } finally { await resolver.release() }
        } finally { await opened.session.dispose() }
      } finally { await sources.dispose() }
    }, 180_000)

    it('qualifies native enum declarations through the Reforged content source', async ({ skip }) => {
      const installation = await reforgedInstallation()
      if (installation === undefined) { skip(); return }
      const { createContentSources } = (await import(pathToFileURL(join(extension, 'dist', 'game', 'content-sources.js')).href)) as typeof import('../dist/game/content-sources.js')
      const sources = await createContentSources({ installationDirectory: installation.normalizedPath })
      try {
        const bytes = await sources.read('local:warcraft3', 'UI/UnitEditorData.txt', 1_048_576)
        const parsed = parseIni(decodeInput({ bytes }), 'ini-war3')
        if (parsed.state === 'failed') throw new Error(`UnitEditorData is not an INI document: ${JSON.stringify(parsed.diagnostics)}`)
        const enums = ['unitRace', 'moveType'].map(name => ({
          name,
          entries: parsed.document.sections.find(section => section.name.toLowerCase() === name.toLowerCase())?.entries
            .slice(0, 12).map(entry => ({ key: entry.key, value: entry.value })) ?? [],
        }))
        console.info('WC3_ENUM_INPUTS', JSON.stringify({ version: installation.version, bytes: bytes.length, enums }))
        expect(enums.every(item => item.entries.length > 0)).toBe(true)
      } finally { await sources.dispose() }
      await withMapData(installation.normalizedPath, 'maps/(2)bootybay.w3m', async analyzed => {
        const race = analyzed.snapshot.schemas?.find(schema => schema.typeId === 'unit')?.fields.find(field => field.fieldId === 'UnitData.race')
        console.info('WC3_ENUM_SCHEMA', JSON.stringify({ race: race?.type,
          unqualified: analyzed.snapshot.diagnostics.filter(item => item.code.startsWith('blizzard.warcraft3/data-enum')).map(item => ({ code: item.code, field: item.fieldId, entity: item.entityId, message: item.message })) }))
        expect(race?.type).toMatchObject({ kind: 'enum', members: expect.arrayContaining([{ id: 'human' }]) })
        const movement = analyzed.snapshot.schemas?.find(schema => schema.typeId === 'unit')?.fields.find(field => field.fieldId === 'UnitData.movetp')
        expect(movement?.type).toMatchObject({ kind: 'enum', members: expect.arrayContaining([{ id: 'foot' }]), unknown: 'Native unset value' })
        expect(analyzed.snapshot.definitions.find(entity => entity.namespace === 'unit' && entity.entityId === 'hfoo')?.fields['UnitData.race']).toBe('human')
      })
    })
    it('investigates declared Reforged art tiers through the host CASC namespace', async ({ skip }) => {
      const installation = await reforgedInstallation()
      const root = installation?.normalizedPath
      if (root === undefined) { skip(); return }
      const opened = await openSubject({ ...(await host(['casc'])), source: await openDirectoryArtifactSource(root), path: root })
      if (opened.state !== 'opened') throw new Error(`Reforged storage did not open: ${JSON.stringify(opened)}`)
      try {
        expect(opened.selected.contributionId).toBe('blizzard/casc')
        const lease = await opened.session.dataSource('common.view/namespace-entry-source', 1)
        try {
          const namespace = lease.value as NamespaceEntrySource
          const tiers = await Promise.all(['war3.w3mod:', 'war3.w3mod:_hd.w3mod:', 'war3.w3mod:_de.w3mod:'].map(async prefix => {
            const page = await namespace.list(prefix, { limit: 8 })
            return { prefix, paths: page.items.map(entry => entry.path), hasMore: page.nextCursor !== undefined }
          }))
          expect(tiers[0]!.paths.length).toBeGreaterThan(0)
          // Evidence is the discovered build's visible TVFS namespace, not an assumption from a reference.
          console.info('WC3_ART_TIERS', JSON.stringify({ root, version: installation?.version, tiers }))
          const buffInputs = await Promise.all(['Units/AbilityBuffData.slk', 'Units/AbilityBuffMetaData.slk', 'Units/BuffMetaData.slk', 'Units/HumanAbilityFunc.txt'].map(async path => {
            const entry = await namespace.lookup?.(`war3.w3mod:${path.toLowerCase()}`)
            return { path, found: entry !== undefined, size: entry?.size?.toString() }
          }))
          console.info('WC3_BUFF_INPUTS', JSON.stringify({ version: installation?.version, buffInputs }))
        } finally { await lease.release() }
      } finally { await opened.session.dispose() }
    })
    it('is found by discovery and its base archive opens through blizzard/mpq', async () => {
      const classic = await classicInstallation()
      if (classic === undefined) return
      const archive = await openArchive(await host(), classic.war3)
      try {
        const entries = archive.descriptor.traits.find(trait => trait.id === 'container.entries')
        expect(Number(entries?.parameters?.['count'])).toBeGreaterThan(1000)
      } finally {
        await archive.session.dispose()
      }
    })

    it('opens a shipped model inside its archive with every texture it names', async () => {
      const classic = await classicInstallation()
      if (classic === undefined) return
      const common = await host()
      const archive = await openArchive(common, classic.war3)
      try {
        const namespace = await archive.session.dataSource('common.view/namespace-entry-source', 1)
        const entry = await (namespace.value as NamespaceEntrySource)
          .lookup?.('Units\\Human\\Footman\\Footman.mdx')
          .finally(() => namespace.release())
        if (entry === undefined) throw new Error('war3.mpq has no Footman.mdx')
        const model = (
          await openNestedSubject({
            ...common,
            parent: archive.session,
            entryId: entry.id,
            logicalRoots: [{ rootId: 'installation', pathPrefix: '' }],
          })
        ).result
        if (model.state !== 'opened') throw new Error(`Footman.mdx did not open: ${model.state}`)
        try {
          expect(model.selected.contributionId).toBe('blizzard/war3-mdx')
          const refs = await model.session.dataSource('common.view/model-resource-refs-source', 1)
          const references: ModelResourceRef[] = []
          try {
            const page = await (refs.value as ModelResourceRefsSource).references({ limit: 256 })
            references.push(...page.items)
          } finally {
            await refs.release()
          }
          // Its own skin, the player-colour texture and the gore: all live in the same archive.
          expect(references.length).toBeGreaterThanOrEqual(3)
          if (model.rasterResources === undefined) throw new Error('Footman.mdx has no raster port')
          const textures = await resolveModelViewerTextures(model.rasterResources, references)
          expect(textures.size).toBe(new Set(references.map(reference => reference.id)).size)

          const exported = await model.session
            .operations()
            .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 0.01 })
          if (exported.state !== 'ok' || exported.output.kind !== 'bytes')
            throw new Error(`model.export-uvm: ${JSON.stringify(exported).slice(0, 300)}`)
          const document = readUvmContainer(exported.output.value as Uint8Array, containerBudget)
            .document as {
            meshes: unknown[]
            skins?: unknown[]
            animations?: { name?: string; channels: { target: { path: string } }[] }[]
            extensions: { UV_game_animation_clips?: { clips: { name: string }[] } }
          }
          expect(document.meshes.length).toBeGreaterThan(0)
          expect(document.skins?.length).toBe(1)
          const clips = document.extensions.UV_game_animation_clips?.clips ?? []
          expect(clips.map(clip => clip.name)).toContain('Attack - 1')
          // Its bones move with Hermite tracks, and each sequence reaches glTF as motion, not only a
          // name: 13 of 13. Decay Bone moves no node; it keys geoset alpha, which reaches glTF as the
          // flesh's visibility through KHR_animation_pointer.
          expect(clips).toHaveLength(13)
          expect(document.animations?.length).toBe(13)
          const decay = document.animations?.find(animation => animation.name === 'Decay Bone')
          expect(decay?.channels.map(channel => channel.target.path)).toEqual(
            expect.arrayContaining(['pointer']),
          )
          expect(decay?.channels.every(channel => channel.target.path === 'pointer')).toBe(true)

          // And it converts to StarCraft II: the cubic tracks cross rig authoring into an M3 the
          // M3 codec reads back with the same motion, Decay Bone's flesh toggled by its batch bone.
          const m3 = await exportM3FromUvm(
            readUvmContainer(exported.output.value as Uint8Array, containerBudget),
            containerBudget,
          )
          const reopened = await m3Codec.createCodec(context).open(input(source(m3)), 'inspect', budget)
          try {
            const back = await reopened
              .operations()
              .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
            if (back.state !== 'ok' || back.output.kind !== 'bytes')
              throw new Error(`M3 model.export-uvm: ${JSON.stringify(back).slice(0, 300)}`)
            const m3Document = readUvmContainer(back.output.value as Uint8Array, containerBudget)
              .document as { animations?: unknown[] }
            expect(m3Document.animations?.length).toBe(13)
          } finally {
            await reopened.dispose()
          }
        } finally {
          await model.session.dispose()
        }
      } finally {
        await archive.session.dispose()
      }
    })

    it('serves the installation as one tree through the host, the patch over the base', async () => {
      const classic = await classicInstallation()
      if (classic === undefined) return
      const storage = await mkdtemp(join(tmpdir(), 'modkit-war3-sources-'))
      // The host composes the extension's declared module, handing it the selected installation.
      const sources = await resolveContentSources({
        extensionRoots: [extension],
        storage,
        moduleOptions: id =>
          id === 'blizzard/warcraft-3' ? { installationDirectory: classic.root } : undefined,
      })
      try {
        const root = (await sources!.snapshot()).roots.find(item => item.id === 'local:warcraft3')
        expect(root?.storageOf).toBe(classic.root)
        const footman = await sources!.list('local:warcraft3', 'Units/Human/Footman')
        expect(footman.map(entry => entry.name)).toContain('Footman.mdx')
        // War3Patch.mpq names nothing; common.j is served from it all the same, not from war3.mpq.
        const patch = await openArchive(await host(), join(classic.root, 'War3Patch.mpq'))
        const namespace = await patch.session.dataSource('common.view/namespace-entry-source', 1)
        const patched = await (namespace.value as NamespaceEntrySource)
          .lookup?.('Scripts\\common.j')
          .finally(async () => {
            await namespace.release()
            await patch.session.dispose()
          })
        const script = await sources!.read('local:warcraft3', 'Scripts/common.j', 1 << 20)
        expect(script.byteLength).toBe(Number(patched?.size))
        expect(new TextDecoder().decode(script)).toContain('native')
      } finally {
        await sources?.dispose()
        await rm(storage, { recursive: true, force: true })
      }
    })

    it('parses the game\'s own JASS libraries without a syntax error', async () => {
      const classic = await classicInstallation()
      if (classic === undefined) return
      const { parseJass } = (await import(
        pathToFileURL(join(extension, 'dist', 'jass', 'parser.js')).href
      )) as typeof import('../dist/jass/parser.js')
      const { createContentSources } = (await import(
        pathToFileURL(join(extension, 'dist', 'game', 'content-sources.js')).href
      )) as typeof import('../dist/game/content-sources.js')
      const sources = await createContentSources({ installationDirectory: classic.root })
      try {
        const kinds: Record<string, Record<string, number>> = {}
        for (const path of ['Scripts/common.j', 'Scripts/Blizzard.j', 'Scripts/common.ai']) {
          const program = parseJass(new TextDecoder().decode(await sources.read('local:warcraft3', path, 1 << 23)))
          expect(program.errors, path).toEqual([])
          const counts: Record<string, number> = {}
          for (const declaration of program.declarations)
            counts[declaration.kind] = (counts[declaration.kind] ?? 0) + 1
          kinds[path] = counts
        }
        // The natives and types of 1.24e, the functions Blizzard.j builds on them.
        expect(kinds['Scripts/common.j']).toEqual({ type: 91, native: 1160, globals: 1 })
        expect(kinds['Scripts/Blizzard.j']).toEqual({ globals: 1, function: 923 })
        expect(kinds['Scripts/common.ai']?.['native']).toBe(123)
      } finally {
        await sources.dispose()
      }
    })

    it('gives a map script the game\'s own libraries through the host language route', async () => {
      const classic = await classicInstallation()
      if (classic === undefined) return
      const { createContentSources } = (await import(
        pathToFileURL(join(extension, 'dist', 'game', 'content-sources.js')).href
      )) as typeof import('../dist/game/content-sources.js')
      const { createProvider } = (await import(
        pathToFileURL(join(extension, 'providers', 'jass-language', 'runtime.js')).href
      )) as { createProvider(selection: { contract: string; major: number }): { value: LanguageProvider } }
      const sources = await createContentSources({ installationDirectory: classic.root })
      const folder = await mkdtemp(join(tmpdir(), 'modkit-war3-script-'))
      try {
        const path = join(folder, 'war3map.j')
        const text = "function main takes nothing returns nothing\n    call CreateUnit(Player(0), 'hfoo', 0, 0, 0)\nendfunction\n"
        await writeFile(path, text)
        const document = { uri: pathToFileURL(path).href, languageId: 'jass', version: 1, text }
        // The host projects the script's context (the installation's Scripts) into its workspace.
        const resolved = await resolveContentLanguageSources({
          contentSources: sources,
          routes: [{ languageId: 'jass', extension: 'j' }],
          limits: {},
          subjects: [{ descriptor: { subjectUri: document.uri } }],
        })
        expect(resolved.dependenciesComplete).toBe(true)
        const snapshot = await resolved.sources[0]!.snapshot({
          document,
          workspaceDocuments: [document],
          workspaceDocumentOrigins: [],
          workspaceLanguageIds: ['jass'],
          maxDocuments: 50,
          signal: new AbortController().signal,
        })
        const libraries = snapshot.documents.map(item => item.uri.split('/').at(-1))
        expect(libraries).toEqual(expect.arrayContaining(['common.j', 'Blizzard.j']))
        // With them, the natives the script calls are known and its call is checked.
        const provider = createProvider({ contract: 'common.language/document-analysis', major: 1 }).value
        const diagnostics = await provider.diagnostics!({
          document,
          workspaceDocuments: [document, ...snapshot.documents],
          workspaceIncomplete: false,
          maxResults: 50,
          maxDocuments: 50,
        })
        expect(diagnostics.diagnostics).toEqual([])
        const hover = await provider.hover!({
          document,
          workspaceDocuments: [document, ...snapshot.documents],
          workspaceIncomplete: false,
          maxResults: 50,
          maxDocuments: 50,
          position: { line: 1, character: 10 },
        })
        expect(hover?.markdown).toContain('native CreateUnit takes player id, integer unitid, real x, real y, real face returns unit')
      } finally {
        await sources.dispose()
        await rm(folder, { recursive: true, force: true })
      }
    })

    it('opens a melee map inside its archive as a map, its terrain as layers', async () => {
      const classic = await classicInstallation()
      if (classic === undefined) return
      const common = await host()
      const archive = await openArchive(common, classic.war3)
      try {
        const namespace = await archive.session.dataSource('common.view/namespace-entry-source', 1)
        const entry = await (namespace.value as NamespaceEntrySource)
          .lookup?.('(2)BootyBay.w3m')
          .finally(() => namespace.release())
        if (entry === undefined) throw new Error('war3.mpq has no (2)BootyBay.w3m')
        const map = (await openNestedSubject({ ...common, parent: archive.session, entryId: entry.id })).result
        if (map.state !== 'opened') throw new Error(`(2)BootyBay.w3m did not open: ${map.state}`)
        try {
          expect(map.selected.contributionId).toBe('blizzard/war3-map')
          expect(map.descriptor.diagnostics).toEqual([])
          const invoke = async (id: string, input: unknown) => {
            const handler = map.descriptor.operations.find(item => item.id === id)?.handlerId
            const result = await map.session.operations().invoke(handler!, input as never)
            if (result.state !== 'ok') throw new Error(`${id} failed: ${JSON.stringify(result)}`)
            return (result.output as { value: unknown }).value
          }
          const layers = (await invoke('map.layers', {})) as { layers: { id: string; width: number; height: number }[] }
          expect(layers.layers.map(layer => [layer.id, layer.width, layer.height])).toEqual([
            ['height', 193, 97],
            ['cliff-level', 193, 97],
            ['water', 193, 97],
            ['ground-texture', 193, 97],
            ['corner-flags', 193, 97],
            ['pathing', 768, 384],
          ])
          const read = (await invoke('map.layer-read', { layer: 'pathing', x: 0, y: 0, width: 768, height: 1 })) as { values: number[] }
          expect(read.values).toHaveLength(768)
          const tree = await map.session.dataSource('common.view/tree-data-source', 1)
          try {
            const source = tree.value as TreeDataSource
            const root = await source.root()
            // The name is a trigger string, in the installation's language.
            expect((await source.facts(root)).label).not.toMatch(/^(TRIGSTR_d+)?$/u)
            const sections = await source.children(root, { limit: 20 })
            const facts = await Promise.all(sections.items.map(item => source.facts(item)))
            expect(Object.fromEntries(facts.map(item => [item.label, item.preview]))).toMatchObject({
              Players: '2',
              Terrain: '192 × 96 tiles',
            })
          } finally {
            await tree.release()
          }
        } finally {
          await map.session.dispose()
        }
      } finally {
        await archive.session.dispose()
      }
    })

    it('opens a downloaded map that hides its names (DotA and the like) as a map', async () => {
      const classic = await classicInstallation()
      if (classic === undefined) return
      const folder = (await readdir(classic.root, { withFileTypes: true })).find(item => item.isDirectory() && /^maps$/iu.test(item.name))
      const download = folder === undefined ? undefined : (await readdir(join(classic.root, folder.name), { withFileTypes: true })).find(item => item.isDirectory() && /^download$/iu.test(item.name))
      if (download === undefined) return
      const directory = join(classic.root, folder!.name, download.name)
      const maps = (await readdir(directory)).filter(name => /\.w3[mx]$/iu.test(name))
      const common = await host()
      const opened: string[] = []
      for (const name of maps) {
        const path = join(directory, name)
        const map = await openSubject({ ...common, source: await openFileArtifactSource(path), path })
        if (map.state !== 'opened') throw new Error(`${name} did not open: ${JSON.stringify(map.diagnostics)}`)
        try {
          // A protected map lists no names: its documents are found by exact path through the hash table.
          expect(`${name}: ${map.selected.contributionId}`).toBe(`${name}: blizzard/war3-map`)
          const handler = map.descriptor.operations.find(item => item.id === 'map.layers')?.handlerId
          const result = await map.session.operations().invoke(handler!, {} as never)
          if (result.state !== 'ok') throw new Error(`${name} map.layers: ${JSON.stringify(result)}`)
          expect((result.output as { value: { layers: unknown[] } }).value.layers).toHaveLength(6)
          opened.push(name)
        } finally {
          await map.session.dispose()
        }
      }
      expect(opened).toEqual(maps)
    })

    it('reads every map the installation ships, every document it names', async () => {
      const classic = await classicInstallation()
      if (classic === undefined) return
      const { createContentSources } = (await import(
        pathToFileURL(join(extension, 'dist', 'game', 'content-sources.js')).href
      )) as typeof import('../dist/game/content-sources.js')
      const { readWar3Map } = (await import(pathToFileURL(join(extension, 'dist', 'war3-map', 'map.js')).href)) as typeof import('../dist/war3-map/map.js')
      const objectMods = ((await import(pathToFileURL(join(extension, 'dist', 'war3-object-mods', 'codec.js')).href)) as { createCodec(context: unknown): Codec }).createCodec(context)
      let changes = 0
      const sources = await createContentSources({ installationDirectory: classic.root })
      try {
        const maps = (await sources.files!('local:warcraft3', '', { pattern: '.w3', limit: 1000 })).items
          .map(item => item.path)
          .filter(path => /\.w3[mx]$/iu.test(path))
        expect(maps.length).toBeGreaterThan(100)
        const unread: string[] = []
        for (const path of maps) {
          const reader = await openMpqReader(await sources.read('local:warcraft3', path, 64 << 20), {
            maxArchiveBytes: 1 << 30,
            maxEntries: 1 << 18,
            maxEntryBytes: 1 << 28,
          })
          try {
            const map = await readWar3Map(async name => {
              const found = reader.find(name)
              return found === undefined ? undefined : reader.read(found.id)
            })
            const [width = 0, height = 0] = map.terrain?.mapSize ?? []
            // Pathing has four cells a tile; the grids of a map agree.
            const agree = map.pathing?.size[0] === 4 * (width - 1) && map.pathing.size[1] === 4 * (height - 1)
            if (map.failures.length > 0 || map.info === undefined || !agree)
              unread.push(`${path}: ${JSON.stringify(map.failures)}`)
            // The object editor's changes the map carries open through their own codec.
            for (const kind of ['w3u', 'w3t', 'w3b', 'w3d', 'w3a', 'w3h', 'w3q']) {
              const found = reader.find(`war3map.${kind}`)
              if (found === undefined) continue
              const bytes = await reader.read(found.id)
              try {
                const session = await objectMods.open(input(source(bytes, `memory://war3/war3map.${kind}`)), 'inspect', budget)
                const inspected = await session.operations().invoke('inspect', {})
                await session.dispose()
                if (inspected.state !== 'ok' || inspected.output.kind !== 'json') throw new Error('inspect failed')
                changes += (inspected.output.value as { changes: number }).changes
              } catch (error) {
                unread.push(`${path} war3map.${kind}: ${String(error)}`)
              }
            }
          } finally {
            reader.dispose()
          }
        }
        expect(unread).toEqual([])
        expect(changes).toBeGreaterThan(0)
      } finally {
        await sources.dispose()
      }
      // ~85 s alone over 100+ maps; the full real tier runs files in parallel.
    }, 600_000)

    it('opens every replay the installation keeps, its record matching its header', async () => {
      const classic = await classicInstallation()
      if (classic === undefined) return
      const common = await host()
      const replays = (await readdir(classic.root, { recursive: true }))
        .filter(path => /\.w3g$/iu.test(path))
        .map(path => join(classic.root, path))
      const refused: string[] = []
      const mismatched: string[] = []
      let opened = 0
      for (const path of replays) {
        const result = await openSubject({ ...common, source: await openFileArtifactSource(path), path })
        if (result.state !== 'opened') {
          refused.push(result.diagnostics.map(item => item.message).join('; '))
          continue
        }
        try {
          expect(result.selected.contributionId).toBe('blizzard/war3-replay')
          const handler = result.descriptor.operations.find(item => item.id === 'export.convert')!.handlerId
          const output = await result.session.operations().invoke(handler, {} as never)
          if (output.state !== 'ok') throw new Error(`${path}: ${JSON.stringify(output)}`)
          const replay = (output.output as { value: { durationMs: number; recordedMs: number; pausedMs: number; map: { path: string }; players: unknown[] } }).value
          // The header states the game's length without its pauses; the time slots, less the
          // paused time, add up to it within a slot or two.
          const played = replay.recordedMs - replay.pausedMs
          if (replay.players.length === 0 || replay.map.path === '' || Math.abs(played - replay.durationMs) > 250)
            mismatched.push(`${path}: ${String(played)} of ${String(replay.durationMs)} ms`)
          opened += 1
        } finally {
          await result.session.dispose()
        }
      }
      expect(replays.length).toBeGreaterThan(0)
      expect(mismatched).toEqual([])
      // A game that ended before it began keeps no record, and is refused by name.
      expect(refused.every(message => message.includes('the recording was cut off'))).toBe(true)
      expect(opened + refused.length).toBe(replays.length)
    })

    it('resolves Reforged buffs separately from abilities through the host data route', async ({ skip }) => {
      const root = (await reforgedInstallation())?.normalizedPath
      if (root === undefined) { skip(); return }
      await withMapData(root, 'maps/(2)bootybay.w3m', async analyzed => {
        const buffs = analyzed.snapshot.definitions.filter(entity => entity.namespace === 'buff')
        expect(buffs.length).toBeGreaterThan(50)
        expect(buffs.some(entity => Object.keys(entity.fields).some(field => field.startsWith('AbilityBuffData.')))).toBe(true)
        expect(buffs.some(entity => typeof entity.fields['Profile.Bufftip'] === 'string')).toBe(true)
        const blizzard = buffs.find(entity => entity.entityId === 'BHbd')
        expect(blizzard).toBeDefined()
        expect(analyzed.snapshot.definitions.some(entity => entity.namespace === 'ability' && entity.entityId === 'BHbd')).toBe(false)
        expect(analyzed.snapshot.diagnostics.some(item => item.severity === 'error')).toBe(false)
      })
    })

    it('resolves the installed object data through the host data route, a map opened inside the game', async () => {
      const classic = await classicInstallation()
      if (classic === undefined) return
      await withMapData(classic.root, '(2)BootyBay.w3m', async analyzed => {
        const footman = analyzed.snapshot.entities.find(entity => entity.entityId === 'hfoo')
        // The five sheets and the profiles of the installation, joined on the footman's id.
        expect(footman?.fields).toMatchObject({ 'UnitData.race': 'human', 'UnitData.movetp': 'foot', 'UnitBalance.HP': '420', 'UnitBalance.goldcost': '135', 'UnitWeapons.cool1': '1.35' })
        expect(footman?.fields['Profile.Name']).toEqual(expect.any(String))
        expect(footman?.fieldSources?.['UnitBalance.HP']).toMatchObject({ rootId: 'war3-game', path: expect.stringMatching(/\/Units\/UnitBalance\.slk$/u) })
        // Every kind of the installation, each from its own sheets and profiles.
        const count = (namespace: string) => analyzed.snapshot.definitions.filter(entity => entity.namespace === namespace).length
        expect(Object.fromEntries(['unit', 'item', 'ability', 'buff', 'upgrade', 'destructable', 'doodad'].map(namespace => [namespace, count(namespace) > 50]))).toEqual({
          unit: true, item: true, ability: true, buff: true, upgrade: true, destructable: true, doodad: true,
        })
        const blizzard = analyzed.snapshot.definitions.find(entity => entity.namespace === 'ability' && entity.entityId === 'AHbz')
        expect(blizzard?.fields).toMatchObject({ 'AbilityData.code': 'AHbz', 'AbilityData.levels': '3' })
        expect(blizzard?.fields['Profile.Name']).toEqual(expect.any(String))
        // The barracks trains the footman: a typed link from the profile's Trains list.
        expect(analyzed.snapshot.relations).toContainEqual(
          expect.objectContaining({ from: expect.objectContaining({ entityId: 'hbar' }), to: expect.objectContaining({ namespace: 'unit', entityId: 'hfoo' }), role: 'Profile.Trains', dead: false }),
        )
      })
    })

    it('resolves the custom units of a campaign map over the game, each inheriting its base', async () => {
      const classic = await classicInstallation()
      if (classic === undefined) return
      const { createContentSources } = (await import(pathToFileURL(join(extension, 'dist', 'game', 'content-sources.js')).href)) as typeof import('../dist/game/content-sources.js')
      const { readObjectMods, objectId } = (await import(pathToFileURL(join(extension, 'dist', 'war3-object-mods', 'format.js')).href)) as typeof import('../dist/war3-object-mods/format.js')
      // The first shipped map whose object editor made custom units: found by content, not by name.
      const sources = await createContentSources({ installationDirectory: classic.root })
      let found: { path: string; custom: { id: string; base: string; changes: number }[] } | undefined
      try {
        const maps = (await sources.files!('local:warcraft3', '', { pattern: '.w3', limit: 1000 })).items.map(item => item.path).filter(path => /\.w3[mx]$/iu.test(path))
        for (const path of maps.sort()) {
          const reader = await openMpqReader(await sources.read('local:warcraft3', path, 64 << 20), { maxArchiveBytes: 1 << 30, maxEntries: 1 << 18, maxEntryBytes: 1 << 28 })
          try {
            const entry = reader.find('war3map.w3u')
            if (entry === undefined) continue
            const mods = readObjectMods(await reader.read(entry.id), 'w3u')
            const custom = mods.custom.objects.map(object => ({ id: objectId(object.newId), base: objectId(object.oldId), changes: object.modifications.length }))
            if (custom.length > 0) {
              found = { path, custom }
              break
            }
          } finally {
            reader.dispose()
          }
        }
      } finally {
        await sources.dispose()
      }
      if (found === undefined) throw new Error('no shipped map has custom units')
      const { path, custom } = found
      await withMapData(classic.root, path, async analyzed => {
        expect(analyzed.diagnostics.map(item => item.code)).not.toContain('blizzard.warcraft3/object-mods-unreadable')
        const of = (id: string) => analyzed.snapshot.definitions.find(entity => entity.namespace === 'unit' && entity.entityId === id)
        for (const item of custom) {
          const unit = of(item.id)
          const base = of(item.base)
          expect(unit, `${path}: ${item.id}`).toBeDefined()
          // Inherited: a sheet field the map did not change reads as its base's.
          expect(unit?.fields['UnitData.race'], `${item.id} from ${item.base}`).toBe(base?.fields['UnitData.race'])
          // The map's own changes come from its object-editor file.
          if (item.changes > 0)
            expect(Object.values(unit?.fieldSources ?? {}).some(source => /war3map\.w3u$/u.test(source.path)), `${item.id} changed by the map`).toBe(true)
        }
      })
    })

    it('shows a melee map as a world through the common map preview, its tiles and models from the installation', async () => {
      const classic = await classicInstallation()
      if (classic === undefined) return
      const { createContentSources } = (await import(pathToFileURL(join(extension, 'dist', 'game', 'content-sources.js')).href)) as typeof import('../dist/game/content-sources.js')
      const sources = await createContentSources({ installationDirectory: classic.root })
      const folder = await mkdtemp(join(tmpdir(), 'modkit-war3-world-'))
      try {
        const path = join(folder, 'BootyBay.w3m')
        await writeFile(path, await sources.read('local:warcraft3', '(2)BootyBay.w3m', 64 << 20))
        const common = await host()
        const serviceDefinitions = createBundledServiceDefinitionRegistry()
        await registerServiceDefinitionsOrThrow(common.inventory, serviceDefinitions)
        const services = { inventory: common.inventory, target, executionBackends: common.executionBackends, serviceDefinitions }
        const opened = await openSubject({ ...common, serviceDefinitions, source: await openFileArtifactSource(path), path })
        if (opened.state !== 'opened') throw new Error(`BootyBay did not open: ${JSON.stringify(opened.diagnostics)}`)
        try {
          const preview = await coordinateMapPreviewAssetSession({
            services,
            grant: { id: 'war3-map-world', classes: ['read-source'] },
            budgets: budget,
            original: opened.session,
            resourcePlanResolver: createContentSourceMapPreviewResourcePlanResolver({ contentSources: async () => sources }),
            contentSources: sources,
            maxCandidates: 4,
            maxSubjectEntries: 4096,
            maxSubjectPages: 8,
            maxRoots: 4,
            maxDepth: 4,
            limits: {
              maxRequirements: 64,
              maxDocumentBytes: 32 << 20,
              maxTotalBytes: 128 << 20,
              maxObjects: 100_000,
              maxRegions: 1000,
              maxTerrainCells: 100_000,
              maxTerrainSamples: 100_000,
              maxDepth: 64,
              maxPageSize: 1024,
              maxDiagnostics: 500,
            },
          })
          if (preview.state !== 'opened') throw new Error(`${preview.state}: ${JSON.stringify(preview.diagnostics).slice(0, 3000)}`)
          try {
            expect(preview.snapshot).toMatchObject({ gameId: 'blizzard/warcraft-3', semantic: { terrain: { width: 193, height: 97 } } })
            // The game's camera, as the installation's Blizzard.j states its defaults.
            const blizzardJ = new TextDecoder().decode(await sources.read('local:warcraft3', 'Scripts/Blizzard.j', 4 << 20))
            const constant = (name: string) => Number(new RegExp(`${name}\\s*=\\s*([0-9.]+)`, 'u').exec(blizzardJ)?.[1])
            expect({
              aoa: constant('bj_CAMERA_DEFAULT_AOA'),
              fov: constant('bj_CAMERA_DEFAULT_FOV'),
              farz: constant('bj_CAMERA_DEFAULT_FARZ'),
              rotation: constant('bj_CAMERA_DEFAULT_ROTATION'),
            }).toEqual({ aoa: 304, fov: 70, farz: 5000, rotation: 90 })
            expect(preview.snapshot.camera).toEqual({ projection: 'perspective', azimuthDegrees: 90, elevationDegrees: 56, fieldOfViewDegrees: 70, drawDistance: 5000 })
            // Its two player slots from the information file.
            expect(preview.snapshot.semantic.players?.length).toBe(2)
            const objects = preview.snapshot.semantic.objects
            // Trees, doodads and units, every one with the model its table names.
            expect(objects.filter(object => object.kind === 'feature').length).toBeGreaterThan(100)
            expect(objects.filter(object => object.kind !== 'point' && object.modelResource === undefined)).toEqual([])
            // The map's cliffs as pieces of the installation's cliff models, and its water.
            expect(preview.snapshot.cliffs?.pieces?.length).toBeGreaterThan(50)
            expect(preview.snapshot.water?.zones.length).toBeGreaterThan(0)
            // Its ramps walled by ramp pieces, and every piece a model the installation has.
            expect(preview.snapshot.cliffs?.pieces?.filter(piece => piece.id.startsWith('ramp-')).length).toBeGreaterThan(0)
            const absent: string[] = []
            for (const model of preview.snapshot.cliffs?.pieceModels ?? []) {
              let found = false
              for (const candidate of model.candidates)
                found ||= await sources.read('local:warcraft3', candidate.requirement.logicalId, 16 << 20).then(() => true, () => false)
              if (!found) absent.push(model.id)
            }
            expect(absent).toEqual([])
            const lease = await preview.session.dataSource('common.view/world-scene-source', 1)
            try {
              const world = lease.value as WorldSceneSource
              const info = await world.info()
              // The map-native to UVW transform and its proof (ADR-WORLD-003). The oracle side is
              // computed here, apart from the provider: the map's own w3e through mdx-m3-viewer's parser
              // and its viewer's rule — height (groundHeight + layerHeight - 2) * 128, position centre
              // offset plus index times 128 — and must equal what the provider published, to the bit.
              expect(preview.snapshot.uvwTransform?.proof.method).toBe('third-party-reference-differential')
              // The map's container.extract is the MPQ carrier's, which the host lends the composed session.
              const extract = (await opened.session.descriptor()).operations.find(operation => operation.id === 'container.extract')
              if (extract === undefined) throw new Error('the map lends no container.extract')
              const extracted = await opened.session.operations().invoke(extract.handlerId, { entryId: 'war3map.w3e' })
              if (extracted.state !== 'ok' || extracted.output.kind !== 'bytes') throw new Error(`war3map.w3e: ${JSON.stringify(extracted).slice(0, 300)}`)
              const w3eBytes = extracted.output.value as Uint8Array
              const { default: War3MapW3e } = (await import(
                pathToFileURL(join(extension, 'dist', 'lib', 'mdx-m3-viewer', 'parsers', 'w3x', 'w3e', 'file.js')).href
              )) as { default: new () => { load(bytes: Uint8Array): void; centerOffset: Float32Array; mapSize: Int32Array; corners: { groundHeight: number; layerHeight: number; blight: number }[][] } }
              const oracle = new War3MapW3e()
              oracle.load(w3eBytes)
              const [columns = 0, rows = 0] = oracle.mapSize
              const oracleTuples: [number, number, number][] = []
              for (let row = 0; row < rows; row += 1)
                for (let column = 0; column < columns; column += 1) {
                  const corner = oracle.corners[row]![column]!
                  oracleTuples.push([oracle.centerOffset[0]! + column * 128, oracle.centerOffset[1]! + row * 128, (corner.groundHeight + corner.layerHeight - 2) * 128])
                }
              const transform = preview.snapshot.terrainTransform!
              const publishedTuples = (preview.snapshot.semantic.terrain?.samples ?? []).map(
                sample => [transform.heightMap.offset.x + sample.x * 128, transform.heightMap.offset.y + sample.y * 128, sample.heightBase] as [number, number, number],
              )
              expect(publishedTuples.length).toBe(oracleTuples.length)
              expect(publishedTuples.every((tuple, index) => tuple.every((value, axis) => Object.is(value, oracleTuples[index]![axis])))).toBe(true)
              const zero = (value: number) => (value === 0 ? 0 : value)
              // Canonical tuples in UVW heightfield order: rows from the north (sourceRowOrder reverse).
              const canonicalTuples: [number, number, number][] = []
              for (let row = rows - 1; row >= 0; row -= 1)
                for (let column = 0; column < columns; column += 1) {
                  const [x, y, z] = oracleTuples[row * columns + column]!
                  canonicalTuples.push([zero(x), zero(z), zero(-y)])
                }
              const receipt = {
                w3e: `sha256:${await sha256Hex(w3eBytes)}`,
                tupleCount: oracleTuples.length,
                native: `sha256:${await sha256Hex(mapQualificationTupleBytes(oracleTuples))}`,
                canonical: `sha256:${await sha256Hex(mapQualificationTupleBytes(canonicalTuples))}`,
              }
              const proof = preview.snapshot.uvwTransform!.proof
              expect({
                w3e: proof.sourceDigests['war3map.w3e'],
                tupleCount: proof.tupleCount,
                native: proof.nativeTupleDigest,
                canonical: proof.canonicalTupleDigest,
              }).toEqual(receipt)
              // The host recomputes the same digests from the corpus terrain and admits the transform.
              expect(info.uvwTransformRefusal).toBeUndefined()
              expect(info.facets.find(facet => facet.facet === 'terrain')).toMatchObject({ state: 'available', itemCount: 193 * 97 })
              expect(info.facets.find(facet => facet.facet === 'cliffs')?.state).not.toBe('unavailable')
              expect(info.facets.find(facet => facet.facet === 'water')?.state).not.toBe('unavailable')
              // A tileset texture resolves in the installation and decodes through blizzard/blp.
              const material = preview.snapshot.terrainMaterials?.materials?.find(item => item.baseColorResourceId !== undefined)
              if (material?.baseColorResourceId === undefined || world.texture === undefined) throw new Error('no tileset texture')
              const texture = await world.texture(material.baseColorResourceId, { maxBytes: 64 << 20 })
              expect(texture.state, JSON.stringify(texture.diagnostics).slice(0, 600)).toBe('decoded')
              // Cells where tilesets meet layer them, each layer a declared tileset material.
              const declared = new Set(preview.snapshot.terrainMaterials?.materials?.map(item => item.materialId))
              const layered = (preview.snapshot.terrainMaterials?.samples ?? []).map(sample => (sample as { layers?: readonly { materialId: string }[] }).layers ?? [])
              expect(layered.filter(layers => layers.length > 1).length).toBeGreaterThan(100)
              expect(layered.flat().filter(layer => !declared.has(layer.materialId))).toEqual([])
              // The first models of the map load from the installation through blizzard/war3-mdx.
              const viewer = await inspectCandidateWorld(world as never, { maxLayers: 16, maxItemsPerLayer: 100_000, maxPageItems: 1024, maxModels: 4 })
              const models = [...(viewer.models?.values() ?? [])]
              // Every distinct model of the map is a resource; the four admitted convert, the rest wait for the limit.
              expect(models.length).toBeGreaterThan(50)
              expect(models.filter(model => model.state === 'converted')).toHaveLength(4)
              expect(
                models.filter(model => model.state !== 'converted' && !JSON.stringify(model).includes('x3.ui/world-model-budget-exhausted')).map(model => JSON.stringify(model).slice(0, 300)),
              ).toEqual([])
              // With the proved transform the world materializes as UVW.
              const uvw = await materializeWorldToUvw(world as never, { maxPageItems: 1024, maxTerrainItems: 100_000, maxFacetItems: 100_000, maxOutputBytes: 64_000_000 })
              expect((uvw as { state: string }).state, JSON.stringify(uvw).slice(0, 2000)).toBe('materialized')
              const excluded = (uvw as { excludedFacetIds?: readonly string[] }).excludedFacetIds ?? []
              expect(excluded).not.toContain('world.objects')
              // And back: the map encoder writes the UVW as a .w3x the host opens as a map, every corner
              // at its own height and cliff level, every typed object in place.
              const { encodeWar3Map } = (await import(pathToFileURL(join(extension, 'dist', 'war3-map', 'encoder.js')).href)) as typeof import('../dist/war3-map/encoder.js')
              const written = encodeWar3Map((uvw as { bytes: Uint8Array }).bytes, { name: 'BootyBay through UVW' })
              expect(written.diagnostics.map(item => item.code)).toContain('blizzard.war3/map-script-missing')
              const back = await openMpqReader(written.bytes, { maxArchiveBytes: 1 << 30, maxEntries: 1 << 10, maxEntryBytes: 1 << 28 })
              try {
                const backW3e = new War3MapW3e()
                backW3e.load(await back.read(back.find('war3map.w3e')!.id))
                expect([...backW3e.mapSize]).toEqual([...oracle.mapSize])
                expect([...backW3e.centerOffset]).toEqual([...oracle.centerOffset])
                const moved = oracle.corners.flatMap((row, r) =>
                  row.flatMap((corner, c) => {
                    const other = backW3e.corners[r]![c]!
                    return other.groundHeight === corner.groundHeight && other.layerHeight === corner.layerHeight ? [] : [[c, r]]
                  }),
                )
                expect(moved).toEqual([])
                // Blight written back only where the map has it (a cliff's ground hides it in the world).
                const blighted = backW3e.corners.flatMap((row, r) => row.flatMap((corner, c) => (corner.blight !== 0 && oracle.corners[r]![c]!.blight === 0 ? [[c, r]] : [])))
                expect(blighted).toEqual([])
              } finally {
                back.dispose()
              }
              const writtenPath = join(folder, 'BootyBay-through-uvw.w3x')
              await writeFile(writtenPath, written.bytes)
              const reopened = await openSubject({ ...common, serviceDefinitions, source: await openFileArtifactSource(writtenPath), path: writtenPath })
              expect(reopened.state, JSON.stringify(reopened.diagnostics).slice(0, 1500)).toBe('opened')
              if (reopened.state === 'opened') {
                // As a Warcraft III map, not only as an archive: the map codec recognised its information file.
                expect(reopened.selected.contributionId).toBe('blizzard/war3-map')
                await reopened.session.dispose()
              }
            } finally {
              await lease.release()
            }
          } finally {
            await preview.session.dispose()
          }
        } finally {
          await opened.session.dispose()
        }
      } finally {
        await sources.dispose()
        await rm(folder, { recursive: true, force: true })
      }
    })

    it('finds a patch file by its path although the patch archive lists no names', async () => {
      const classic = await classicInstallation()
      if (classic === undefined) return
      const patch = await openArchive(await host(), join(classic.root, 'War3Patch.mpq'))
      try {
        const namespace = await patch.session.dataSource('common.view/namespace-entry-source', 1)
        try {
          const source = namespace.value as NamespaceEntrySource
          const entry = await source.lookup?.('Scripts\\common.j')
          expect(entry?.size).toBeGreaterThan(100_000)
          expect(await source.lookup?.('Scripts\\no-such-file.j')).toBeUndefined()
        } finally {
          await namespace.release()
        }
      } finally {
        await patch.session.dispose()
      }
    })

    it('reads every map Reforged ships in its storage, in the formats of 1.32 and later', async () => {
      const root = (await reforgedInstallation())?.normalizedPath
      if (root === undefined) return
      const { createContentSources } = (await import(pathToFileURL(join(extension, 'dist', 'game', 'content-sources.js')).href)) as typeof import('../dist/game/content-sources.js')
      const { readWar3Map } = (await import(pathToFileURL(join(extension, 'dist', 'war3-map', 'map.js')).href)) as typeof import('../dist/war3-map/map.js')
      const sources = await createContentSources({ installationDirectory: root })
      try {
        const maps: string[] = []
        let cursor: string | undefined
        do {
          const page = await sources.files!('local:warcraft3', '', { limit: 10_000, extensions: ['w3x', 'w3m'], ...(cursor === undefined ? {} : { cursor }) })
          maps.push(...page.items.map(item => item.path))
          cursor = page.nextCursor
        } while (cursor !== undefined)
        expect(maps.length).toBeGreaterThan(400)
        const unread: string[] = []
        for (const path of maps) {
          const reader = await openMpqReader(await sources.read('local:warcraft3', path, 256 << 20), {
            maxArchiveBytes: 1 << 30,
            maxEntries: 1 << 18,
            maxEntryBytes: 1 << 28,
          })
          try {
            const map = await readWar3Map(async name => {
              const found = reader.find(name)
              return found === undefined ? undefined : reader.read(found.id)
            })
            const [width = 0, height = 0] = map.terrain?.mapSize ?? []
            const agree = map.pathing?.size[0] === 4 * (width - 1) && map.pathing.size[1] === 4 * (height - 1)
            if (map.failures.length > 0 || map.info === undefined || !agree) unread.push(`${path}: ${JSON.stringify(map.failures)}`)
          } finally {
            reader.dispose()
          }
        }
        expect(unread).toEqual([])
      } finally {
        await sources.dispose()
      }
    }, 900_000)

    it("gives a Reforged map its tileset's overlays over the game", async () => {
      const root = (await reforgedInstallation())?.normalizedPath
      if (root === undefined) return
      const { createContentSources } = (await import(pathToFileURL(join(extension, 'dist', 'game', 'content-sources.js')).href)) as typeof import('../dist/game/content-sources.js')
      const sources = await createContentSources({ installationDirectory: root })
      const folder = await mkdtemp(join(tmpdir(), 'modkit-war3-reforged-tileset-'))
      try {
        const path = join(folder, 'BootyBay.w3m')
        await writeFile(path, await sources.read('local:warcraft3', 'maps/(2)bootybay.w3m', 64 << 20))
        const context = await sources.openModContext!({ schemaVersion: 1, target: path })
        try {
          // BootyBay is Lordaeron Summer: its cliffs' HD maps are the tileset's own, not the game's
          expect(context.layers.map(layer => layer.id)).toEqual(['war3-game', 'war3-tileset', 'primary'])
          const cliff = 'ReplaceableTextures/Cliff/Cliff0_diffuse.dds'
          const found = await context.locate!(cliff)
          expect(found?.layerId).toBe('war3-tileset')
          const own = await context.read(found!.layerId, found!.path, 64 << 20)
          const game = await sources.read('local:warcraft3', cliff, 64 << 20)
          expect(own.byteLength).not.toBe(game.byteLength)
          // what the tileset does not hold is the game's
          expect((await context.locate!('Units/Human/Footman/Footman.mdx'))?.layerId).toBe('war3-game')
        } finally {
          await context.dispose()
        }
      } finally {
        await sources.dispose()
        await rm(folder, { recursive: true, force: true })
      }
    })

    it('opens an HD model of Reforged within its manifest budget, its clips and their keys whole', async () => {
      const root = (await reforgedInstallation())?.normalizedPath
      if (root === undefined) return
      const { createContentSources } = (await import(pathToFileURL(join(extension, 'dist', 'game', 'content-sources.js')).href)) as typeof import('../dist/game/content-sources.js')
      const sources = await createContentSources({ installationDirectory: root })
      try {
        // HD Grunt: its keys alone outgrow the 1 000 000 nodes the codec's manifest grants a model;
        // the animation source and the export charge them by their own size
        const bytes = await sources.read('local:warcraft3', 'units/orc/grunt/grunt.mdx', 64 << 20)
        const manifest = { maxInputBytes: 1_073_741_824n, maxDepth: 64, maxNodes: 1_000_000, maxScalarBytes: 104_857_600, maxDiagnostics: 1000 }
        const session = await open(bytes, manifest)
        try {
          const animation = await session.dataSource('common.view/model-animation-source', 1)
          await animation.release()
          const exported = await session
            .operations()
            .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 0.01 })
          if (exported.state !== 'ok' || exported.output.kind !== 'bytes')
            throw new Error(`model.export-uvm: ${JSON.stringify(exported).slice(0, 300)}`)
          const document = readUvmContainer(exported.output.value as Uint8Array, { ...containerBudget, maxNodes: 16_000_000 })
            .document as { extensions: { UV_game_animation_clips?: { clips: unknown[] } } }
          expect(document.extensions.UV_game_animation_clips?.clips).toHaveLength(33)
        } finally {
          await session.dispose()
        }
      } finally {
        await sources.dispose()
      }
    }, 600_000)

    it('shows a Reforged melee map from CASC as a world, its objects, cliffs and water in HD', async () => {
      const root = (await reforgedInstallation())?.normalizedPath
      if (root === undefined) return
      const { createContentSources } = (await import(pathToFileURL(join(extension, 'dist', 'game', 'content-sources.js')).href)) as typeof import('../dist/game/content-sources.js')
      const sources = await createContentSources({ installationDirectory: root })
      const folder = await mkdtemp(join(tmpdir(), 'modkit-war3-reforged-world-'))
      try {
        // Reforged keeps its melee maps in the storage under maps/, in the formats of 1.32 and later
        const path = join(folder, 'BootyBay.w3m')
        await writeFile(path, await sources.read('local:warcraft3', 'maps/(2)bootybay.w3m', 64 << 20))
        const common = await host()
        const serviceDefinitions = createBundledServiceDefinitionRegistry()
        await registerServiceDefinitionsOrThrow(common.inventory, serviceDefinitions)
        const services = { inventory: common.inventory, target, executionBackends: common.executionBackends, serviceDefinitions }
        const opened = await openSubject({ ...common, serviceDefinitions, source: await openFileArtifactSource(path), path })
        if (opened.state !== 'opened') throw new Error(`BootyBay did not open: ${JSON.stringify(opened.diagnostics)}`)
        try {
          const preview = await coordinateMapPreviewAssetSession({
            services,
            grant: { id: 'war3-reforged-world', classes: ['read-source'] },
            budgets: budget,
            original: opened.session,
            resourcePlanResolver: createContentSourceMapPreviewResourcePlanResolver({ contentSources: async () => sources }),
            contentSources: sources,
            maxCandidates: 4,
            maxSubjectEntries: 4096,
            maxSubjectPages: 8,
            maxRoots: 4,
            maxDepth: 4,
            limits: {
              maxRequirements: 64,
              maxDocumentBytes: 32 << 20,
              maxTotalBytes: 128 << 20,
              maxObjects: 100_000,
              maxRegions: 1000,
              maxTerrainCells: 100_000,
              maxTerrainSamples: 100_000,
              maxDepth: 64,
              maxPageSize: 1024,
              maxDiagnostics: 500,
            },
          })
          if (preview.state !== 'opened') throw new Error(`${preview.state}: ${JSON.stringify(preview.diagnostics).slice(0, 3000)}`)
          try {
            expect(preview.snapshot).toMatchObject({ gameId: 'blizzard/warcraft-3', semantic: { terrain: { width: 193, height: 97 } } })
            const objects = preview.snapshot.semantic.objects
            expect(objects.filter(object => object.kind === 'feature').length).toBeGreaterThan(100)
            expect(objects.filter(object => object.kind !== 'point' && object.modelResource === undefined)).toEqual([])
            // every model the objects name reads from the storage, HD first
            const models = [...new Set(objects.flatMap(object => (object.modelResource === undefined ? [] : [object.modelResource.logicalId])))]
            const unread: string[] = []
            for (const id of models)
              if (!(await sources.read('local:warcraft3', id, 64 << 20).then(() => true, () => false))) unread.push(id)
            expect(unread).toEqual([])
            expect(preview.snapshot.cliffs?.pieces?.length).toBeGreaterThan(50)
            expect(preview.snapshot.water?.zones.length).toBeGreaterThan(0)
            const absent: string[] = []
            for (const model of preview.snapshot.cliffs?.pieceModels ?? []) {
              let found = false
              for (const candidate of model.candidates)
                found ||= await sources.read('local:warcraft3', candidate.requirement.logicalId, 16 << 20).then(() => true, () => false)
              if (!found) absent.push(model.id)
            }
            expect(absent).toEqual([])
          } finally {
            await preview.session.dispose()
          }
        } finally {
          await opened.session.dispose()
        }
      } finally {
        await sources.dispose()
        await rm(folder, { recursive: true, force: true })
      }
    }, 600_000)
  },
)
