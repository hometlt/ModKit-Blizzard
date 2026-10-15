import { describe, expect, it } from 'vitest'
import { readAIData, writeEditorLayout } from '../../shared/format/formats/ai-data.js'

// As the editor writes an empty sequence (coop maps' CustomAI): the Wave stays open, Link and
// Comment close inline.
const document = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<AIData>',
  '    <Definition Id="0A1B2C3D">',
  '        <Step Type="Wave" Id="1">',
  '        </Step>',
  '        <Step Type="Link" Id="1"/>',
  '        <Step Type="Comment" Text="loop"/>',
  '    </Definition>',
  '</AIData>',
].join('\r\n')

// A hand-written document with what the model does not name, each in its own place: attributes on the root, a
// definition, a step, a unit, a count and a time; a child the model does not know inside a unit, a time and a point;
// a step id that is not a number; `TriggerRunAtEnd="0"`; and a value written with a leading zero.
const unusual = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<AIData Version="2">',
  '    <RepeatShow Value="01"/>',
  '    <Definition Id="0A1B2C3D" Color="255,0,0" Note="x">',
  '        <SourcePlayer Value="2"/>',
  '    </Definition>',
  '    <Definition Id="1A1B2C3D">',
  '        <SourcePlayer Value="2"/>',
  '        <Future Value="1"/>',
  '        <TargetPlayer Value="1"/>',
  '        <Step Type="Wave" Id="1">',
  '            <Unit Type="Marine">',
  '                <Count DiffLevel="1" Value="2"/>',
  '                <Extra/>',
  '            </Unit>',
  '            <Unit Type="Marauder" Role="tank">',
  '                <Count DiffLevel="1" Value="1"/>',
  '            </Unit>',
  '            <Unit Type="Medic">',
  '                <Count DiffLevel="1" Value="1" Scale="2"/>',
  '            </Unit>',
  '            <Unit Type="Ghost">',
  '                <Count DiffLevel="1" Value="3"/>',
  '            </Unit>',
  '            <Time Type="Arrival" TriggerRunAtEnd="0">',
  '                <Duration DiffLevel="1" Value="30"/>',
  '            </Time>',
  '            <Time Type="GatherTime">',
  '                <Duration DiffLevel="1" Value="10"/>',
  '                <Note/>',
  '            </Time>',
  '            <Point Type="Gather" Id="7">',
  '                <Active DiffLevel="1"/>',
  '                <Note/>',
  '            </Point>',
  '        </Step>',
  '        <Step Type="Link" Id="A1"/>',
  '        <Step Type="Wave" Id="2" Speed="fast"/>',
  '    </Definition>',
  '</AIData>',
].join('\r\n')

describe('CustomAI document', () => {
  it('writes empty steps in the editor layout', () => {
    const model = readAIData(document)
    expect(model.definitions[0]!.steps.map(step => step.type)).toEqual(['Wave', 'Link', 'Comment'])
    expect(writeEditorLayout(model)).toBe(document)
  })

  it('keeps what it cannot name whole and in place through a typed edit', () => {
    const model = readAIData(unusual)
    expect(model.root?.attributes).toEqual({ Version: '2' })
    expect(model.repeatShow).toBeUndefined()
    expect(model.definitions.map(definition => definition.id)).toEqual(['1A1B2C3D'])
    const [definition] = model.definitions
    expect(definition!.steps).toHaveLength(1)
    expect(definition!.steps[0]!.units.map(unit => unit.type)).toEqual(['Ghost'])
    expect(definition!.steps[0]!.unknown?.map(element => element.name)).toEqual(['Unit', 'Unit', 'Unit', 'Time', 'Time', 'Point'])
    // The typed edit writes the editor layout, not the text read: everything unnamed must come back unchanged.
    definition!.steps[0]!.units[0]!.counts[0]!.value = 4
    expect(writeEditorLayout(model)).toBe(unusual.replace('<Count DiffLevel="1" Value="3"/>', '<Count DiffLevel="1" Value="4"/>'))
  })

  it('carries kept elements through the document JSON', () => {
    const model = JSON.parse(JSON.stringify(readAIData(unusual))) as ReturnType<typeof readAIData>
    expect(writeEditorLayout(model)).toBe(unusual)
  })
})
