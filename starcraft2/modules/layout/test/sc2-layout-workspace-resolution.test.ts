/**
 * How a layout workspace resolves frame and constant names: through the including file's closure
 * first, by file name across the workspace for a file-qualified target, and to nothing when a name
 * is ambiguous. The workspace answers each layout's closure once; repeated questions must give the
 * same answer and never let one layout's closure leak into another's.
 */
import { describe, expect, it } from 'vitest'
import { createLayoutWorkspace, defaultLayoutBounds } from '../shared/semantic.js'

const layout = (name: string, text: string) => ({
  uri: `file:///Probe.SC2Mod/Base.SC2Data/UI/Layout/${name}.SC2Layout`,
  languageId: 'sc2-layout',
  version: 1,
  text,
})

const documents = [
  layout('Main', `<Desc>
  <Include path="UI/Layout/Parts.SC2Layout"/>
  <Include path="UI/Layout/Extra.SC2Layout"/>
  <Constant name="Own" val="1"/>
  <Frame type="Frame" name="Root"><Frame type="Button" name="Go"/></Frame>
</Desc>`),
  layout('Parts', `<Desc>
  <Include path="UI/Layout/Main.SC2Layout"/>
  <Constant name="Color" val="ff0000"/>
  <Frame type="Frame" name="Panel">
    <Frame type="Button" name="Button"/>
    <Frame type="Frame" name="Left"><Frame type="Label" name="Dup"/></Frame>
    <Frame type="Frame" name="Right"><Frame type="Label" name="Dup"/></Frame>
  </Frame>
  <Frame type="Frame" name="Shared"/>
</Desc>`),
  layout('Extra', `<Desc>
  <Frame type="Frame" name="Shared"/>
</Desc>`),
  layout('Templates', `<Desc>
  <Constant name="Color" val="00ff00"/>
  <Constant name="Elsewhere" val="2"/>
  <Constant name="Twice" val="3"/>
  <Frame type="Frame" name="Group"><Frame type="Frame" name="Big"/></Frame>
</Desc>`),
  layout('Other', `<Desc>
  <Constant name="Twice" val="4"/>
</Desc>`),
]

async function workspace() {
  return createLayoutWorkspace(documents, { ...defaultLayoutBounds, maxDocuments: 64, maxDiagnostics: 64 })
}

const fileOf = (built: Awaited<ReturnType<typeof workspace>>, frame: { node: unknown } | undefined) =>
  frame === undefined ? undefined : built.layoutForFrame(frame)?.fileName

describe('SC2Layout workspace resolution', () => {
  it('follows includes breadth-first and stops at a cycle', async () => {
    const built = await workspace()
    const main = built.byUri.get(documents[0]!.uri)!
    expect(built.importedLayouts(main).map(item => item.fileName)).toEqual(['Main', 'Parts', 'Extra'])
    const parts = built.byUri.get(documents[1]!.uri)!
    expect(built.importedLayouts(parts).map(item => item.fileName)).toEqual(['Parts', 'Main', 'Extra'])
    expect(built.framesFor(main).map(frame => frame.path)).toEqual([
      'Root', 'Root/Go', 'Panel', 'Panel/Button', 'Panel/Left', 'Panel/Left/Dup', 'Panel/Right', 'Panel/Right/Dup', 'Shared', 'Shared',
    ])
  })

  it('resolves a path in the closure without regard to case, and refuses an ambiguous name', async () => {
    const built = await workspace()
    const main = built.byUri.get(documents[0]!.uri)!
    expect(built.resolveFrame(main, 'Panel/Button')?.path).toBe('Panel/Button')
    expect(built.resolveFrame(main, '@@panel/BUTTON')?.path).toBe('Panel/Button')
    expect(built.resolveFrame(main, 'Button')?.path).toBe('Panel/Button')
    // Two files of the closure declare `Shared`, and one file declares `Dup` twice.
    expect(built.resolveFrame(main, 'Shared')).toBeUndefined()
    expect(built.resolveFrame(main, 'Dup')).toBeUndefined()
    expect(built.resolveFrame(main, 'Panel/Right/Dup')?.path).toBe('Panel/Right/Dup')
    // A frame outside the closure is not found by its bare name.
    expect(built.resolveFrame(main, 'Big')).toBeUndefined()
    expect(built.resolveFrame(main, '')).toBeUndefined()
  })

  it('resolves a file-qualified target across the whole workspace', async () => {
    const built = await workspace()
    const main = built.byUri.get(documents[0]!.uri)!
    const big = built.resolveFrame(main, 'Templates/Group/Big')
    expect(big?.path).toBe('Group/Big')
    expect(fileOf(built, big)).toBe('Templates')
    expect(built.resolveFrame(main, 'templates/big')?.path).toBe('Group/Big')
    expect(built.resolveFrame(main, 'Parts/Panel/Left/Dup')?.path).toBe('Panel/Left/Dup')
    expect(built.resolveFrame(main, 'Parts/Dup')).toBeUndefined()
    expect(built.resolveFrame(main, 'Missing/Big')).toBeUndefined()
  })

  it('resolves constants in the closure first, then across the workspace when unambiguous', async () => {
    const built = await workspace()
    const main = built.byUri.get(documents[0]!.uri)!
    const extra = built.byUri.get(documents[2]!.uri)!
    // Main's closure holds Parts' Color; the workspace as a whole holds two.
    expect(built.resolveConstant(main, '#Color')?.val).toBe('ff0000')
    expect(built.resolveConstant(extra, '#Color')).toBeUndefined()
    expect(built.resolveConstant(main, '##elsewhere')?.val).toBe('2')
    expect(built.resolveConstant(main, '#Own')?.val).toBe('1')
    expect(built.resolveConstant(main, '#Twice')).toBeUndefined()
    expect(built.resolveConstant(main, '#Missing')).toBeUndefined()
  })

  it('gives the same answers on repeated questions', async () => {
    const built = await workspace()
    const main = built.byUri.get(documents[0]!.uri)!
    expect(built.framesFor(main)).toBe(built.framesFor(main))
    expect(built.importedLayouts(main)).toBe(built.importedLayouts(main))
    expect(built.resolveFrame(main, 'Panel/Button')).toBe(built.resolveFrame(main, 'panel/button'))
    expect(Object.isFrozen(built.framesFor(main))).toBe(true)
  })
})
