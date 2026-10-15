import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  convertGalaxyToTriggers,
  convertTriggersToGalaxy,
  createTriggerGalaxyConversionService,
  triggerConversionBounds,
} from '../../../../dist/modules/triggers/services/galaxy-conversion/index.js'
import { parseTriggerXmlSync } from '../../../../dist/modules/triggers/shared/trigger-document/sax-reader.js'
import { convertGalaxyToTriggerLibrary, parseGalaxySource } from '../../../../dist/modules/triggers/services/galaxy-conversion/internal/galaxy-to-trigger.js'
import { convertTriggerLibraryToGalaxyFull } from '../../../../dist/modules/triggers/services/galaxy-conversion/internal/trigger-to-galaxy.js'
import { compareGalaxyPrograms } from '../../../../dist/modules/triggers/services/galaxy-conversion/index.js'
import { resolveGalaxyTypeAliases } from '../../../../dist/modules/triggers/services/galaxy-conversion/internal/galaxy-type-resolution.js'

const fixture = (name: string) =>
  readFileSync(resolve(import.meta.dirname, '../fixtures', name), 'utf8')

describe('SC2 TriggerData semantic conversion', () => {
  it('distinguishes integer and fixed numeric literal types in exact Galaxy comparisons', () => {
    const parse = (text: string) => parseGalaxySource(text, 'comparison.galaxy')
    expect(compareGalaxyPrograms(parse('fixed f(){return 1 / 2;}'), parse('fixed f(){return 1.0 / 2.0;}')).exact).toBe(false)
    expect(compareGalaxyPrograms(parse('fixed f(){return 1.0 / 2.0;}'), parse('fixed f(){return 1.00 / 2.00;}')).exact).toBe(true)
  })

  // Hand-written code compares with its GUI conversion: `if (x)` comes back as `if ((x == true))`, and
  // `int p = X;` as `int lv_p; lv_p = X;` (PartAndParcelOriginal, SkyFall). Such a function is equivalent —
  // a difference, not an error — and a changed meaning still differs.
  it('takes the forms the GUI writes for hand-written code as equivalent, not exact', () => {
    const parse = (text: string) => parseGalaxySource(text, 'comparison.galaxy')
    const original = parse([
      'native int Next();', 'native void Use(int v, bool b);',
      'void f(bool c) { int p = Next(); int q = Next(); if (c) { Use(p, c); } if (!c) { Use(q, false); } }',
    ].join('\n'))
    const gui = parse([
      'native int Next();', 'native void Use(int v, bool b);',
      'void f(bool lp_c) { int lv_p; int lv_q; lv_p = Next(); lv_q = Next(); if ((lp_c == true)) { Use(lv_p, (lp_c == true)); } if ((lp_c == false)) { Use(lv_q, false); } }',
    ].join('\n'))
    const result = compareGalaxyPrograms(original, gui)
    expect(result.functions.equivalent).toEqual(['f'])
    expect(result.functions.differing).toEqual([])
    expect(result.exact).toBe(true)
    expect(result.tolerated).toBe(true)
    expect(compareGalaxyPrograms(original, original).tolerated).toBe(false)

    const changed = (body: string) => compareGalaxyPrograms(original, parse([
      'native int Next();', 'native void Use(int v, bool b);', `void f(bool lp_c) { ${body} }`,
    ].join('\n'))).functions.differing
    // A negated condition, and initializers that run in the other order, are other programs.
    expect(changed('int lv_p; int lv_q; lv_p = Next(); lv_q = Next(); if ((lp_c == false)) { Use(lv_p, lp_c); } if (!lp_c) { Use(lv_q, false); }')).toEqual(['f'])
    expect(changed('int lv_p; int lv_q; lv_q = Next(); lv_p = Next(); if (lp_c) { Use(lv_p, lp_c); } if (!lp_c) { Use(lv_q, false); }')).toEqual(['f'])
  })

  it('does not prove semantic equality after meaningful include or global initializer changes', () => {
    const parse = (text: string) => parseGalaxySource(text, 'comparison.galaxy')
    const baseline = parse([
      'include "One"',
      'native int Next();',
      'int a = Next();',
      'int b = Next();',
    ].join('\n'))

    expect(compareGalaxyPrograms(baseline, parse([
      'include "One"',
      'native int Next();',
      'int a = Next();',
      'int b = Next();',
    ].join('\n'))).exact).toBe(true)
    expect(compareGalaxyPrograms(baseline, parse([
      'include "Two"',
      'native int Next();',
      'int a = Next();',
      'int b = Next();',
    ].join('\n'))).exact).toBe(false)
    expect(compareGalaxyPrograms(baseline, parse([
      'native int Next();',
      'int a = Next();',
      'int b = Next();',
    ].join('\n'))).exact).toBe(false)
    expect(compareGalaxyPrograms(baseline, parse([
      'include "One"',
      'include "Two"',
      'native int Next();',
      'int a = Next();',
      'int b = Next();',
    ].join('\n'))).exact).toBe(false)
    expect(compareGalaxyPrograms(parse('include "One"\ninclude "Two"'), parse('include "Two"\ninclude "One"')).exact).toBe(false)
    expect(compareGalaxyPrograms(baseline, parse([
      'include "One"',
      'native int Next();',
      'int b = Next();',
      'int a = Next();',
    ].join('\n'))).exact).toBe(false)
  })

  it('resolves long typedef chains with linear bounded lookup work', () => {
    for (const length of [100, 200, 400, 800, 1600]) {
      const aliases = Array.from({ length }, (_, index) =>
        index + 1 === length
          ? `typedef int A${index + 1};`
          : `typedef A${index + 2} A${index + 1};`,
      )
      const source = parseGalaxySource([...aliases, 'A1 value;'].join('\n'), `aliases-${length}.galaxy`)
      const stats = resolveGalaxyTypeAliases(source.statements as any[])
      expect(stats.aliasesResolved).toBe(length)
      // The first chain walk resolves every alias and all later references hit
      // the memo. A quadratic rewalk would exceed this linear bound sharply.
      expect(stats.aliasLookups).toBeLessThanOrEqual(length * 3 + 1)
      expect(stats.typeResolutions).toBeLessThanOrEqual(length * 4 + 1)
    }
  })

  it('rejects semantic verifier mutations instead of issuing a false exact result', () => {
    const parse = (text: string) => parseGalaxySource(text, 'mutations.galaxy')
    const baseline = [
      'include "One"',
      'const int Preset = 1;',
      'int seed = 0;',
      'native int First(int value);',
      'native int Second(int value);',
      'int f(int value) { First(value); Second(value); return value + 1; }',
      'bool shortCircuit(bool value) { return value && value; }',
    ].join('\n')
    for (const mutation of [
      baseline.replace('"One"', '"Two"'), // include identity
      baseline.replace('include "One"\n', ''), // removed include
      baseline.replace('Preset = 1', 'Preset = 2'), // referenced preset/literal
      baseline.replace('seed = 0', 'seed = 1'), // meaningful initializer
      baseline.replace('First(value)', 'First(0)'), // argument
      baseline.replace('First(value)', 'First()'), // removed argument
      baseline.replace('First(value); Second(value)', 'Second(value); First(value)'), // call order
      baseline.replace('return value + 1', 'return 0'), // return value
      baseline.replace('value + 1', 'value - 1'), // operator
      baseline.replace('value && value', 'value || value'), // short circuit
      baseline.replace('Second(value); ', ''), // statement removal
      baseline.replace('Second(value);', 'Second(value); Second(value);'), // duplicate statement
      `${baseline}\nint addedGlobal = 0;`, // variable scope/declaration surface
    ]) expect(compareGalaxyPrograms(parse(baseline), parse(mutation)).exact).toBe(false)
  })

  it('reuses parsed dependencies within one conversion service and invalidates changed content', async () => {
    const firstDependency = '<TriggerData><Library Id="Ntve"><Element Type="FunctionDef" Id="One"><Identifier>One</Identifier><FlagNative/></Element></Library></TriggerData>'
    const secondDependency = firstDependency.replaceAll('One', 'Two')
    const service = createTriggerGalaxyConversionService({ cache: { maxDependencyCacheEntries: 2 } })
    const input = { libraryId: 'TEST', script: 'void authored() {}', header: '', verification: 'semantic' as const }

    const first = await service.galaxyToTriggers({ ...input, dependencyLibraries: [{ triggerData: firstDependency }] })
    const second = await service.galaxyToTriggers({ ...input, dependencyLibraries: [{ triggerData: firstDependency }] })
    expect(second.output.triggerData).toBe(first.output.triggerData)
    expect(service.cacheStats()).toMatchObject({ entries: 1, hits: 1, misses: 1, stores: 1 })

    await service.galaxyToTriggers({ ...input, dependencyLibraries: [{ triggerData: secondDependency }] })
    expect(service.cacheStats()).toMatchObject({ entries: 2, hits: 1, misses: 2, stores: 2 })
    service.clearCache()
    expect(service.cacheStats()).toMatchObject({ entries: 0, sourceBytes: 0 })

    const forwardService = createTriggerGalaxyConversionService({ cache: { maxDependencyCacheEntries: 2 } })
    const triggerData = fixture('pinned-runtime-fixture.Triggers')
    const forwardInput = { dependencyLibraries: [{ triggerData: firstDependency }] }
    const firstForward = await forwardService.triggersToGalaxy(triggerData, forwardInput)
    const secondForward = await forwardService.triggersToGalaxy(triggerData, forwardInput)
    expect(secondForward.output).toEqual(firstForward.output)
    expect(forwardService.cacheStats()).toMatchObject({ entries: 1, hits: 1, misses: 1, stores: 1 })

    const bounded = createTriggerGalaxyConversionService({ cache: { maxDependencyCacheEntries: 1 } })
    await bounded.galaxyToTriggers({ ...input, dependencyLibraries: [{ triggerData: firstDependency }] })
    await bounded.galaxyToTriggers({ ...input, dependencyLibraries: [{ triggerData: secondDependency }] })
    expect(bounded.cacheStats()).toMatchObject({ entries: 1, misses: 2, stores: 2, evictions: 1 })

    const disabled = createTriggerGalaxyConversionService({ cache: { maxDependencyCacheEntries: 0 } })
    await disabled.galaxyToTriggers({ ...input, dependencyLibraries: [{ triggerData: firstDependency }] })
    await disabled.galaxyToTriggers({ ...input, dependencyLibraries: [{ triggerData: firstDependency }] })
    expect(disabled.cacheStats()).toMatchObject({ entries: 0, hits: 0, misses: 0, stores: 0 })
  })

  it('deduplicates identical shared libraries in both directions', async () => {
    const triggerData = fixture('pinned-runtime-fixture.Triggers');
    const forward = await convertTriggersToGalaxy(triggerData, { dependencyLibraries: [{ triggerData }] });
    const ordinary = await convertTriggersToGalaxy(triggerData, {});
    expect(forward.output.script).toBe(ordinary.output.script);
    const reverse = await convertGalaxyToTriggers({ libraryId: 'TEST', script: 'void authored() {}', header: '',
      dependencyLibraries: [{ triggerData }, { triggerData }] });
    expect(reverse.output.triggerData).toContain('TEST');
  });

  it('reports conflicting shared elements instead of choosing a layer silently', async () => {
    const triggerData = fixture('pinned-runtime-fixture.Triggers');
    await expect(convertTriggersToGalaxy(triggerData, { dependencyLibraries: [{
      triggerData: triggerData.replace('<Identifier>Run</Identifier>', '<Identifier>Changed</Identifier>'),
    }] })).rejects.toMatchObject({ context: { conversionCode: 'LIBRARY_LAYER_CONFLICT',
      libraryId: 'RuntimeFixture', changedElements: 1, changedSample: ['FunctionDef:Run'] } });
  });
  it('resolves a declared layer whole and reports which document lost', async () => {
    const triggerData = fixture('pinned-runtime-fixture.Triggers');
    const other = triggerData.replace('<Identifier>Run</Identifier>', '<Identifier>Changed</Identifier>');
    const result = await convertTriggersToGalaxy(triggerData, { libraryLayers: 'first-document-wins', dependencyLibraries: [{ triggerData: other }] });
    // The primary document is first, so its body survives untouched.
    expect(result.output.script.trimEnd()).toBe(fixture('pinned-runtime-fixture.expected.galaxy').trimEnd());
    const layer = result.fidelity.diagnostics.find(item => item.code === 'sc2-triggers/library-layer-superseded');
    expect(layer).toMatchObject({ severity: 'warning', details: { libraryId: 'RuntimeFixture', keptDocument: 0, supersededDocument: 1, changedElements: 1, changedSample: ['FunctionDef:Run'] } });
  });

  it('rejects an unknown library layer policy', async () => {
    await expect(convertTriggersToGalaxy(fixture('pinned-runtime-fixture.Triggers'), { libraryLayers: 'merge' }))
      .rejects.toThrow(/libraryLayers must be one of/);
  });

  it('keeps every authored root reference, including one this document cannot resolve', () => {
    const xml = '<?xml version="1.0" encoding="utf-8"?><TriggerData><Library Id="ONE"><Root><Item Type="Category" Library="ONE" Id="00000001"/><Item Type="Category" Library="TWO" Id="000000FF"/></Root><Element Type="Category" Id="00000001"/></Library><Library Id="TWO"><Root/></Library></TriggerData>';
    const parsed = parseTriggerXmlSync(xml);
    expect(parsed.get('ONE')!.items.map(item => item.id)).toEqual(['00000001']);
    expect(parsed.get('ONE')!.rootRefs).toEqual([
      { type: 'Category', library: 'ONE', id: '00000001' },
      { type: 'Category', library: 'TWO', id: '000000FF' },
    ]);
    expect(parsed.get('ONE')!.hasRoot).toBe(true);
    expect(parsed.get('TWO')!.hasRoot).toBe(true);
    expect(parsed.get('TWO')!.rootRefs).toEqual([]);
  });

  it('preserves baseline Galaxy output and identifies the revised converter in its digest', async () => {
    const result = await convertTriggersToGalaxy(
      fixture('pinned-runtime-fixture.Triggers'),
      {},
      undefined,
    )

    expect(result.output.script.trimEnd()).toBe(fixture('pinned-runtime-fixture.expected.galaxy').trimEnd())
    expect(result.output.header).toBe(fixture('pinned-runtime-fixture.expected_h.galaxy'))
    // A mod declares its library; the reported kind is what the reverse
    // direction is handed back so it reproduces the same document shape.
    expect(result.output.documentKind).toBe('library')
    expect(result.digest).toEqual({
      algorithm: 'sha-256',
      value: '4271905b0309ffd34153d737723aec1dc2cef753cb09ae333d9711d662e3ea84',
    })
    expect(result.fidelity).toMatchObject({
      direction: 'trigger-to-galaxy',
      sourceFormat: 'sc2-triggers',
      targetFormat: 'galaxy',
      preserved: { count: 0, items: [] },
      rewritten: { count: 1 },
      dropped: { count: 0, items: [] },
      unsupported: { count: 0, items: [] },
      completeness: 'complete',
      provenance: { sourceCommit: '1a14ba4eddd0ae88de273348ebd44cfb98a0581d' },
    })
  })

  it('rejects the larger fixture without its required native definitions', async () => {
    await expect(convertTriggersToGalaxy(fixture('pinned-crlf-map.Triggers'), {}, undefined)).rejects.toMatchObject({
      context: {
        conversionCode: 'UNRESOLVED_REFERENCE',
        reference: { type: 'FunctionDef', library: 'Ntve', id: '00000141' },
      },
    })
  })

  it('reconstructs the pinned output, reparses TriggerData, and has exact zero-loss assertions', async () => {
    const forward = await convertTriggersToGalaxy(
      fixture('pinned-runtime-fixture.Triggers'),
      {},
      undefined,
    )
    const reverse = await convertGalaxyToTriggers(
      {
        libraryId: forward.output.libraryId,
        script: forward.output.script,
        header: forward.output.header,
      },
      undefined,
    )

    expect(reverse.output).toMatchObject({
      libraryId: 'RuntimeFixture',
      elements: 2,
      typeCounts: { Category: 1, FunctionDef: 1 },
    })
    expect(reverse.fidelity).toMatchObject({
      direction: 'galaxy-to-triggers',
      dropped: { count: 0, items: [] },
      unsupported: { count: 0, items: [] },
      completeness: 'complete',
      verification: {
        generatedTriggerDataReparsed: true,
        elementCountExact: true,
        typeCountsExact: true,
        galaxyScriptCanonicalExact: true,
        galaxyHeaderCanonicalExact: true,
      },
    })
    const reparsed = parseTriggerXmlSync(reverse.output.triggerData).get('RuntimeFixture')
    expect(Object.keys(reparsed?.elements ?? {})).toHaveLength(2)

    const secondForward = await convertTriggersToGalaxy(reverse.output.triggerData, {}, undefined)
    expect(secondForward.output.script).toBe(forward.output.script)
    expect(secondForward.output.header).toBe(forward.output.header)
  })

  it('reports observable Galaxy-to-Trigger phase and function progress', async () => {
    const progress: any[] = []
    await convertGalaxyToTriggers({
      libraryId: 'TEST',
      script: 'void first() {} void second() {}',
      header: '',
      onProgress: (event: unknown) => progress.push(event),
    })
    expect(progress[0]).toMatchObject({ operation: 'galaxy-to-triggers', sequence: 0, phase: 'input' })
    expect(progress.at(-1)).toMatchObject({ phase: 'complete', completed: 1, total: 1, ratio: 1 })
    expect(progress.some(event => event.phase === 'reconstruct' && event.stage === 'bodies' && event.total === 2)).toBe(true)
    expect(progress.filter(event => event.phase === 'reconstruct' && event.stage === 'bodies')
      .every(event => event.completed >= 0 && event.completed <= event.total)).toBe(true)
    expect(progress.some(event => event.phase === 'galaxy-roundtrip' && event.stage === 'user-functions' &&
      event.completed === 1 && event.total === 2)).toBe(true)
    expect(progress.map(event => event.sequence)).toEqual(progress.map((_, index) => index))
  })

  it('can defer the memory-heavy Galaxy roundtrip after exact TriggerData reparse', async () => {
    const progress: any[] = []
    const result = await convertGalaxyToTriggers({
      libraryId: 'TEST',
      script: 'void first() {} void second() {}',
      header: '',
      verification: 'semantic',
      onProgress: (event: unknown) => progress.push(event),
    })
    expect(result.fidelity.verification).toMatchObject({
      generatedTriggerDataReparsed: true,
      elementCountExact: true,
      typeCountsExact: true,
      semanticModelExact: true,
      galaxyScriptCanonicalExact: null,
      galaxyHeaderCanonicalExact: null,
      galaxyValidation: { status: 'incomplete', errors: 0, deferred: true, validationCompleted: false },
    })
    expect(result.fidelity.unsupported.items).toContainEqual({
      kind: 'verification', count: 1, reason: 'galaxy-roundtrip-deferred',
    })
    expect(progress.some(event => event.phase === 'galaxy-roundtrip' && event.stage === 'deferred')).toBe(true)
    expect(progress.at(-1)).toMatchObject({ phase: 'complete', completed: 1, total: 1 })
  })

  it('rejects a non-callable progress sink', async () => {
    await expect(convertGalaxyToTriggers({ libraryId: 'TEST', script: 'void run() {}', header: '', onProgress: true } as any))
      .rejects.toThrow('onProgress must be a function')
  })

  it('rejects an unknown reverse verification mode', async () => {
    await expect(convertGalaxyToTriggers({ libraryId: 'TEST', script: 'void run() {}', header: '', verification: 'fast' } as any))
      .rejects.toThrow('verification must be full or semantic')
  })

  it('rejects missing libraries and reconstructs arbitrary Galaxy with an honest roundtrip report', async () => {
    const missingNative = `
      <TriggerData><Library Id="TEST">
        <Element Type="FunctionCall" Id="CALL">
          <FunctionDef Type="FunctionDef" Library="Ntve" Id="NativeCall"/>
        </Element>
        <Element Type="Trigger" Id="RUN"><Action Type="FunctionCall" Library="TEST" Id="CALL"/></Element>
      </Library></TriggerData>`
    await expect(convertTriggersToGalaxy(missingNative, {}, undefined)).rejects.toMatchObject({
      context: { conversionCode: 'UNRESOLVED_REFERENCE', reference: { library: 'Ntve', id: 'NativeCall' } },
    })

    const reverse = await convertGalaxyToTriggers(
      { libraryId: 'TEST', script: 'void custom() {\n}\n', header: '' },
      undefined,
    )
    expect(reverse.fidelity.completeness).toBe('partial')
    expect(reverse.output.triggerData).toContain("<Identifier>custom</Identifier>")
    expect(reverse.fidelity.unsupported.count).toBeGreaterThan(0)
    expect(reverse.fidelity.verification.generatedTriggerDataReparsed).toBe(true)
    expect(reverse.fidelity.dropped).toEqual({ count: 0, items: [] })
  })

  it('resolves an explicitly supplied external TriggerLib dependency', async () => {
    const primary = `
      <TriggerData><Library Id="TEST">
        <Element Type="FunctionCall" Id="CALL">
          <FunctionDef Type="FunctionDef" Library="Ntve" Id="NativeCall"/>
        </Element>
        <Element Type="Trigger" Id="RUN">
          <Action Type="FunctionCall" Library="TEST" Id="CALL"/>
        </Element>
      </Library></TriggerData>`
    const nativeDependency = `
      <TriggerData><Library Id="Ntve">
        <Element Type="FunctionDef" Id="NativeCall"><Identifier>NativeCall</Identifier></Element>
      </Library></TriggerData>`
    const result = await convertTriggersToGalaxy(
      primary,
      { dependencyLibraries: [{ triggerData: nativeDependency }] },
      undefined,
    )

    expect(result.output.script).toContain('NativeCall();')
    expect(result.fidelity).toMatchObject({
      completeness: 'complete',
      dropped: { count: 0 },
      unsupported: { count: 0 },
    })
    expect(result.fidelity.diagnostics.map(item => item.code)).not.toContain(
      'sc2-triggers/dependency-incomplete',
    )
  })

  it('honors cancellation and hard output bounds', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      convertTriggersToGalaxy(fixture('simple-trigger.Triggers'), {}, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    await expect(
      convertTriggersToGalaxy(
        fixture('simple-trigger.Triggers'),
        { maxOutputBytes: 16 },
        undefined,
      ),
    ).rejects.toThrow(/output exceeds/u)
    // Exercise the bound through an explicit limit: allocating a string past the
    // default would cost a quarter of a gigabyte to prove the same branch.
    await expect(
      convertTriggersToGalaxy('x'.repeat(4097), { limits: { maxInputBytes: 4096 } }, undefined),
    ).rejects.toThrow(/triggerData exceeds/u)
  })

  it('publishes the same input budget that the codec manifest declares', () => {
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../codecs/triggers/codec.json'), 'utf8'))
    expect(Number(manifest.spec.budgets.maxInputBytes)).toBe(triggerConversionBounds.maxPrimaryBytes)
    expect(triggerConversionBounds.maxPrimaryBytes).toBe(536870912)
    expect(triggerConversionBounds.maxDependencyBytes).toBe(536870912)
    expect(triggerConversionBounds.maxDependencyDocuments).toBe(512)
    expect(triggerConversionBounds.defaultMaxOutputBytes).toBe(536870912)
    expect(Number(manifest.spec.budgets.maxNodes)).toBe(triggerConversionBounds.defaults.maxLibraryElements)
    expect(triggerConversionBounds.defaults.maxLibraryElements).toBe(1000000)
  })

  // A map that came back from Galaxy has to be shaped the way the editor
  // writes one: content directly under <TriggerData>, no <Library> wrapper,
  // and no Library attribute on a reference into the document itself. A map
  // rebuilt with the mod shape is read as a stray library and will not open.
  it('rebuilds a map document without the library wrapper a mod would declare', async () => {
    const mapTriggers = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<TriggerData>',
      '    <Root>',
      '        <Item Type="Trigger" Id="B9D8A280"/>',
      '    </Root>',
      '    <Element Type="Trigger" Id="B9D8A280">',
      '        <Event Type="FunctionCall" Id="FA74D637"/>',
      '    </Element>',
      '    <Element Type="FunctionCall" Id="FA74D637">',
      '        <FunctionDef Type="FunctionDef" Library="Ntve" Id="00000120"/>',
      '    </Element>',
      '</TriggerData>',
    ].join('\n')
    const nativeDependency =
      '<TriggerData><Library Id="Ntve">'
      + '<Element Type="FunctionDef" Id="00000120"><Identifier>MapInit</Identifier><FlagEvent/></Element>'
      + '</Library></TriggerData>'
    const dependencyLibraries = [{ triggerData: nativeDependency }]

    const forward = await convertTriggersToGalaxy(mapTriggers, { dependencyLibraries }, undefined)
    expect(forward.output.documentKind).toBe('map')

    const back = await convertGalaxyToTriggers(
      {
        script: forward.output.script,
        header: forward.output.header,
        libraryId: forward.output.libraryId,
        documentKind: forward.output.documentKind,
        dependencyLibraries,
      },
      undefined,
    )
    const rebuilt = back.output.triggerData

    expect(rebuilt).not.toContain('<Library ')
    expect(rebuilt).not.toContain('</Library>')
    expect(rebuilt).not.toMatch(/Library="Map"/u)
    expect(rebuilt).toContain('Library="Ntve"')
    expect(parseTriggerXmlSync(rebuilt).size).toBe(0)
  })

  it('uses authored Galaxy identifiers as map display names and does not place prototypes twice', async () => {
    const result = await convertGalaxyToTriggers({
      libraryId: 'Map',
      documentKind: 'map',
      header: '',
      script: [
        '//----------------------------------------',
        '// Library: Example',
        '//----------------------------------------',
        'void authoredFunction(int lp_count);',
        '//----------------------------------------',
        '// Library: Example',
        '//----------------------------------------',
        'void authoredFunction(int lp_count) { int lv_score; }',
        'const int lib1_ge_CosmeticType_Decoration = 0;',
      ].join('\n'),
    })
    expect(result.output.triggerStrings).toMatch(/^\uFEFF?FunctionDef\/Name\/[A-F0-9]+=authoredFunction$/mu)
    expect(result.output.triggerStrings).toMatch(/(?:^|\n)ParamDef\/Name\/[A-F0-9]+=.+$/mu)
    expect(result.output.triggerStrings).toMatch(/(?:^|\n)Variable\/Name\/[A-F0-9]+=.+$/mu)
    expect(result.output.triggerStrings).toMatch(/(?:^|\n)Variable\/Name\/[A-F0-9]+=CosmeticType Decoration$/mu)
    expect(result.output.triggerData.match(/<Item Type="FunctionDef" Id="[A-F0-9]+"\/>/gu)).toHaveLength(1)
  })

  it('keeps authored structure and local names and prefers native user-function control flow', async () => {
    const native = [
      '<TriggerData><Library Id="Ntve">',
      '<Element Type="FunctionDef" Id="00000137"><Identifier>IfThenElse</Identifier><FlagAction/><FlagSubFunctions/><ScriptCode>if (#SUBFUNCS(if,&quot; &amp;&amp; &quot;)) { #SUBFUNCS(then) } #IFHAVESUBFUNCS(else,else {) #SUBFUNCS(else) #IFHAVESUBFUNCS(else,})</ScriptCode>',
      '<SubFunctionType Type="SubFuncType" Library="Ntve" Id="00000003"/><SubFunctionType Type="SubFuncType" Library="Ntve" Id="00000004"/><SubFunctionType Type="SubFuncType" Library="Ntve" Id="00000005"/></Element>',
      '<Element Type="SubFuncType" Id="00000003"><Identifier>if</Identifier><Condition/></Element>',
      '<Element Type="SubFuncType" Id="00000004"><Identifier>then</Identifier><Action/></Element>',
      '<Element Type="SubFuncType" Id="00000005"><Identifier>else</Identifier><Action/></Element>',
      '<Element Type="FunctionDef" Id="00000097"><Identifier>Return</Identifier><FlagAction/><FlagOperator/><Parameter Type="ParamDef" Library="Ntve" Id="00000488"/><ScriptCode>return #PARAM(val);</ScriptCode></Element>',
      '<Element Type="ParamDef" Id="00000488"><Identifier>val</Identifier><ParameterType><Type Value="return"/></ParameterType></Element>',
      '<Element Type="FunctionDef" Id="00000139"><Identifier>SkipRemaining</Identifier><FlagAction/><FlagOperator/></Element>',
      '</Library></TriggerData>',
    ].join('')
    const nativeLibrary = parseTriggerXmlSync(native).get('Ntve')!
    nativeLibrary.subFuncTypeNames = {
      Ntve_00000003: 'If', Ntve_00000004: 'Then', Ntve_00000005: 'Else',
    }
    const script = [
      'struct lib1_gs_Card { int lv_value; };',
      'bool choose(bool lp_ready) { int lv_counter; if (lp_ready) { return true; } else { return false; } }',
    ].join('\n')
    const result = convertGalaxyToTriggerLibrary(
      parseGalaxySource(script, 'MapScript.galaxy'),
      parseGalaxySource('', 'MapScript_h.galaxy'),
      { libraryId: 'Map', implicitLibrary: true, nativeLibrary },
    )
    const elements = Object.values(result.elements) as any[]
    expect(elements.find(element => element.type === 'Structure')?.name).toBe('Card')
    expect(elements.find(element => element.type === 'Variable' && element.name === 'counter')).toBeDefined()
    expect(elements.some(element => element.type === 'Variable' && /^counter_[A-F0-9]+$/u.test(element.name))).toBe(false)
    const calls = elements.filter(element => element.type === 'FunctionCall')
    expect(calls.filter(call => call.functionDef?.library === 'Ntve' && call.functionDef?.id === '00000137')).toHaveLength(1)
    expect(calls.filter(call => call.functionDef?.library === 'Ntve' && call.functionDef?.id === '00000097')).toHaveLength(2)
    expect(calls.some(call => call.functionDef?.id === '00000139')).toBe(false)

    const regenerated = convertTriggerLibraryToGalaxyFull(result, nativeLibrary)
    expect(regenerated.script).toContain('if (')
    expect(regenerated.script).toContain('return true;')
    expect(regenerated.script).toContain('return false;')
    expect(regenerated.script).not.toMatch(/return false;\s*\}\s*return 0;/u)
  })
})
