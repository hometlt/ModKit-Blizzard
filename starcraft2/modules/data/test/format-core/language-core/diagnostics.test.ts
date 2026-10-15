/**
 * M2 — XML scanner, schema introspection, and diagnostics core. All vscode-free.
 * Enum/link cases discover a real field off DATA_CLASS_SCHEMA at runtime rather than
 * hardcoding field names (which drift), so they stay valid as the schema evolves.
 */
import { describe, it, expect } from 'vitest'
import { scanXml, getAttr } from '../../../shared/format/language/xml-scan.js'
import { getClassFields, classifyField, validateFieldValue } from '../../../shared/catalog-engine/sc2-catalog'
import type { FieldInfo } from '../../../shared/catalog-engine/sc2-catalog'
import { catalogConstAliases, collectIssues } from '../../../shared/format/language/diagnostics.js'
import { fileExtensions } from '../../../shared/format/language/completion.js'

/** First class+field whose classification matches `pred` (schema-discovered, no hardcoded names). */
function findClassField(
  pred: (i: FieldInfo) => boolean,
): { cls: string; name: string; info: FieldInfo } | undefined {
  for (const cls of [
    'CActor',
    'CActorModel',
    'CActorUnit',
    'CUnit',
    'CButton',
    'CWeapon',
    'CAbil',
    'CSound',
    'CModel',
  ]) {
    const schema = getClassFields(cls)
    if (!schema) continue
    for (const [name, ft] of Object.entries(schema)) {
      const info = classifyField(ft)
      if (pred(info)) return { cls, name, info }
    }
  }
  return undefined
}

describe('duplicate id (DX1)', () => {
  it('flags every top-level entity after the first that reuses an id in the same namespace', () => {
    const text =
      '<Catalog><CUnit id="Dup"/><CUnit id="Dup"/><CUnit id="Dup"/><CUnit id="Other"/></Catalog>'
    const dups = collectIssues(text).filter(i => i.message.includes("Duplicate id 'Dup'"))
    expect(dups.length).toBe(2) // 2nd and 3rd occurrences, not the first
  })

  it('does not flag the same id across DIFFERENT namespaces (Unit/X vs Weapon/X)', () => {
    const text = '<Catalog><CUnit id="Shared"/><CWeapon id="Shared"/></Catalog>'
    expect(collectIssues(text).filter(i => i.message.includes('Duplicate id'))).toHaveLength(0)
  })
})

describe('parent reference validation (T1.4 / circular)', () => {
  const parentIssues = (text: string, has?: (ns: string, id: string) => boolean): string[] =>
    collectIssues(text, has)
      .map(i => i.message)
      .filter(m => /parent/i.test(m))

  it('flags an unresolved (dangling) parent when the catalog is loaded', () => {
    const text = '<Catalog><CUnit id="X" parent="NoSuchBase___"/></Catalog>'
    expect(
      parentIssues(text, () => false).some(m => m.includes("Unresolved parent 'NoSuchBase___'")),
    ).toBe(true)
  })

  it('does NOT require the parent to be a default entity (non-default parents are valid)', () => {
    // Base is a plain (non-default) entity that resolves — must not be flagged.
    const text = '<Catalog><CUnit id="Base"/><CUnit id="X" parent="Base"/></Catalog>'
    expect(parentIssues(text, () => false)).toEqual([])
  })

  it('stays silent when no catalog is loaded, on parent="", and on templated parents', () => {
    expect(parentIssues('<Catalog><CUnit id="X" parent="Whatever"/></Catalog>')).toEqual([]) // no catalogHas
    expect(parentIssues('<Catalog><CUnit id="X" parent=""/></Catalog>', () => false)).toEqual([]) // reset
    expect(
      parentIssues('<Catalog><CUnit id="X" parent="##Token##"/></Catalog>', () => false),
    ).toEqual([])
  })

  it('flags a circular parent chain (A↔B and self-parent), but not an acyclic chain', () => {
    const cyc = '<Catalog><CAbil id="A" parent="B"/><CAbil id="B" parent="A"/></Catalog>'
    expect(
      collectIssues(cyc, () => true).filter(i => /Circular parent/.test(i.message)).length,
    ).toBe(2)
    const self = '<Catalog><CAbil id="A" parent="A"/></Catalog>'
    expect(collectIssues(self, () => true).some(i => /Circular parent/.test(i.message))).toBe(true)
    const ok =
      '<Catalog><CAbil id="Base"/><CAbil id="A" parent="Base"/><CAbil id="B" parent="A"/></Catalog>'
    expect(collectIssues(ok, () => true).some(i => /Circular parent/.test(i.message))).toBe(false)
  })
})

describe('file-field extension (DX3)', () => {
  it('warns on a recognized asset extension for the WRONG asset category', () => {
    const found = findClassField(
      i =>
        (i.kind === 'file' || (i.kind === 'link' && i.isFileLink)) &&
        fileExtensions(i.typeName).length > 0,
    )
    if (!found) return // schema exposes no typed file field on the probed classes
    const expected = fileExtensions(found.info.typeName)
    const wrong = expected.includes('.m3') ? '.dds' : '.m3'
    const bad = `<Catalog><${found.cls} id="A"><${found.name} value="thing${wrong}"/></${found.cls}></Catalog>`
    expect(collectIssues(bad).some(i => i.message.includes('Unexpected file type'))).toBe(true)

    const good = `<Catalog><${found.cls} id="A"><${found.name} value="thing${expected[0]}"/></${found.cls}></Catalog>`
    expect(collectIssues(good).some(i => i.message.includes('Unexpected file type'))).toBe(false)
  })

  it('stays silent on unknown extensions (.wem) and @@ aliases (no false positives)', () => {
    const found = findClassField(
      i =>
        (i.kind === 'file' || (i.kind === 'link' && i.isFileLink)) &&
        fileExtensions(i.typeName).length > 0,
    )
    if (!found) return
    for (const v of ['thing.wem', '@@UI/SomeAlias', 'bareNameNoExt']) {
      const text = `<Catalog><${found.cls} id="A"><${found.name} value="${v}"/></${found.cls}></Catalog>`
      expect(collectIssues(text).some(i => i.message.includes('Unexpected file type'))).toBe(false)
    }
  })
})

describe('actor message (instruction) validation (DX7)', () => {
  // CActorModel.On:[SActorEvent], Send=CActorMsgPayloadPtr — a dispatched instruction scalar.
  const send = (v: string, has?: (ns: string, id: string) => boolean): string[] =>
    collectIssues(
      `<Catalog><CActorModel id="A"><On Send="${v}"/></CActorModel></Catalog>`,
      has,
    ).map(i => i.message)

  it('validates entity refs embedded in a KNOWN message (ModelSwap → Model, Create → Actor)', () => {
    expect(
      send('ModelSwap NoSuchModel___ 9', () => false).some(m => m.includes('no such Model')),
    ).toBe(true)
    expect(send('Create NoSuchActor___', () => false).some(m => m.includes('no such Actor'))).toBe(
      true,
    )
    // Valid refs resolve — no warning.
    expect(
      send('ModelSwap RealModel 9', (ns, id) => ns === 'Model' && id === 'RealModel').some(m =>
        m.includes('Unresolved'),
      ),
    ).toBe(false)
  })

  it('never flags an UNKNOWN/unmodeled message keyword (tables are partial allowlists)', () => {
    expect(send('SomeMessageWeDoNotModel whatever', () => false)).toEqual([])
  })

  it('skips brace-group and ::query complex args (no false positives)', () => {
    expect(send('AttachSetBearingsFrom {Weapon 0} {} {SOpShadow}', () => false)).toEqual([])
    expect(send('RefSetFromMsg ::actor.SupplyDropModel ::Sender', () => false)).toEqual([])
  })

  // CActorModel.On.Terms = CActorTerms = CSArray<CActorTerm> — a `;`-separated LIST of
  // instructions; each segment is validated independently.
  const terms = (v: string, has?: (ns: string, id: string) => boolean): string[] =>
    collectIssues(
      `<Catalog><CActorModel id="A"><On Terms="${v}"/></CActorModel></Catalog>`,
      has,
    ).map(i => i.message)

  it('validates each `;`-separated actor term segment (AbilTrainProduced → Unit)', () => {
    expect(
      terms('AbilTrainProduced NoSuchUnit___', () => false).some(m => m.includes('no such Unit')),
    ).toBe(true)
    // Second segment is validated too, independent of the first.
    expect(
      terms('Age; AbilTrainProduced NoSuchUnit___', () => false).some(m =>
        m.includes('no such Unit'),
      ),
    ).toBe(true)
    // Valid ref resolves — no warning.
    expect(
      terms('AbilTrainProduced RealUnit', (ns, id) => ns === 'Unit' && id === 'RealUnit').some(m =>
        m.includes('Unresolved'),
      ),
    ).toBe(false)
  })
})

describe('numeric format + integer validation (DX6)', () => {
  it('warns on non-numeric and non-integer values for a bounded integer field', () => {
    const found = findClassField(
      i =>
        i.kind === 'number' &&
        i.numberFloat === false &&
        i.numberMin === 0 &&
        i.numberMax !== undefined,
    )
    if (!found) return
    const at = (v: string): string[] =>
      collectIssues(
        `<Catalog><${found.cls} id="A"><${found.name} value="${v}"/></${found.cls}></Catalog>`,
      ).map(x => x.message)

    // Well-formedness + integer-ness are enforced…
    expect(at('notanumber').some(m => m.includes('Invalid number'))).toBe(true)
    expect(at('1.5').some(m => m.includes('Expected an integer'))).toBe(true)
    // …but the schema's logical min/max are deliberately NOT (real SC2 data uses `-1`/`-N`
    // sentinels and Bit fields packed with counts — range checks false-positive). See
    // validateFieldValue: only format + integer-ness survive.
    expect(at('-5').some(m => /minimum|maximum/.test(m))).toBe(false)
    expect(at(String(found.info.numberMax! + 1)).some(m => /minimum|maximum/.test(m))).toBe(false)
    // A plain integer produces no numeric warning.
    expect(at('1').some(m => /minimum|maximum|integer|Invalid number/.test(m))).toBe(false)
  })

  it('accepts fractions for a float field and skips templated values', () => {
    const found = findClassField(i => i.kind === 'number' && i.numberFloat === true)
    if (!found) return
    const at = (v: string): string[] =>
      collectIssues(
        `<Catalog><${found.cls} id="A"><${found.name} value="${v}"/></${found.cls}></Catalog>`,
      ).map(x => x.message)
    expect(at('1.5').some(m => /integer/.test(m))).toBe(false)
    expect(at('#TOKEN').length).toBe(0) // templated → skipped
  })
})

describe('text-key existence (DX4)', () => {
  it('warns on a text-link value that is not a known string key, only when hasString is provided', () => {
    const found = findClassField(i => i.kind === 'link' && !!i.isTextLink)
    if (!found) return
    const text = `<Catalog><${found.cls} id="A"><${found.name} value="Some/Key"/></${found.cls}></Catalog>`
    // No hasString → text checks skipped (like link checks without catalogHas).
    expect(collectIssues(text).some(i => i.message.includes('Unknown text key'))).toBe(false)
    // hasString rejects → warning; accepts → none.
    expect(
      collectIssues(text, undefined, undefined, undefined, { hasString: () => false }).some(i =>
        i.message.includes("Unknown text key 'Some/Key'"),
      ),
    ).toBe(true)
    expect(
      collectIssues(text, undefined, undefined, undefined, {
        hasString: k => k === 'Some/Key',
      }).some(i => i.message.includes('Unknown text key')),
    ).toBe(false)
  })
})

describe('scanXml', () => {
  it('captures entities, children, and attribute value offsets', () => {
    const text = '<CUnit id="Marine"><LifeMax value="45"/></CUnit>'
    const roots = scanXml(text)
    expect(roots).toHaveLength(1)
    const unit = roots[0]!
    expect(unit.tag).toBe('CUnit')
    const id = getAttr(unit, 'id')!
    expect(text.slice(id.valueStart, id.valueEnd)).toBe('Marine')
    expect(unit.children).toHaveLength(1)
    const life = unit.children[0]!
    expect(life.tag).toBe('LifeMax')
    expect(getAttr(life, 'value')!.value).toBe('45')
  })

  it('is lenient: ignores comments/PIs and unclosed tags', () => {
    const text = '<?xml version="1.0"?>\n<!-- c -->\n<CUnit id="X"><Foo value="1"/>'
    const roots = scanXml(text)
    expect(roots[0]!.tag).toBe('CUnit')
    expect(roots[0]!.children[0]!.tag).toBe('Foo')
  })
})

describe('schema introspection', () => {
  it('resolves CUnit fields from the full DATA_CLASS_SCHEMA (not the minimal registry)', () => {
    const schema = getClassFields('CUnit')
    expect(schema).toBeDefined()
    // The minimal builtin registry has only a handful; the real one has many.
    expect(Object.keys(schema!).length).toBeGreaterThan(30)
  })
})

describe('Link struct-shorthand validation', () => {
  it('checks `<WeaponArray Link="…"/>`-style references against the catalog', () => {
    const text =
      '<Catalog><CUnit id="A"><WeaponArray index="0" Link="NoSuchWeapon___"/></CUnit></Catalog>'
    const dangling = collectIssues(text, () => false)
    expect(dangling.some(i => i.message.includes('NoSuchWeapon___'))).toBe(true)
    const resolved = collectIssues(text, (ns, id) => ns === 'Weapon' && id === 'NoSuchWeapon___')
    expect(resolved.some(i => i.message.includes('NoSuchWeapon___'))).toBe(false)
  })

  it('still exempts Link from the unknown-attribute warning when not a schema field', () => {
    // CUnit's own open tag: Link isn't a CUnit field — no "unknown attribute" noise.
    const text = '<Catalog><CUnit id="A" Link="X"/></Catalog>'
    const issues = collectIssues(text)
    expect(issues.some(i => i.message.includes("'Link'"))).toBe(false)
  })
})

describe('category validation for standard data files', () => {
  const text = '<Catalog><CUnit id="Marine"/><CActor id="MarineActor"/></Catalog>'

  it('warns on a class from the wrong category in a standard data file', () => {
    const issues = collectIssues(text, undefined, undefined, 'UnitData.xml')
    const wrong = issues.filter(i => /does not belong in UnitData\.xml/.test(i.message))
    expect(wrong).toHaveLength(1)
    expect(wrong[0]!.message).toMatch(/CActor/)
  })

  it("does not warn on classes of the file's own category", () => {
    const issues = collectIssues(text, undefined, undefined, 'ActorData.xml')
    expect(issues.some(i => /CActor.*does not belong/.test(i.message))).toBe(false)
  })

  it('leaves custom catalog files (unknown name) unrestricted', () => {
    const issues = collectIssues(text, undefined, undefined, 'MyCustomStuff.xml')
    expect(issues.some(i => /does not belong/.test(i.message))).toBe(false)
  })
})

/** Find the first (class, field) across candidate classes whose kind matches. */
function findField(
  classes: string[],
  pred: (i: FieldInfo) => boolean,
): { className: string; name: string; info: FieldInfo } | undefined {
  for (const className of classes) {
    const schema = getClassFields(className)
    if (!schema) continue
    for (const [name, ft] of Object.entries(schema)) {
      const info = classifyField(ft)
      if (pred(info)) return { className, name, info }
    }
  }
  return undefined
}

describe('validateFieldValue (catalog)', () => {
  it('validates enums, flags, numbers, bools', () => {
    expect(validateFieldValue({ kind: 'enum', enumMembers: ['A', 'B'] }, 'A')).toBeUndefined()
    expect(validateFieldValue({ kind: 'enum', enumMembers: ['A', 'B'] }, 'C')?.message).toContain(
      "Invalid value 'C'",
    )
    expect(validateFieldValue({ kind: 'enum', enumMembers: ['A'] }, '3')).toBeUndefined() // integer-coded
    expect(validateFieldValue({ kind: 'flags', enumMembers: ['X', 'Y'] }, 'X;Y')).toBeUndefined()
    expect(validateFieldValue({ kind: 'flags', enumMembers: ['X'] }, 'X;Z')?.message).toContain(
      "Invalid flag 'Z'",
    )
    // SC2 flag strings are also comma-delimited, with optional +/- prefixes.
    expect(
      validateFieldValue(
        { kind: 'flags', enumMembers: ['Ally', 'Neutral', 'Enemy'] },
        'Ally,Neutral,Enemy',
      ),
    ).toBeUndefined()
    expect(
      validateFieldValue({ kind: 'flags', enumMembers: ['Ally', 'Enemy'] }, '+Ally,-Enemy'),
    ).toBeUndefined()
    expect(
      validateFieldValue({ kind: 'flags', enumMembers: ['Ally'] }, 'Ally,Bogus')?.message,
    ).toContain("Invalid flag 'Bogus'")
    expect(validateFieldValue({ kind: 'number' }, '45')).toBeUndefined()
    expect(validateFieldValue({ kind: 'number' }, '2.25')).toBeUndefined()
    expect(validateFieldValue({ kind: 'number' }, 'abc')?.message).toContain('Invalid number')
    expect(validateFieldValue({ kind: 'bool' }, '1')).toBeUndefined()
    expect(validateFieldValue({ kind: 'bool' }, '2')?.message).toContain('Invalid boolean')
  })

  it('skips empty and templated values', () => {
    expect(validateFieldValue({ kind: 'number' }, '')).toBeUndefined()
    expect(validateFieldValue({ kind: 'number' }, '$Token$')).toBeUndefined()
    expect(validateFieldValue({ kind: 'enum', enumMembers: ['A'] }, '##x##')).toBeUndefined()
  })
})

describe('collectIssues', () => {
  it('flags an unknown field on a known class', () => {
    const text = '<CUnit id="X"><DefinitelyNotAUnitField value="1"/></CUnit>'
    const issues = collectIssues(text)
    expect(issues.some(i => i.message.includes("Unknown field 'DefinitelyNotAUnitField'"))).toBe(
      true,
    )
  })

  it('validates entities inside the real <Catalog> wrapper', () => {
    const text = '<Catalog><CUnit id="X"><DefinitelyNotAUnitField value="1"/></CUnit></Catalog>'
    const issues = collectIssues(text)
    expect(issues.some(i => i.message.includes("Unknown field 'DefinitelyNotAUnitField'"))).toBe(
      true,
    )
  })

  it('does not flag fields of an unknown/templated class', () => {
    const text = '<CTotallyMadeUpClass id="X"><Whatever value="1"/></CTotallyMadeUpClass>'
    expect(collectIssues(text)).toEqual([])
  })

  it('flags a bad enum value and accepts a valid member', () => {
    const found = findField(
      ['CUnit', 'CAbil', 'CWeapon', 'CEffectDamage'],
      i => i.kind === 'enum' && (i.enumMembers?.length ?? 0) > 0,
    )
    expect(found, 'expected some enum field in the schema').toBeDefined()
    const { className, name, info } = found!
    const member = info.enumMembers![0]!

    const bad = collectIssues(`<${className} id="X"><${name} value="__nope__"/></${className}>`)
    expect(bad.some(i => i.message.startsWith("Invalid value '__nope__'"))).toBe(true)

    const ok = collectIssues(`<${className} id="X"><${name} value="${member}"/></${className}>`)
    expect(ok).toEqual([])
  })

  it('flags an unresolved reference only when a catalog is provided', () => {
    const found = findField(
      ['CUnit', 'CWeapon', 'CAbilEffectInstant', 'CEffectDamage'],
      i => i.kind === 'link' && !!i.linkNamespace && !i.isTextLink && !i.isFileLink,
    )
    expect(found, 'expected some link field in the schema').toBeDefined()
    const { className, name } = found!
    const doc = `<${className} id="X"><${name} value="MissingThing"/></${className}>`

    // No catalog → reference checks skipped.
    expect(collectIssues(doc).some(i => i.message.includes('Unresolved reference'))).toBe(false)
    // Catalog that has nothing → flagged.
    expect(
      collectIssues(doc, () => false).some(i => i.message.includes('Unresolved reference')),
    ).toBe(true)
    // Catalog that has it → not flagged.
    expect(
      collectIssues(doc, () => true).some(i => i.message.includes('Unresolved reference')),
    ).toBe(false)
  })

  it('treats an in-document id as a resolvable reference target', () => {
    const found = findField(
      ['CUnit', 'CWeapon', 'CAbilEffectInstant', 'CEffectDamage'],
      i => i.kind === 'link' && !!i.linkNamespace && !i.isTextLink && !i.isFileLink,
    )
    if (!found) return
    const { className, name } = found
    // The referenced id is defined as a top-level entity in the same document.
    const doc = `<${className} id="Referenced"/><${className} id="X"><${name} value="Referenced"/></${className}>`
    expect(
      collectIssues(doc, () => false).some(i => i.message.includes('Unresolved reference')),
    ).toBe(false)
  })

  it('flags a default entity inheriting from a non-default parent', () => {
    const doc = '<Catalog><CUnit id="Base"/><CUnit id="Tpl" parent="Base" default="1"/></Catalog>'
    expect(
      collectIssues(doc, () => false).some(
        i => i.severity === 'error' && /non-default parent/.test(i.message),
      ),
    ).toBe(true)
  })

  it('allows a default entity inheriting from a default parent', () => {
    const doc =
      '<Catalog><CUnit id="Base" default="1"/><CUnit id="Tpl" parent="Base" default="1"/></Catalog>'
    expect(collectIssues(doc, () => false).some(i => /non-default parent/.test(i.message))).toBe(
      false,
    )
  })
})

describe('path-scoped catalog constants (<const path>)', () => {
  const unit = (extra: string) =>
    `<Catalog>${extra}<CUnit id="Peasant"><ResourceType value="lumber"/></CUnit></Catalog>`
  const flagged = (text: string, refs?: Parameters<typeof collectIssues>[4]) =>
    collectIssues(text, undefined, undefined, undefined, refs).some(i => i.message.includes("'lumber'"))

  it('flags a value outside the enum when no constant defines it', () => {
    expect(flagged(unit(''))).toBe(true)
  })

  it('accepts a value declared as a constant for that field path in the document', () => {
    expect(flagged(unit('<const id="lumber" path="CUnit.ResourceType" value="Custom"/>'))).toBe(false)
    // A constant scoped to another field does not leak.
    expect(flagged(unit('<const id="lumber" path="CUnit.ResourceState" value="Custom"/>'))).toBe(true)
  })

  it('accepts constants resolved from the mod chain through refs.isConstAlias', () => {
    const refs = { isConstAlias: (path: string, id: string) => path === 'CUnit.ResourceType' && id === 'lumber' }
    expect(flagged(unit(''), refs)).toBe(false)
  })
})

describe('path-scoped constants inside flag strings and across the mod chain', () => {
  const dependency =
    '<Catalog><const id="air" path="CWeaponLegacy.TargetFilters" value="Air"/></Catalog>'
  const dependent = (filters: string) =>
    `<Catalog><CWeaponLegacy id="Bow"><TargetFilters value="${filters}"/></CWeaponLegacy></Catalog>`
  const flagMessages = (text: string, texts: string[]) =>
    collectIssues(text, undefined, undefined, undefined, {
      isConstAlias: catalogConstAliases(texts),
    })
      .map(issue => issue.message)
      .filter(message => message.startsWith('Invalid flag'))

  it('resolves a flag constant declared in a dependency file', () => {
    expect(flagMessages(dependent('Visible;air,Dead'), [])).toEqual([expect.stringContaining("'air'")])
    expect(flagMessages(dependent('Visible;air,Dead'), [dependency])).toEqual([])
  })

  it('still reports the first token that is neither a member nor a constant', () => {
    expect(flagMessages(dependent('Visible;air,Bogus'), [dependency])).toEqual([
      expect.stringContaining("'Bogus'"),
    ])
  })
})
