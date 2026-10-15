import { driveModelEditPanel } from './model-edit-panel-proof.js'
import { proveSceneEffectBrowserPixels } from './scene-effect-browser-proof.js'
import {
  createWebSubjectServices,
  type WebDomGlobals,
  type WebExtensionCatalog,
  type WebSubjectServices,
} from '../../../../modkit-core/apps/web/src/subjects.js'
import {
  createWebEditingArm,
  sourceRevisionToken,
  sourceUriFor,
  type WebEditingArm,
} from '../../../../modkit-core/apps/web/src/editing.js'
import type { WebWritableFileHandleLike } from '../../../../modkit-core/apps/web/src/files.js'
import { createCompanionInputResolver } from '../../../../modkit-core/packages/host/src/input-resolution.js'
import {
  revisionId,
  type ArtifactByteSource,
  type JsonValue,
  type JsonObject,
  type OperationOutput,
  type PermissionGrant,
} from '@modkit/sdk'
import {
  readUvmContainer,
  writeUvmContainer,
  DEFAULT_UVM_CONTAINER_BUDGET,
  type UvmContainer,
} from '../../../../modkit-core/packages/uv/src/model/container.js'
import { appendUvmAccessors } from '../../../../modkit-core/packages/uv/src/model/accessor-write.js'
import { readUvmModel } from '@modkit/scene/uvm/model'
import { createModelSceneSampler } from '@modkit/scene/model'

const budget = {
  maxInputBytes: 268_435_456n,
  maxDepth: 128,
  maxNodes: 1_000_000,
  maxScalarBytes: 268_435_456,
  maxDiagnostics: 1000,
}
const grant: PermissionGrant = {
  id: 'm3-browser-host-opfs',
  classes: ['read-source', 'write-source'],
}
const parameterPath =
  '/materials/0/extensions/UV_game_material/params/renderModel/standard/specularity'
type OpenedSubject = Extract<
  Awaited<ReturnType<WebSubjectServices['open']>>,
  { readonly state: 'opened' }
>
interface EnumerableDirectory {
  entries(): AsyncIterable<readonly [string, FileSystemHandle]>
}

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
function object(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected object')
  return value as Record<string, unknown>
}
function directoryEntries(handle: FileSystemDirectoryHandle) {
  check(
    'entries' in handle && typeof handle.entries === 'function',
    'OPFS enumeration is unavailable',
  )
  return (handle as FileSystemDirectoryHandle & EnumerableDirectory).entries()
}
function fixtureBytes(value: unknown): Uint8Array<ArrayBuffer> {
  check(
    Array.isArray(value) &&
      value.length > 0 &&
      value.every(item => Number.isInteger(item) && item >= 0 && item <= 255),
    'invalid fixture bytes',
  )
  return Uint8Array.from(value as number[])
}
function describe(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item,
  )
}
type BrowserPerformanceMemory = Performance & {
  readonly memory?: {
    readonly usedJSHeapSize: number
    readonly totalJSHeapSize: number
    readonly jsHeapSizeLimit: number
  }
}
function heapSample(): number | null {
  const value = (performance as BrowserPerformanceMemory).memory?.usedJSHeapSize
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
function browserEnvironment() {
  const extendedNavigator = navigator as Navigator & { readonly deviceMemory?: number }
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl2')
  const debug = gl?.getExtension('WEBGL_debug_renderer_info')
  const environment = {
    userAgent: navigator.userAgent,
    logicalCpuCount: navigator.hardwareConcurrency,
    deviceMemoryGiB: extendedNavigator.deviceMemory ?? null,
    webgl: {
      version: gl === null ? null : String(gl.getParameter(gl.VERSION)),
      shadingLanguageVersion:
        gl === null ? null : String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION)),
      vendor:
        gl === null
          ? null
          : String(gl.getParameter(debug?.UNMASKED_VENDOR_WEBGL ?? gl.VENDOR)),
      renderer:
        gl === null
          ? null
          : String(gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER)),
    },
  }
  gl?.getExtension('WEBGL_lose_context')?.loseContext()
  return environment
}
async function hash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
async function fileBytes(handle: FileSystemFileHandle): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await (await handle.getFile()).arrayBuffer())
}
async function write(handle: FileSystemFileHandle, bytes: Uint8Array): Promise<void> {
  const stream = await handle.createWritable()
  try {
    await stream.write(Uint8Array.from(bytes))
    await stream.close()
  } catch (error) {
    await stream.abort(error).catch(() => undefined)
    throw error
  }
}
function source(file: File, entryId: string): ArtifactByteSource {
  const uri = sourceUriFor(entryId)
  return {
    kind: 'bytes',
    ref: { id: uri, uri },
    revision: revisionId(sourceRevisionToken(file)),
    size: BigInt(file.size),
    async read(offset, length, signal) {
      signal?.throwIfAborted()
      const start = Number(offset)
      check(
        Number.isSafeInteger(start) &&
          Number.isSafeInteger(length) &&
          start >= 0 &&
          length >= 0 &&
          start + length <= file.size,
        'source range is outside the pinned OPFS snapshot',
      )
      return new Uint8Array(await file.slice(start, start + length).arrayBuffer())
    },
    async *stream(range, signal) {
      const start = range?.offset ?? 0n
      const length = Number(range?.length ?? BigInt(file.size) - start)
      yield await this.read(start, length, signal)
    },
  }
}
async function invoke(
  opened: OpenedSubject,
  id: string,
  input: JsonValue,
): Promise<OperationOutput> {
  const operation = opened.descriptor.operations.find(item => item.id === id)
  check(operation?.state === 'available', `${id} is unavailable`)
  const result = await opened.session.operations().invoke(operation.handlerId, input)
  check(result.state === 'ok', `${id} failed: ${describe(result)}`)
  return result.output
}
async function exportUvm(opened: OpenedSubject): Promise<Uint8Array> {
  const output = await invoke(opened, 'model.export-uvm', {
    schemaVersion: 1,
    metersPerSourceUnit: 2,
  })
  check(output.kind === 'bytes', 'UVM export did not return bytes')
  return output.value
}
function specularity(bytes: Uint8Array): number {
  const document = readUvmContainer(bytes).document
  let value: unknown = document
  for (const key of parameterPath.slice(1).split('/')) {
    value = Array.isArray(value) ? value[Number(key)] : object(value)[key]
  }
  check(typeof value === 'number', 'material specularity is absent')
  return value
}
function editRequest(value: number): JsonValue {
  return {
    schemaVersion: 1,
    metersPerSourceUnit: 2,
    json: [{ op: 'replace', path: parameterPath, value }],
  }
}

function freshTriangle(program: JsonObject): UvmContainer {
  const container: UvmContainer = {
    format: 'glb',
    binary: new Uint8Array(),
    extraChunks: [],
    document: {
      asset: { version: '2.0', extras: { uv: { format: 'UVM', version: '1.0', profile: 'core' } } },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, translation: [3, 4, 5], scale: [2, 2, 2] }],
      materials: [
        {
          name: 'Paint',
          extensions: {
            UV_game_material: { shader: 'modkit.render-material.v1', params: program },
          },
        },
      ],
      extensionsUsed: ['UV_asset', 'UV_provenance', 'UV_game_material'],
      extensions: {
        UV_asset: { id: 'portable-fresh-triangle', class: 'model' },
        UV_provenance: {
          source: { format: 'uvm' },
          importer: { id: 'authored-browser-fixture', version: '1' },
        },
      },
    },
  }
  const appended = appendUvmAccessors(
    container,
    [
      { type: 'VEC3', values: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0) },
      { type: 'SCALAR', values: Uint32Array.of(0, 1, 2) },
      { type: 'VEC3', values: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1) },
      { type: 'VEC4', values: Float32Array.of(1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1) },
      { type: 'VEC4', values: Float32Array.of(1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1) },
      { type: 'VEC2', values: Float32Array.of(0, 0, 1, 0, 0, 1) },
    ],
    { ...DEFAULT_UVM_CONTAINER_BUDGET, maxScalarBytes: budget.maxScalarBytes },
  )
  const accessor = (index: number): number => {
    const value = appended.accessors[index]
    check(value !== undefined, 'fresh triangle accessor absent')
    return value
  }
  return {
    ...appended.container,
    document: {
      ...appended.container.document,
      meshes: [
        {
          primitives: [
            {
              mode: 4,
              indices: accessor(1),
              material: 0,
              attributes: {
                POSITION: accessor(0),
                NORMAL: accessor(2),
                TANGENT: accessor(3),
                COLOR_0: accessor(4),
                TEXCOORD_0: accessor(5),
                TEXCOORD_1: accessor(5),
                TEXCOORD_2: accessor(5),
                TEXCOORD_3: accessor(5),
              },
            },
          ],
        },
      ],
    },
  }
}

function freshWorldPositions(container: UvmContainer): number[] {
  const model = readUvmModel(container.document, container.binary, budget)
  const sampled = createModelSceneSampler(
    { ...model.scene, skeleton: model.rig.bindings },
    { maxBytes: budget.maxScalarBytes },
  ).sample(0)
  check(sampled.primitives.length === 1, 'portable fresh primitive count differs')
  const primitive = sampled.primitives[0]
  check(
    primitive !== undefined && primitive.indices !== undefined,
    'portable fresh geometry absent',
  )
  check(
    JSON.stringify(Array.from(primitive.indices)) === '[0,1,2]',
    'portable fresh indices differ',
  )
  const output: number[] = [],
    matrix = primitive.transform
  if (matrix === undefined) return Array.from(primitive.positions)
  for (let index = 0; index < primitive.positions.length; index += 3)
    for (let row = 0; row < 3; row++) {
      const x = primitive.positions[index],
        y = primitive.positions[index + 1],
        z = primitive.positions[index + 2]
      const a = matrix[row],
        b = matrix[row + 4],
        c = matrix[row + 8],
        d = matrix[row + 12]
      check(
        x !== undefined &&
          y !== undefined &&
          z !== undefined &&
          a !== undefined &&
          b !== undefined &&
          c !== undefined &&
          d !== undefined,
        'portable position frame incomplete',
      )
      output.push(Math.fround(a * x + b * y + c * z + d))
    }
  return output
}

function firstMaterialProgram(container: UvmContainer): JsonObject {
  const materials = container.document['materials']
  check(Array.isArray(materials), 'fresh material table absent')
  return object(
    object(object(object(materials[0])['extensions'])['UV_game_material'])['params'],
  ) as JsonObject
}

/** Actual web composition and OPFS; only the directory grant is origin-owned instead of picked. */
export async function run(input: unknown): Promise<unknown> {
  const request = object(input)
  const catalog = object(request['catalog'])
  check(catalog['schemaVersion'] === 1 && Array.isArray(catalog['extensions']), 'invalid catalog')
  const fixtures = object(request['fixtures'])
  const native = fixtureBytes(fixtures['native'])
  const m3a = fixtureBytes(fixtures['m3a'])
  const root = await navigator.storage.getDirectory()
  const directoryName = `m3-browser-host-${crypto.randomUUID()}`
  const directory = await root.getDirectoryHandle(directoryName, { create: true })
  const sessions: OpenedSubject[] = []
  const handles = new Map<string, FileSystemFileHandle>()
  const diagnostics: { code: string; message: string }[] = []
  const notices: string[] = []
  const dirty: { entryId: string; dirty: boolean }[] = []
  let services: WebSubjectServices | undefined
  let arm: WebEditingArm | undefined
  let stage = 'composition'
  const started = performance.now()
  const enter = (name: string): void => {
    stage = name
    console.info(`[m3-host-stage] ${Math.round(performance.now() - started)}ms ${name}`)
  }
  enter(stage)
  try {
    const baseUrl = new URL('/', location.href).href
    services = await createWebSubjectServices({
      baseUrl,
      catalog: catalog as unknown as WebExtensionCatalog,
      identity: { operatingSystem: 'windows', architecture: 'x64' },
      workerUrl: new URL('worker-entry.js', baseUrl).href,
      moduleMap: {},
      dom: {
        fetch: globalThis.fetch.bind(globalThis),
        subtle: {
          digest: (algorithm, data) => crypto.subtle.digest(algorithm, Uint8Array.from(data)),
        },
        // These casts reconcile readonly structural host signatures with DOM overloads. The
        // values passed are the actual browser constructors and URL object, without substitutes.
        Blob: Blob as unknown as WebDomGlobals['Blob'],
        objectUrls: URL as unknown as WebDomGlobals['objectUrls'],
        Worker: Worker as unknown as WebDomGlobals['Worker'],
        MessageChannel: MessageChannel as unknown as WebDomGlobals['MessageChannel'],
      },
      onDiagnostic: diagnostic =>
        diagnostics.push({ code: diagnostic.code, message: diagnostic.message }),
    })
    const host = services
    const nativeHandle = await directory.getFileHandle('Harbinger.m3', { create: true })
    const animationHandle = await directory.getFileHandle('standalone.m3a', { create: true })
    await write(nativeHandle, native)
    await write(animationHandle, m3a)
    const entryIdFor = (name: string): string => `${directoryName}/${name}`
    handles.set(sourceUriFor(entryIdFor(nativeHandle.name)), nativeHandle)
    handles.set(sourceUriFor(entryIdFor(animationHandle.name)), animationHandle)
    arm = createWebEditingArm({
      inventory: host.inventory,
      handleFor: id => handles.get(id) as unknown as WebWritableFileHandleLike | undefined,
      onNotice: message => notices.push(message),
      onDirty: (entryId, value) => dirty.push({ entryId, dirty: value }),
      // OPFS grants belong to this origin. No external file picker or permission dialog is faked.
      ensureWriteAccess: async () => 'granted',
      maxPayloadBytes: budget.maxScalarBytes,
      maxInlinePayloadBytes: budget.maxScalarBytes,
    })
    const editing = arm
    const open = async (handle: FileSystemFileHandle): Promise<OpenedSubject> => {
      const snapshot = await handle.getFile()
      const origin = createCompanionInputResolver({
        primaryLogicalId: handle.name,
        caseSensitivity: 'sensitive',
        scopes: ['sibling-directory'],
        async *enumerate(_scope, options, signal) {
          for await (const [name, child] of directoryEntries(directory)) {
            signal?.throwIfAborted()
            if (child.kind === 'file' && name.startsWith(options.prefix)) yield { logicalId: name }
          }
        },
        async open(logicalId, signal) {
          signal?.throwIfAborted()
          check(
            !/[\\/]/u.test(logicalId) && logicalId !== '.' && logicalId !== '..',
            'invalid OPFS child',
          )
          const child = await directory.getFileHandle(logicalId)
          return {
            value: source(await child.getFile(), entryIdFor(logicalId)),
            release: async () => undefined,
          }
        },
      })
      const result = await host.open({
        source: source(snapshot, entryIdFor(handle.name)),
        path: handle.name,
        intent: 'full',
        grant,
        budget,
        resolveInput: origin,
      })
      check(result.state === 'opened', `host open failed: ${describe(result)}`)
      check(result.selected.variantId === 'portable', 'host did not select portable variant')
      sessions.push(result)
      return result
    }
    const editorFor = async (opened: OpenedSubject, handle = nativeHandle) => {
      const editor = editing.editorFor({
        entryId: entryIdFor(handle.name),
        name: handle.name,
        opened,
        grant,
        bytes: await fileBytes(handle),
      })
      check(editor !== undefined, `web editing arm unavailable: ${notices.join('; ')}`)
      return editor
    }

    const benchmarkModel = async (name: string, bytes: Uint8Array<ArrayBuffer>) => {
      const handle = await directory.getFileHandle(`${name}.m3`, { create: true })
      await write(handle, bytes)
      const heapSamples: Array<{ phase: string; usedJsHeapBytes: number | null }> = [
        { phase: 'before-open', usedJsHeapBytes: heapSample() },
      ]
      const loadStarted = performance.now()
      const subject = await open(handle)
      const uvm = await exportUvm(subject)
      const initialLoadMs = performance.now() - loadStarted
      heapSamples.push({ phase: 'after-load', usedJsHeapBytes: heapSample() })

      const container = readUvmContainer(uvm)
      const model = readUvmModel(container.document, container.binary, budget)
      const clip = model.rig.clips[0]
      const sampler = createModelSceneSampler(
        { ...model.scene, skeleton: model.rig.bindings },
        { maxBytes: budget.maxScalarBytes, ...(clip === undefined ? {} : { clip }) },
      )
      const seekTimesMs: number[] = []
      for (const time of [0, 0.25, 0.75, 0.1, 1]) {
        const seekStarted = performance.now()
        sampler.sample(time)
        seekTimesMs.push(performance.now() - seekStarted)
      }
      heapSamples.push({ phase: 'after-seek', usedJsHeapBytes: heapSample() })

      const renderTimesMs: number[] = []
      for (const time of [0, 0.25, 0.75]) {
        const renderStarted = performance.now()
        const frame = await invoke(subject, 'model.render', {
          schemaVersion: 1,
          metersPerSourceUnit: 2,
          viewport: { width: 64, height: 64 },
          camera: {
            viewProjection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
            viewMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          },
          time,
          clearColor: [0, 0, 0, 1],
          rendererId: 'modkit.browser-webgl',
          collisions: false,
          ...(clip === undefined ? {} : { clipId: clip.id }),
        })
        check(frame.kind === 'bytes', `${name} benchmark frame is not bytes`)
        renderTimesMs.push(performance.now() - renderStarted)
      }
      heapSamples.push({ phase: 'after-render', usedJsHeapBytes: heapSample() })

      await subject.session.dispose()
      check(subject.session.state() === 'disposed', `${name} benchmark session remained live`)
      const sessionIndex = sessions.indexOf(subject)
      check(sessionIndex >= 0, `${name} benchmark session was not tracked`)
      sessions.splice(sessionIndex, 1)
      heapSamples.push({ phase: 'after-dispose', usedJsHeapBytes: heapSample() })
      const observed = heapSamples
        .map(sample => sample.usedJsHeapBytes)
        .filter((value): value is number => value !== null)
      return {
        sourceBytes: bytes.byteLength,
        uvmBytes: uvm.byteLength,
        initialLoadMs,
        seekTimesMs,
        renderTimesMs,
        animationClip: clip?.id ?? null,
        heap: {
          measurement: 'sampled usedJSHeapSize; no forced garbage collection',
          supported: observed.length > 0,
          peakObservedBytes: observed.length === 0 ? null : Math.max(...observed),
          samples: heapSamples,
        },
        resourceRelease: { disposeCompleted: true, sessionState: subject.session.state() },
      }
    }

    enter('M3 open and conversion')
    const opened = await open(nativeHandle)
    const beforeUvm = await exportUvm(opened)
    enter('portable fresh UVM native write')
    // The compatibility seed supplies only a complete constant-color material program.
    // The tested fresh working document owns independent geometry and no native envelope.
    const seedWrite = await invoke(opened, 'model.write', {
      schemaVersion: 1,
      options: { includeTextures: false },
      model: {
        meshes: [
          {
            name: 'Seed',
            primitiveTopology: 'triangles',
            materialIndex: 0,
            positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
            indices: [0, 1, 2],
          },
        ],
        materials: [{ name: 'Paint', layers: [], baseColor: [1, 0.5, 0, 1] }],
        skeleton: { bones: [] },
        animations: [],
        effects: { particles: [], ribbons: [] },
        bounds: null,
      },
    })
    check(seedWrite.kind === 'bytes', 'portable material seed encode failed')
    const seedHandle = await directory.getFileHandle('fresh-material-seed.m3', { create: true })
    await write(seedHandle, seedWrite.value)
    const seedOpened = await open(seedHandle)
    const freshDocument = freshTriangle(
      firstMaterialProgram(readUvmContainer(await exportUvm(seedOpened))),
    )
    check(
      freshDocument.document['extras'] === undefined,
      'portable fresh fixture has a native envelope',
    )
    const freshInput = writeUvmContainer(freshDocument)
    const freshWrite = await invoke(opened, 'model.write', {
      schemaVersion: 1,
      uvmBytesHex: Array.from(freshInput, value => value.toString(16).padStart(2, '0')).join(''),
      metersPerNativeUnit: 2,
    })
    check(freshWrite.kind === 'bytes', 'portable fresh write did not return bytes')
    const freshHandle = await directory.getFileHandle('fresh-authored.m3', { create: true })
    await write(freshHandle, freshWrite.value)
    const freshOpened = await open(freshHandle),
      freshReopened = readUvmContainer(await exportUvm(freshOpened))
    const freshExpected = freshWorldPositions(freshDocument),
      freshActual = freshWorldPositions(freshReopened)
    check(
      JSON.stringify(freshActual) === JSON.stringify(freshExpected),
      'portable fresh geometry differs',
    )
    check(
      JSON.stringify(freshActual) === '[3,4,5,5,4,5,3,6,5]',
      'portable authored triangle changed',
    )
    check(
      JSON.stringify(firstMaterialProgram(freshReopened)) ===
        JSON.stringify(firstMaterialProgram(freshDocument)),
      'portable fresh material differs',
    )
    const freshEvidence = {
      state: 'passed',
      sourceEnvelope: false,
      inputHash: await hash(freshInput),
      nativeHash: await hash(freshWrite.value),
      positions: freshActual,
    }
    const originalValue = specularity(beforeUvm)
    check(originalValue !== 16 && originalValue !== 32, 'fixture already has the edit values')
    enter('M3 renderer capability transport')
    const rendered = await invoke(opened, 'model.render', {
      schemaVersion: 1,
      metersPerSourceUnit: 2,
      viewport: { width: 64, height: 64 },
      camera: {
        viewProjection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        viewMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      },
      time: 0.25,
      clearColor: [0, 0, 0, 1],
      rendererId: 'modkit.browser-webgl',
      collisions: false,
    })
    check(rendered.kind === 'bytes', 'renderer capability did not return PNG bytes')
    check(
      rendered.value.length > 24 &&
        [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => rendered.value[index] === byte),
      'renderer capability output is not a PNG',
    )
    const pngHeader = new DataView(
      rendered.value.buffer,
      rendered.value.byteOffset,
      rendered.value.byteLength,
    )
    check(
      pngHeader.getUint32(16) === 64 && pngHeader.getUint32(20) === 64,
      'unexpected PNG dimensions',
    )
    enter('M3 edit planning')
    const nativeHash = await hash(native)
    const beforeContainer = readUvmContainer(beforeUvm)
    const beforeExtensions = object(beforeContainer.document['extensions'])
    const beforeM3 = object(object(beforeContainer.document['extras'])['BlizzardM3'])
    check(beforeExtensions['UV_source_blob'] === undefined, 'M3 UVM contains a source blob')
    check(
      beforeM3['schemaVersion'] === 1 && beforeM3['format'] === 'm3',
      'M3 UVM does not use the source-free BlizzardM3 profile',
    )
    const editor = await editorFor(opened)
    let formReopened: OpenedSubject | undefined
    const formProof = await driveModelEditPanel({
      descriptor: opened.descriptor,
      operations: opened.session.operations(),
      editor,
      input: editRequest(16),
      assertUnchanged: async () => {
        check(
          (await hash(await fileBytes(nativeHandle))) === nativeHash,
          'form planning wrote OPFS',
        )
      },
      reopen: async () => {
        formReopened = await open(nativeHandle)
        check(
          specularity(await exportUvm(formReopened)) === 16,
          'form reopened M3 does not contain 16',
        )
        return formReopened.descriptor
      },
    })
    const plan = formProof.plan,
      editPlanningMs = formProof.elapsedMs
    const afterHash = await hash(await fileBytes(nativeHandle))
    check(afterHash !== nativeHash, 'form apply did not change native bytes')
    check(formReopened !== undefined, 'form did not reopen native model')
    const reopened = formReopened

    enter('M3 history through web commit ports')
    const historyEditor = await editorFor(reopened)
    const historyPlan = historyEditor.planFromOperation(
      await invoke(reopened, 'model.edit', editRequest(32)),
    )
    const authorized = await historyEditor.ports.authorization.request(historyPlan)
    check(authorized !== undefined, 'history edit not authorized')
    const options = { grant: authorized.grant }
    const prepared = await historyEditor.ports.commit.prepare(historyPlan, options)
    check(prepared.state === 'ready', `history prepare failed: ${describe(prepared)}`)
    const committed = await historyEditor.ports.commit.commit(prepared.prepared, options)
    check(committed.state === 'committed', `history commit failed: ${describe(committed)}`)
    const historyHash = await hash(await fileBytes(nativeHandle))
    check(historyHash !== afterHash, 'history edit did not change bytes')
    const undone = await historyEditor.ports.commit.undo(committed.receipt.transactionId, options)
    check(undone.state === 'committed', `undo failed: ${describe(undone)}`)
    check(
      (await hash(await fileBytes(nativeHandle))) === afterHash,
      'undo did not restore exact 16 bytes',
    )
    const redone = await historyEditor.ports.commit.redo(committed.receipt.transactionId, options)
    check(redone.state === 'committed', `redo failed: ${describe(redone)}`)
    check(
      (await hash(await fileBytes(nativeHandle))) === historyHash,
      'redo did not restore exact 32 bytes',
    )
    const historyReopened = await open(nativeHandle)
    check(
      specularity(await exportUvm(historyReopened)) === 32,
      'history reopen does not contain 32',
    )

    enter('stale plan refusal')
    const stale = await editor.applyPlan(plan)
    check(stale.failed, 'old plan was applied over a newer file revision')
    check(
      (await hash(await fileBytes(nativeHandle))) === historyHash,
      'stale plan changed OPFS bytes',
    )

    enter('M3A host conversion')
    const animation = await open(animationHandle)
    enter('M3A opened; export UVM')
    const animationUvm = await exportUvm(animation)
    enter('M3A exported; verify source')
    const animationHash = await hash(m3a)
    const animationContainer = readUvmContainer(animationUvm)
    const animationExtensions = object(animationContainer.document['extensions'])
    const animationM3 = object(object(animationContainer.document['extras'])['BlizzardM3'])
    check(animationExtensions['UV_source_blob'] === undefined, 'M3A UVM contains a source blob')
    check(
      animationM3['schemaVersion'] === 1 && animationM3['format'] === 'm3a',
      'M3A UVM does not use the source-free BlizzardM3 profile',
    )
    const animationEdit = animation.descriptor.operations.find(
      operation => operation.id === 'model.edit',
    )
    check(animationEdit?.state === 'available', 'standalone M3A edit is unavailable')
    let materialRefusal: string | undefined
    enter('M3A unsupported material edit refusal')
    try {
      await invoke(animation, 'model.edit', editRequest(16))
    } catch (error) {
      materialRefusal = error instanceof Error ? error.message : String(error)
    }
    check(
      materialRefusal !== undefined &&
        /JSON Pointer (?:array index is out of bounds|target does not exist)/u.test(
          materialRefusal,
        ),
      `standalone M3A did not reject its absent material path: ${materialRefusal ?? 'accepted'}`,
    )
    check(
      (await hash(await fileBytes(animationHandle))) === animationHash,
      'M3A conversion changed OPFS',
    )

    enter('M3A sequence rename through UVM and web history')
    const sequenceDocument = (uvm: Uint8Array) => readUvmContainer(uvm).document
    const stringPaths = (value: unknown, expected: string) => {
      const paths: string[] = []
      const visit = (item: unknown, path: string) => {
        if (item === expected) {
          paths.push(path)
          return
        }
        if (Array.isArray(item))
          return item.forEach((child, index) => visit(child, `${path}/${index}`))
        if (item === null || typeof item !== 'object') return
        for (const [key, child] of Object.entries(item)) visit(child, `${path}/${key}`)
      }
      visit(value, '')
      return paths
    }
    const animationDocument = sequenceDocument(animationUvm)
    const animationName = (document: JsonObject) => {
      const animations = document['animations']
      if (!Array.isArray(animations)) return undefined
      const animation = animations[0]
      if (animation === null || typeof animation !== 'object' || Array.isArray(animation))
        return undefined
      return animation['name']
    }
    const originalName = animationName(animationDocument)
    check(typeof originalName === 'string', 'M3A original sequence name absent')
    const newName = `${originalName}_UVM_browser_rename`
    const json = stringPaths(animationDocument, originalName).map(path => ({
      op: 'replace' as const,
      path,
      value: newName,
    }))
    check(json.length > 0, 'M3A canonical sequence paths absent')
    const animationEditor = await editorFor(animation, animationHandle)
    const animationPlan = animationEditor.planFromOperation(
      await invoke(animation, 'model.edit', { schemaVersion: 1, metersPerSourceUnit: 2, json }),
    )
    check(
      (await hash(await fileBytes(animationHandle))) === animationHash,
      'M3A sequence planning wrote OPFS',
    )
    const animationAuthorization = await animationEditor.ports.authorization.request(animationPlan)
    check(animationAuthorization !== undefined, 'M3A sequence rename not authorized')
    const animationOptions = { grant: animationAuthorization.grant }
    const animationPrepared = await animationEditor.ports.commit.prepare(
      animationPlan,
      animationOptions,
    )
    check(animationPrepared.state === 'ready', `M3A prepare failed: ${describe(animationPrepared)}`)
    const animationCommitted = await animationEditor.ports.commit.commit(
      animationPrepared.prepared,
      animationOptions,
    )
    check(
      animationCommitted.state === 'committed',
      `M3A commit failed: ${describe(animationCommitted)}`,
    )
    const animationEditedHash = await hash(await fileBytes(animationHandle))
    check(animationEditedHash !== animationHash, 'M3A sequence rename did not change bytes')
    const animationReopened = await open(animationHandle)
    const reopenedName = animationName(sequenceDocument(await exportUvm(animationReopened)))
    check(reopenedName === newName, 'reopened M3A did not retain the longer sequence name')
    const animationUndone = await animationEditor.ports.commit.undo(
      animationCommitted.receipt.transactionId,
      animationOptions,
    )
    check(animationUndone.state === 'committed', `M3A undo failed: ${describe(animationUndone)}`)
    check(
      (await hash(await fileBytes(animationHandle))) === animationHash,
      'M3A undo did not restore exact original bytes',
    )
    const animationRedone = await animationEditor.ports.commit.redo(
      animationCommitted.receipt.transactionId,
      animationOptions,
    )
    check(animationRedone.state === 'committed', `M3A redo failed: ${describe(animationRedone)}`)
    check(
      (await hash(await fileBytes(animationHandle))) === animationEditedHash,
      'M3A redo did not restore exact renamed bytes',
    )

    enter('Nested native model through worker resource capability')
    const nestedParentBytes = fixtureBytes(fixtures['nestedParent'])
    const nestedChildBytes = fixtureBytes(fixtures['nestedChild'])
    const nestedHandle = await directory.getFileHandle('ParticleParent.m3', { create: true })
    const nestedChildHandle = await directory.getFileHandle('ParticleChild.m3', { create: true })
    await write(nestedHandle, nestedParentBytes)
    await write(nestedChildHandle, nestedChildBytes)
    const nestedOpened = await open(nestedHandle)
    const nestedDocument = readUvmContainer(await exportUvm(nestedOpened)).document
    const nestedClip = readUvmAnimationClips(nestedDocument)?.[0]
    const nestedOperation = nestedOpened.descriptor.operations.find(
      item => item.id === 'model.render',
    )
    check(nestedOperation?.state === 'available', 'nested render operation absent')
    const nestedRender = await nestedOpened.session.operations().invoke(nestedOperation.handlerId, {
      schemaVersion: 1,
      metersPerSourceUnit: 1,
      viewport: { width: 16, height: 16 },
      camera: {
        viewProjection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        viewMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      },
      time: 0.8,
      rendererId: 'modkit.browser-webgl',
      ...(nestedClip === undefined ? {} : { clipId: nestedClip.id }),
    })
    check(
      nestedRender.state === 'ok' && nestedRender.output.kind === 'bytes',
      `nested render failed: ${describe(nestedRender)}`,
    )
    check(
      !nestedRender.diagnostics.some(item => item.code === 'common.uvm/model-particle-unrendered'),
      `nested consumer refused: ${describe(nestedRender.diagnostics)}`,
    )
    check(
      nestedOpened.resources
        ?.provenance()
        .some(item => item.logicalId === 'ParticleChild.m3' && item.state === 'resolved'),
      'worker never resolved its native model child',
    )
    check(
      (await hash(await fileBytes(nestedHandle))) === (await hash(nestedParentBytes)),
      'nested render changed parent source',
    )
    check(
      (await hash(await fileBytes(nestedChildHandle))) === (await hash(nestedChildBytes)),
      'nested render changed child source',
    )
    const nestedModels = {
      nativeChildResolved: true,
      sourceUnchanged: true,
      outputBytes: nestedRender.output.value.byteLength,
    }

    enter('Common WebGL effect pixel proof')
    const effectPixels = await proveSceneEffectBrowserPixels()
    enter('M3 performance and resource lifetime receipt')
    const performanceReceipt = {
      schemaVersion: 1,
      scope: 'non-normative browser-worker measurements on this host',
      renderer: 'modkit.browser-webgl',
      viewport: { width: 64, height: 64 },
      samples: { seek: 5, render: 3 },
      frameMeasurement: 'end-to-end host operation including WebGL readback and PNG encoding',
      environment: browserEnvironment(),
      budgets: {
        maxInputBytes: budget.maxInputBytes.toString(),
        maxDepth: budget.maxDepth,
        maxNodes: budget.maxNodes,
        maxScalarBytes: budget.maxScalarBytes,
        maxDiagnostics: budget.maxDiagnostics,
      },
      small: await benchmarkModel('benchmark-small', fixtureBytes(fixtures['benchmarkSmall'])),
      large: await benchmarkModel('benchmark-large', fixtureBytes(fixtures['benchmarkLarge'])),
    }
    return {
      state: 'passed',
      boundary:
        'Production web inventory, verified portable activation, native module workers and RPC; real OPFS handles and web editing arm. No file-picker UI or multi-binding writes exercised.',
      runtime: {
        secureContext: isSecureContext,
        target: host.target.environment,
        process: typeof Reflect.get(globalThis, 'process'),
        require: typeof Reflect.get(globalThis, 'require'),
        Buffer: typeof Reflect.get(globalThis, 'Buffer'),
      },
      m3: {
        nestedModels,
        effectPixels,
        performanceReceipt,
        freshWrite: freshEvidence,
        editForm: formProof.evidence,
        selected: opened.selected,
        operations: opened.descriptor.operations.map(operation => ({
          id: operation.id,
          state: operation.state,
        })),
        sourceHash: nativeHash,
        editedHash: afterHash,
        historyHash,
        originalValue,
        editPlanningMs,
        render: {
          rendererId: 'modkit.browser-webgl',
          width: 64,
          height: 64,
          bytes: rendered.value.byteLength,
          sha256: await hash(rendered.value),
          boundary:
            'Actual host capability RPC and PNG dimensions; identity camera is not a pixel-fidelity assertion.',
        },
        reopenedValue: 16,
        historyValue: 32,
        apply: formProof.applied,
        undo: undone.state,
        redo: redone.state,
        stale,
      },
      m3a: {
        selected: animation.selected,
        sourceHash: animationHash,
        sourcePreserved: true,
        unsupportedMaterialEdit: 'rejected',
        materialRefusal,
        renamed: true,
        originalName,
        newName,
        reopenedName,
        editedHash: animationEditedHash,
        undo: animationUndone.state,
        redo: animationRedone.state,
      },
      diagnostics,
      notices,
      dirty,
    }
  } catch (error) {
    throw new Error(`${stage}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  } finally {
    const cleanup = await Promise.allSettled(sessions.map(opened => opened.session.dispose()))
    await arm?.dispose()
    await services?.dispose()
    await root.removeEntry(directoryName, { recursive: true })
    const failure = cleanup.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected')
      throw new Error('browser host session cleanup failed', { cause: failure.reason })
  }
}
import { readUvmAnimationClips } from '@modkit/uv/model/animation-clips'
