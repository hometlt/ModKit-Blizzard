import { describe, expect, it } from 'vitest'
import {
  type AssetSource,
  findDanglingDiagnosticIds,
  isSerializableDescriptor,
  operationHandlerId,
  referencedDiagnosticIds,
  resolveContributions,
} from '@modkit/codec-kit/legacy/assets'
import {
  createSc2LayoutCodec,
  detectSc2Layout,
  readSc2Layout,
} from '../../shared/format/codec.js'
import {
  SC2_LAYOUT_WORKSPACE_DIAGNOSTIC_ID,
} from '../../shared/format/describe.js'
import {
  SC2_LAYOUT_MAX_SNIFF_BYTES,
  detectSc2LayoutBytes,
} from '../../shared/format/detect.js'
import {
  createSc2LayoutDocumentFromParsed,
  parseSc2Layout,
} from '../../shared/format/document.js'
import {
  SC2_LAYOUT_CODEC_ID,
} from '../../shared/format/identity.js'
import { LAYOUT_OPERATION_IDS } from '../../shared/layout-engine/operations.js'
import { LAYOUT_BYTES, fixtureSource } from './fixtures.js'

const codec = createSc2LayoutCodec()

describe('sc2-layout detection', () => {
  it('keeps the compatibility source wrapper equivalent to the owned-bytes detector', async () => {
    const source = fixtureSource()
    const bytes = await source.read()

    await expect(detectSc2Layout(source, {})).resolves.toEqual(
      detectSc2LayoutBytes(bytes, source.descriptor, {}),
    )
  })

  it('uses bounded Desc-root and SC2 declaration evidence', async () => {
    const result = await codec.detect(fixtureSource(), {})
    expect(result.pluginId).toBe(SC2_LAYOUT_CODEC_ID)
    expect(result.confidence).toBeGreaterThan(0.8)
    expect(
      result.evidence.some(
        evidence => evidence.kind === 'structure' && evidence.detail?.includes('declaration'),
      ),
    ).toBe(true)
    expect(result.requiredRanges).toHaveLength(1)
    expect(result.requiredRanges[0]?.length).toBeLessThanOrEqual(SC2_LAYOUT_MAX_SNIFF_BYTES)
  })

  it('rejects an extension-only candidate with unrelated XML', async () => {
    const result = await codec.detect(
      fixtureSource(new TextEncoder().encode('<NotLayout/>'), 'Fake.SC2Layout'),
      {},
    )
    expect(result.confidence).toBe(0)
    expect(
      result.evidence.some(
        evidence => evidence.kind === 'structure' && evidence.polarity === 'negative',
      ),
    ).toBe(true)
  })

  it('recognizes an extensionless structurally strong layout', async () => {
    const result = await codec.detect(fixtureSource(LAYOUT_BYTES, 'EmbeddedLayout'), {})
    expect(result.confidence).toBeGreaterThanOrEqual(0.8)
    expect(result.evidence.some(evidence => evidence.kind === 'extension')).toBe(false)
  })

  it('accepts a canonical empty Desc document only with its layout extension', async () => {
    const bytes = new TextEncoder().encode('<?xml version="1.0"?><Desc/>')
    await expect(codec.detect(fixtureSource(bytes, 'Empty.SC2Layout'), {})).resolves.toMatchObject({
      confidence: 0.68,
    })
    await expect(codec.detect(fixtureSource(bytes, 'Empty.xml'), {})).resolves.toMatchObject({
      confidence: 0,
    })
  })
})

describe('sc2-layout descriptor and session', () => {
  it('describes the single-source surface honestly and serializably', async () => {
    const document = await codec.open(fixtureSource(), {})
    const descriptor = await codec.describe(document, {})
    expect(isSerializableDescriptor(descriptor)).toBe(true)
    expect(descriptor.identity).toMatchObject({
      pluginId: SC2_LAYOUT_CODEC_ID,
      formatId: SC2_LAYOUT_CODEC_ID,
    })
    expect(
      findDanglingDiagnosticIds(descriptor.diagnostics, [...referencedDiagnosticIds(descriptor)]),
    ).toEqual([])

    const states = new Map(descriptor.operations.map(operation => [operation.id, operation.state]))
    expect(states.get(LAYOUT_OPERATION_IDS.parse)).toBe('available')
    expect(states.get(LAYOUT_OPERATION_IDS.inspect)).toBe('available')
    expect(states.get(LAYOUT_OPERATION_IDS.exportHtml)).toBe('available')
    expect(states.get(LAYOUT_OPERATION_IDS.raw)).toBe('available')
    expect(states.get(LAYOUT_OPERATION_IDS.resolve)).toBe('dependency-required')
    expect(states.get(LAYOUT_OPERATION_IDS.validate)).toBe('dependency-required')
    expect(states.get(LAYOUT_OPERATION_IDS.languageFeatures)).toBe('dependency-required')
    expect(states.get(LAYOUT_OPERATION_IDS.render)).toBe('available')
    expect(states.get(LAYOUT_OPERATION_IDS.renderVisual)).toBe('dependency-required')
    expect(states.get(LAYOUT_OPERATION_IDS.edit)).toBe('dependency-required')
    expect(states.get(LAYOUT_OPERATION_IDS.save)).toBe('disabled')
    expect(descriptor.constraints.unsupportedFeatures).toContain('visual-layout-rendering')
    expect(descriptor.constraints.unsupportedFeatures).toContain('source-save')

    const gameLayout = descriptor.traits.find(trait => trait.id === 'game.layout')
    expect(gameLayout).toMatchObject({
      state: 'partial',
      parameters: { parsed: true, resolved: false, visuallyRendered: false },
      diagnosticIds: [SC2_LAYOUT_WORKSPACE_DIAGNOSTIC_ID],
    })
    const dependencies = descriptor.traits.find(trait => trait.id === 'source.dependencies')
    expect(dependencies).toMatchObject({
      state: 'dependency-required',
      parameters: { count: 1, resolved: false },
    })
  })

  it('describes an already-parsed document identically to the byte-source path', async () => {
    const source = fixtureSource()
    const context = { gameId: 'starcraft-2' }
    const detection = await codec.detect(source, context)
    const opened = await codec.open(source, context)
    const adapted = createSc2LayoutDocumentFromParsed({
      source: source.descriptor,
      detection,
      context,
      bytes: LAYOUT_BYTES,
      data: opened.data,
    })

    expect(adapted.data).toBe(opened.data)
    await expect(codec.describe(adapted, context)).resolves.toEqual(
      await codec.describe(opened, context),
    )
  })

  it('dispatches exactly the available parse, inspect, HTML, and raw handlers', async () => {
    const document = await codec.open(fixtureSource(), {})
    const descriptor = await codec.describe(document, {})
    const session = codec.createSession(document, {}, descriptor, {
      grantedPermissions: ['read-source'],
    })
    const operation = (id: string) => descriptor.operations.find(candidate => candidate.id === id)

    const parse = operation(LAYOUT_OPERATION_IDS.parse)
    const inspect = operation(LAYOUT_OPERATION_IDS.inspect)
    const html = operation(LAYOUT_OPERATION_IDS.exportHtml)
    const raw = operation(LAYOUT_OPERATION_IDS.raw)
    const render = operation(LAYOUT_OPERATION_IDS.render)
    const renderVisual = operation(LAYOUT_OPERATION_IDS.renderVisual)
    const save = operation(LAYOUT_OPERATION_IDS.save)
    expect(parse && inspect && html && raw && render && renderVisual && save).toBeTruthy()
    if (
      parse === undefined ||
      inspect === undefined ||
      html === undefined ||
      raw === undefined ||
      render === undefined ||
      renderVisual === undefined ||
      save === undefined
    )
      return

    await expect(session.invoke(operationHandlerId(parse))).resolves.toMatchObject({
      frames: [expect.objectContaining({ name: 'Root' })],
      includes: ['UI/Layout/Shared.SC2Layout'],
    })
    await expect(session.invoke(operationHandlerId(inspect))).resolves.toMatchObject({
      format: SC2_LAYOUT_CODEC_ID,
      stats: { frameCount: 3, anchorCount: 1 },
    })
    await expect(session.invoke(operationHandlerId(html))).resolves.toMatchObject({
      mediaType: 'text/html',
      role: 'sc2-layout-diagnostic-html',
    })
    await expect(session.invoke(operationHandlerId(raw))).resolves.toMatchObject({
      data: LAYOUT_BYTES,
      role: 'sc2-layout-source',
    })
    await expect(session.invoke(operationHandlerId(render))).resolves.toMatchObject({
      mediaType: 'text/html',
      role: 'sc2-layout-diagnostic-html',
    })
    await expect(session.invoke(operationHandlerId(renderVisual))).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      context: { state: 'dependency-required' },
    })
    await expect(session.invoke(operationHandlerId(save))).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      context: { state: 'disabled' },
    })
  })

  it('selects the structural views but not unavailable diagnostics/visual rendering', async () => {
    const document = await codec.open(fixtureSource(), {})
    const descriptor = await codec.describe(document, {})
    const resolution = resolveContributions({
      traits: descriptor.traits,
      operations: descriptor.operations,
      contributions: descriptor.contributions,
      hostId: 'vscode',
    })
    expect(resolution.selected.map(contribution => contribution.id)).toEqual([
      'sc2-layout.structure',
      'sc2-layout.structural-preview',
      'sc2-layout.metadata',
    ])
    expect(resolution.rejected.map(item => item.id)).toContain('sc2-layout.visual')
    expect(resolution.rejected.map(item => item.id)).toContain('sc2-layout.diagnostics')
  })
})

describe('sc2-layout errors', () => {
  it('reports unsupported XML as PARSE_FAILED', () => {
    const source = fixtureSource(new TextEncoder().encode('<NotLayout/>'), 'Bad.SC2Layout')
    expect(() =>
      parseSc2Layout(
        source.descriptor,
        new TextEncoder().encode('<NotLayout/>'),
        {
          pluginId: SC2_LAYOUT_CODEC_ID,
          confidence: 0,
          evidence: [],
          requiredRanges: [],
        },
        {},
      ),
    ).toThrowError(expect.objectContaining({ code: 'PARSE_FAILED' }))
  })

  it('wraps source read failures as VFS_SOURCE_UNAVAILABLE with the cause', async () => {
    const base = fixtureSource()
    const cause = new Error('fixture read failed')
    const source: AssetSource = {
      ...base,
      read: async () => {
        throw cause
      },
    }
    const failure = await readSc2Layout(
      source,
      {
        pluginId: SC2_LAYOUT_CODEC_ID,
        confidence: 1,
        evidence: [],
        requiredRanges: [],
      },
      {},
    ).catch((error: unknown) => error)
    expect(failure).toMatchObject({
      code: 'VFS_SOURCE_UNAVAILABLE',
    })
    expect((failure as Error).cause).toBe(cause)
  })

  it('wraps bounded detection read failures with the cause', async () => {
    const base = fixtureSource()
    const cause = new Error('fixture range read failed')
    const source: AssetSource = {
      ...base,
      readRange: async () => {
        throw cause
      },
    }
    const failure = await codec.detect(source, {}).catch((error: unknown) => error)
    expect(failure).toMatchObject({
      code: 'VFS_SOURCE_UNAVAILABLE',
      context: { operation: 'detect' },
    })
    expect((failure as Error).cause).toBe(cause)
  })
})
