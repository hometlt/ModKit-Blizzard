import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseTriggerXmlSync } from '@modkit/blizzard-starcraft2/triggers/document/sax-reader.js'
import {
  scanTriggerSource,
  type TriggerSourcePosition,
  type TriggerSourceRange,
} from '@modkit/blizzard-starcraft2/triggers/document/source-index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

function positionAtOriginalText(text: string, offset: number): TriggerSourcePosition {
  let line = 0
  let lineStart = 0
  for (let index = 0; index < offset; index++) {
    if (text[index] === '\r') {
      if (text[index + 1] === '\n' && index + 1 < offset) index++
      line++
      lineStart = index + 1
    } else if (text[index] === '\n') {
      line++
      lineStart = index + 1
    }
  }
  return { line, character: offset - lineStart }
}

function expectRange(
  text: string,
  range: TriggerSourceRange,
  token: string,
  offsets?: readonly [number, number],
): void {
  expect(text.slice(range.startOffset, range.endOffset)).toBe(token)
  if (offsets !== undefined) {
    expect([range.startOffset, range.endOffset]).toEqual(offsets)
  }
  expect(range.start).toEqual(positionAtOriginalText(text, range.startOffset))
  expect(range.end).toEqual(positionAtOriginalText(text, range.endOffset))
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Expected ${label}`)
  return value
}

describe('scanTriggerSource', () => {
  it('keeps UTF-16 positions stable across LF, CRLF, and lone-CR input', () => {
    const lines = [
      '<TriggerData>',
      '  <Library Id="Lib">',
      '    <Element Id="DECL" Type="FunctionDef">',
      '      <Identifier>DoThing</Identifier>',
      '      <FunctionDef Library="Ntve" Id="REF" Type="FunctionDef"/>',
      '    </Element>',
      '  </Library>',
      '</TriggerData>',
    ]
    const lf = lines.join('\n')
    const crlf = lines.join('\r\n')
    const cr = lines.join('\r')
    const lfIndex = scanTriggerSource(lf)
    const crlfIndex = scanTriggerSource(crlf)
    const crIndex = scanTriggerSource(cr)

    const lfLibrary = required(lfIndex.libraries[0], 'LF library')
    const lfDeclaration = required(lfIndex.elements[0], 'LF declaration')
    const lfIdentifier = required(lfDeclaration.identifier, 'LF identifier')
    const lfReference = required(lfIndex.references[0], 'LF reference')
    const lfReferenceLibrary = required(lfReference.libraryRange, 'LF reference library')
    expectRange(lf, lfLibrary.idRange, 'Lib', [29, 32])
    expectRange(lf, lfDeclaration.idRange, 'DECL', [52, 56])
    expectRange(lf, lfIdentifier.range, 'DoThing', [96, 103])
    expectRange(lf, lfReferenceLibrary, 'Ntve', [145, 149])
    expectRange(lf, lfReference.range, 'REF', [155, 158])

    const crlfLibrary = required(crlfIndex.libraries[0], 'CRLF library')
    const crlfDeclaration = required(crlfIndex.elements[0], 'CRLF declaration')
    const crlfIdentifier = required(crlfDeclaration.identifier, 'CRLF identifier')
    const crlfReference = required(crlfIndex.references[0], 'CRLF reference')
    const crlfReferenceLibrary = required(
      crlfReference.libraryRange,
      'CRLF reference library',
    )
    expectRange(crlf, crlfLibrary.idRange, 'Lib', [30, 33])
    expectRange(crlf, crlfDeclaration.idRange, 'DECL', [54, 58])
    expectRange(crlf, crlfIdentifier.range, 'DoThing', [99, 106])
    expectRange(crlf, crlfReferenceLibrary, 'Ntve', [149, 153])
    expectRange(crlf, crlfReference.range, 'REF', [159, 162])

    expect([
      lfLibrary.idRange.start,
      lfDeclaration.idRange.start,
      lfIdentifier.range.start,
      lfReferenceLibrary.start,
      lfReference.range.start,
    ]).toEqual([
      { line: 1, character: 15 },
      { line: 2, character: 17 },
      { line: 3, character: 18 },
      { line: 4, character: 28 },
      { line: 4, character: 38 },
    ])
    expect([
      crlfLibrary.idRange.start,
      crlfDeclaration.idRange.start,
      crlfIdentifier.range.start,
      crlfReferenceLibrary.start,
      crlfReference.range.start,
    ]).toEqual([
      { line: 1, character: 15 },
      { line: 2, character: 17 },
      { line: 3, character: 18 },
      { line: 4, character: 28 },
      { line: 4, character: 38 },
    ])

    const crDeclaration = required(crIndex.elements[0], 'lone-CR declaration')
    const crIdentifier = required(crDeclaration.identifier, 'lone-CR identifier')
    expectRange(cr, crDeclaration.idRange, 'DECL', [52, 56])
    expectRange(cr, crIdentifier.range, 'DoThing', [96, 103])
    expect([crDeclaration.idRange.start, crIdentifier.range.start]).toEqual([
      { line: 2, character: 17 },
      { line: 3, character: 18 },
    ])
  })

  it('ignores comments, processing instructions, and CDATA without shortening Unicode input', () => {
    const text = [
      '<!-- Привет 🚀 <Library Id="Fake"><Element Type="FunctionDef" Id="NOPE"/></Library> -->',
      '<?editor value="<Element Type=\'FunctionDef\' Id=\'PI\'/>"?>',
      '<TriggerData>',
      '  <![CDATA[<Element Type="FunctionDef" Id="CDATA"/>]]>',
      '  <Library Id="Real">',
      '    <Element Type="FunctionDef" Id="LIVE"><Identifier>Run</Identifier></Element>',
      '  </Library>',
      '</TriggerData>',
    ].join('\r\n')
    const index = scanTriggerSource(text)

    expect(index.libraries.map(library => library.id)).toEqual(['Real'])
    expect(index.elements.map(element => element.id)).toEqual(['LIVE'])
    const library = required(index.libraries[0], 'Unicode fixture library')
    const declaration = required(index.elements[0], 'Unicode fixture declaration')
    const identifier = required(declaration.identifier, 'Unicode fixture identifier')
    expect(identifier.value).toBe('Run')
    expectRange(text, library.idRange, 'Real')
    expectRange(text, declaration.idRange, 'LIVE')
    expectRange(text, identifier.range, 'Run')
    expect(declaration.idRange.startOffset).toBe(text.indexOf('"LIVE"') + 1)
  })

  it('retains typed duplicates and only emits semantically safe links and localized keys', () => {
    const text = [
      '<TriggerData>',
      '  <Standard Id="Ntve"/>',
      '  <SharedLib Id="Camp"/>',
      '  <Element Type="FunctionCall" Id="DUP">',
      '    <FunctionDef Type="FunctionDef" Library="Ntve" Id="FUNC"/>',
      '    <Preset Type="PresetValue" Library="Ntve" Id="PRESET"/>',
      '    <ValueId Id="10"/>',
      '  </Element>',
      '  <Element Type="FunctionCall" Id="DUP"/>',
      '  <Element Type="ParamDef" Id="DUP"/>',
      '  <Element Type="Param" Id="LINK">',
      '    <Value>Marine</Value>',
      '    <ValueType Type="gamelink"/>',
      '    <ValueGameType Type="Unit"/>',
      '  </Element>',
      '  <Element Type="Param" Id="CMD">',
      '    <Value>move</Value>',
      '    <ValueType Type="abilcmd"/>',
      '    <ValueId Id="10"/>',
      '  </Element>',
      '  <Element Type="Param" Id="TEXT"><ValueType Type="text"/></Element>',
      '  <Element Type="CustomScript" Id="CODE">',
      '    <ScriptCode>UnitCreate(1, &quot;Marine&quot;);</ScriptCode>',
      '  </Element>',
      '</TriggerData>',
    ].join('\n')
    const index = scanTriggerSource(text, { sourcePath: 'TriggerLibs/Test.SC2Lib' })

    expect(index.sourcePath).toBe('TriggerLibs/Test.SC2Lib')
    expect(index.libraryReferences).toEqual([
      expect.objectContaining({
        kind: 'shared-library',
        sourceLibrary: 'Ntve',
        targetLibrary: 'Camp',
        complete: true,
      }),
    ])
    const sharedLibrary = required(index.libraryReferences[0], 'shared library reference')
    expectRange(text, sharedLibrary.range, 'Camp')

    expect(index.elements.map(({ library, type, id }) => [library, type, id])).toEqual([
      ['Ntve', 'FunctionCall', 'DUP'],
      ['Ntve', 'FunctionCall', 'DUP'],
      ['Ntve', 'ParamDef', 'DUP'],
      ['Ntve', 'Param', 'LINK'],
      ['Ntve', 'Param', 'CMD'],
      ['Ntve', 'Param', 'TEXT'],
      ['Ntve', 'CustomScript', 'CODE'],
    ])

    expect(index.references.map(reference => ({ role: reference.role, target: reference.target }))).toEqual([
      {
        role: 'FunctionDef',
        target: { library: 'Ntve', type: 'FunctionDef', id: 'FUNC' },
      },
      {
        role: 'Preset',
        target: { library: 'Ntve', type: 'PresetValue', id: 'PRESET' },
      },
    ])
    for (const reference of index.references) {
      expectRange(text, reference.range, reference.target.id)
      expect(reference.source).toEqual({ library: 'Ntve', type: 'FunctionCall', id: 'DUP' })
    }

    expect(index.gameLinks).toHaveLength(1)
    const gameLink = required(index.gameLinks[0], 'GameData link')
    expect(gameLink).toEqual(
      expect.objectContaining({
        source: { library: 'Ntve', type: 'Param', id: 'LINK' },
        catalog: 'Unit',
        entry: 'Marine',
      }),
    )
    expectRange(text, gameLink.range, 'Marine')

    const command = required(
      index.paramValues.find(value => value.source.id === 'CMD'),
      'abilcmd Param value',
    )
    const commandValue = required(command.value, 'abilcmd value')
    const commandType = required(command.valueType, 'abilcmd value type')
    expect(commandValue.value).toBe('move')
    expect(commandType.value).toBe('abilcmd')
    expectRange(text, commandValue.range, 'move')
    expectRange(text, commandType.range, 'abilcmd')

    expect(index.stringKeys).toContainEqual(
      expect.objectContaining({
        kind: 'param-value',
        table: 'GameStrings',
        key: 'Param/Value/lib_Ntve_TEXT',
        library: 'Ntve',
        elementType: 'Param',
        elementId: 'TEXT',
      }),
    )
    expect(index.stringKeys).toContainEqual(
      expect.objectContaining({
        kind: 'element-name',
        table: 'TriggerStrings',
        key: 'ParamDef/Name/lib_Ntve_DUP',
        elementType: 'ParamDef',
      }),
    )

    expect(index.scripts).toHaveLength(1)
    const script = required(index.scripts[0], 'ScriptCode block')
    expect(script).toEqual(
      expect.objectContaining({
        source: { library: 'Ntve', type: 'CustomScript', id: 'CODE' },
        code: 'UnitCreate(1, "Marine");',
        complete: true,
      }),
    )
    expectRange(text, script.range, 'UnitCreate(1, &quot;Marine&quot;);')
    expect(index.gameLinks.some(link => link.entry === 'move')).toBe(false)
    expect(index.gameLinks.filter(link => link.entry === 'Marine')).toHaveLength(1)
    expect(JSON.parse(JSON.stringify(index))).toEqual(index)
  })

  it('retains useful declarations and references during malformed trailing edits', () => {
    const trailing = [
      '<TriggerData>',
      '  <Standard Id="Ntve"/>',
      '  <Element Type="FunctionDef" Id="GOOD"><Identifier>Keep</Identifier></Element>',
      '  <Element Type="FunctionDef" Id="TAIL"',
    ].join('\n')
    const trailingIndex = scanTriggerSource(trailing)
    const good = required(
      trailingIndex.elements.find(element => element.id === 'GOOD'),
      'complete declaration',
    )
    const tail = required(
      trailingIndex.elements.find(element => element.id === 'TAIL'),
      'incomplete declaration',
    )

    expect(good.complete).toBe(true)
    expect(tail.complete).toBe(false)
    expectRange(trailing, good.idRange, 'GOOD')
    expectRange(trailing, tail.idRange, 'TAIL')
    expect(tail.range.startOffset).toBe(trailing.lastIndexOf('<Element'))
    expect(tail.range.endOffset).toBe(trailing.length)

    const brokenQuote = [
      '<TriggerData><Standard Id="Ntve"/>',
      '<Element Type="FunctionDef" Id="BROKEN',
      '<Element Type="FunctionDef" Id="RECOVER"/>',
      '</TriggerData>',
    ].join('\n')
    const recovered = scanTriggerSource(brokenQuote).elements.find(
      element => element.id === 'RECOVER',
    )
    expect(recovered?.complete).toBe(true)
    expectRange(brokenQuote, required(recovered, 'recovered declaration').idRange, 'RECOVER')

    const incompleteReference =
      '<TriggerData><Standard Id="Ntve"/><Element Type="FunctionCall" Id="CALL"><FunctionDef Type="FunctionDef" Id="TAIL"'
    const referenceIndex = scanTriggerSource(incompleteReference)
    expect(referenceIndex.elements[0]?.complete).toBe(false)
    const reference = required(referenceIndex.references[0], 'incomplete reference')
    expect(reference).toEqual(
      expect.objectContaining({
        role: 'FunctionDef',
        target: { library: 'Ntve', type: 'FunctionDef', id: 'TAIL' },
        complete: false,
      }),
    )
    expectRange(incompleteReference, reference.range, 'TAIL')
  })

  it('anchors NativeLib Standard offsets in original text before SAX normalization', () => {
    const text =
      '<TriggerData><Standard Id="Ntve"/><Element Type="FunctionDef" Id="00000001"><Identifier>NativeFoo</Identifier></Element></TriggerData>'
    const index = scanTriggerSource(text, { sourcePath: 'TriggerLibs/NativeLib.SC2Lib' })
    const library = required(index.libraries[0], 'NativeLib Standard declaration')
    const declaration = required(index.elements[0], 'NativeLib FunctionDef declaration')
    const identifier = required(declaration.identifier, 'NativeLib Identifier')

    expect(index.sourcePath).toBe('TriggerLibs/NativeLib.SC2Lib')
    expect(library).toEqual(expect.objectContaining({ syntax: 'Standard', id: 'Ntve' }))
    expect(declaration.library).toBe('Ntve')
    expect(identifier.value).toBe('NativeFoo')
    expectRange(text, library.idRange, 'Ntve', [27, 31])
    expectRange(text, declaration.idRange, '00000001', [66, 74])
    expectRange(text, identifier.range, 'NativeFoo', [88, 97])

    const semanticBefore = parseTriggerXmlSync(text)
    const semanticAfter = parseTriggerXmlSync(text)
    expect(semanticAfter).toEqual(semanticBefore)
    expect(semanticAfter.get('Ntve')?.elementsByType.FunctionDef['00000001']).toEqual(
      expect.objectContaining({ id: '00000001', library: 'Ntve', name: 'NativeFoo' }),
    )
  })

  it('matches semantic declarations and known offsets in the checked-in CRLF map fixture', () => {
    // This package owns the fixture it asserts byte counts against. It used to read one from
    // `packages/lsp/tests/`, which broke the moment those fixtures moved with the language
    // services — a cross-package fixture path is a dependency without a declaration.
    const fixturePath = resolve(__dirname, './fixtures/crlf-map.Triggers')
    // Keep the repository fixture normalized to LF and construct the CRLF
    // transport bytes in memory. A test must never rewrite its checked-in
    // fixture during global setup: interrupted runs otherwise leave the
    // worktree dirty and the next run fails provenance before tests start.
    const text = readFileSync(fixturePath, 'utf8').replaceAll('\n', '\r\n')
    const index = scanTriggerSource(text, { sourcePath: 'Triggers' })
    const semanticLibraries = parseTriggerXmlSync(text)

    expect(text.length).toBe(21_025)
    expect(text.match(/\r\n/g)).toHaveLength(493)
    expect(index.elements).toHaveLength(79)
    expect(index.references).toHaveLength(112)
    const library = required(index.libraries[0], 'fixture library')
    const firstDeclaration = required(index.elements[0], 'fixture first declaration')
    const functionDeclaration = required(index.elements[1], 'fixture FunctionDef declaration')
    const functionIdentifier = required(
      functionDeclaration.identifier,
      'fixture FunctionDef Identifier',
    )
    expectRange(text, library.idRange, 'loop', [72, 76])
    expectRange(text, firstDeclaration.idRange, 'C7DA882A', [348, 356])
    expectRange(text, functionIdentifier.range, 'PickEachInteger', [732, 747])

    for (const declaration of index.elements) {
      expectRange(text, declaration.idRange, declaration.id)
    }
    for (const reference of index.references) {
      expectRange(text, reference.range, reference.target.id)
    }
    for (const [libraryId, library] of semanticLibraries) {
      for (const semantic of Object.values(library.elements)) {
        expect(
          index.elements.some(
            declaration =>
              declaration.library === libraryId &&
              declaration.type === semantic.type &&
              declaration.id === semantic.id,
          ),
        ).toBe(true)
      }
    }
  })
})
