import { describe, expect, it } from 'vitest'
import { parseLayout } from '../../shared/layout-engine/sc2-layout-core/simple-parse/index.js'
import { layoutToHtml } from '../../shared/layout-engine/sc2-layout-core/html.js'
import { createSc2LayoutCodec } from '../../shared/format/codec.js'
import {
  createSc2LayoutDocumentFromParsed,
  rawSc2LayoutOutput,
  renderSc2LayoutDiagnosticHtml,
} from '../../shared/format/document.js'
import { LAYOUT_BYTES, LAYOUT_XML, fixtureSource } from './fixtures.js'

const codec = createSc2LayoutCodec()

describe('sc2-layout parity with @modkitx/layout-lang', () => {
  it('matches direct single-file parsing', async () => {
    const direct = parseLayout(LAYOUT_XML)
    const document = await codec.open(fixtureSource(), {})
    expect(document.data).toEqual(direct)
    expect(document.stats).toMatchObject({
      frameCount: 3,
      propertyCount: 3,
      anchorCount: 1,
      constantCount: 1,
      includeCount: 1,
      templateCount: 1,
      referenceCount: 2,
    })
  })

  it('adapts an already-parsed file without reparsing and preserves document parity', async () => {
    const source = fixtureSource()
    const context = { gameId: 'starcraft-2' }
    const detection = await codec.detect(source, context)
    const direct = parseLayout(LAYOUT_XML)
    const adapted = createSc2LayoutDocumentFromParsed({
      source: source.descriptor,
      detection,
      context,
      bytes: LAYOUT_BYTES,
      data: direct,
    })
    const opened = await codec.open(source, context)

    expect(adapted.data).toBe(direct)
    expect(adapted.stats).toEqual(opened.stats)
    expect(adapted.text).toBe(opened.text)
    expect(adapted.bytes).toBe(LAYOUT_BYTES)
    expect(rawSc2LayoutOutput(adapted).data).toEqual(LAYOUT_BYTES)
  })

  it('matches direct structural diagnostic HTML rendering', async () => {
    const document = await codec.open(fixtureSource(), {})
    const direct = layoutToHtml(parseLayout(LAYOUT_XML), {
      title: 'Test.SC2Layout',
      fileName: 'Test.SC2Layout',
    })
    expect(renderSc2LayoutDiagnosticHtml(document)).toBe(direct)
    expect(direct).toContain('<!DOCTYPE html>')
    expect(direct).toContain('Root')
    expect(direct).not.toContain('<script')
  })

  it('retains the original XML bytes exactly', async () => {
    const document = await codec.open(fixtureSource(), {})
    expect(document.bytes).toEqual(LAYOUT_BYTES)
    expect(rawSc2LayoutOutput(document).data).toEqual(LAYOUT_BYTES)
  })
})
