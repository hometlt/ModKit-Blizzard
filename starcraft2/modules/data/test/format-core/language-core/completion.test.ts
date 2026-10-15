/**
 * M3 — completion core (vscode-free). Discovers a real enum/link field off the
 * catalog schema at runtime so it doesn't hardcode names that drift.
 */
import { describe, it, expect } from 'vitest'
import { computeCompletions, fileExtensions } from '../../../shared/format/language/completion.js'
import {
  catalogClasses,
  catalogClassesForNamespace,
  catalogStructureDefaultsForNamespace,
  getClassFields,
  classifyField,
  type FieldInfo,
} from '../../../shared/catalog-engine/sc2-catalog'

/** Split a `|`-marked template into text + cursor offset. */
function cursor(template: string): { text: string; offset: number } {
  const offset = template.indexOf('|')
  return { text: template.slice(0, offset) + template.slice(offset + 1), offset }
}

function findField(pred: (i: FieldInfo) => boolean): { name: string; info: FieldInfo } | undefined {
  for (const cls of ['CUnit', 'CWeapon', 'CAbil', 'CEffectDamage']) {
    const schema = getClassFields(cls)
    if (!schema || cls !== 'CUnit') continue // keep examples on CUnit for stable test docs
    for (const [name, ft] of Object.entries(schema)) {
      const info = classifyField(ft)
      if (pred(info)) return { name, info }
    }
  }
  return undefined
}

describe('parent="…" completion — default entities first (DX5)', () => {
  it('surfaces in-document default/template entities as preferred', () => {
    const { text, offset } = cursor(
      '<Catalog><CUnit id="BaseTmpl" default="1"/><CUnit id="Concrete"/><CUnit id="X" parent="|"/></Catalog>',
    )
    const r = computeCompletions(text, offset)
    expect(r.kind).toBe('values')
    if (r.kind === 'values') {
      expect(r.values).toEqual(expect.arrayContaining(['BaseTmpl', 'Concrete']))
      expect(r.preferred).toEqual(['BaseTmpl']) // only the default="1" template
    }
  })

  it('omits preferred when no default entity exists', () => {
    const { text, offset } = cursor('<Catalog><CUnit id="A"/><CUnit id="X" parent="|"/></Catalog>')
    const r = computeCompletions(text, offset)
    if (r.kind === 'values') expect(r.preferred).toBeUndefined()
  })
})

describe('root catalog-class completion', () => {
  it('offers only Catalog at the document root', () => {
    const { text, offset } = cursor('<|')
    const r = computeCompletions(text, offset, undefined, undefined, undefined, {
      kind: 'typed',
      namespace: 'Unit',
    })
    expect(r.kind).toBe('classes')
    if (r.kind !== 'classes') return
    expect(r.classes).toEqual(['Catalog'])
    expect(r.structures).toBeUndefined()
  })

  it('filters a partially typed document root to Catalog', () => {
    const { text, offset } = cursor('<Cat|')
    const r = computeCompletions(text, offset)
    expect(r.kind).toBe('classes')
    if (r.kind !== 'classes') return
    expect(r.classes).toEqual(['Catalog'])
    expect(r.snippet).toBe(false)
  })

  it.each(['Unit', 'Actor'])(
    'uses the explicit %s catalog context for an empty file',
    namespace => {
      const { text, offset } = cursor('<Catalog>|</Catalog>')
      const r = computeCompletions(text, offset, undefined, undefined, undefined, {
        kind: 'typed',
        namespace,
      })
      expect(r.kind).toBe('classes')
      if (r.kind !== 'classes') return
      expect(r.classes).toEqual([...catalogClassesForNamespace(namespace)].sort().concat('const'))
      expect(r.structures).toEqual(catalogStructureDefaultsForNamespace(namespace))
    },
  )

  it('offers every catalog class and const, but no structures, for an untyped file', () => {
    const { text, offset } = cursor('<Catalog>|</Catalog>')
    const r = computeCompletions(text, offset, undefined, undefined, undefined, { kind: 'untyped' })
    expect(r.kind).toBe('classes')
    if (r.kind !== 'classes') return
    expect(r.classes).toEqual([...catalogClasses(), 'const'])
    expect(r.classes.some(name => name.startsWith('S'))).toBe(false)
    expect(r.structures).toBeUndefined()
  })

  it('filters a large untyped catalog before the host result limit is applied', () => {
    const { text, offset } = cursor('<Catalog><CUn|</Catalog>')
    const r = computeCompletions(text, offset, undefined, undefined, undefined, { kind: 'untyped' })
    expect(r.kind).toBe('classes')
    if (r.kind !== 'classes') return
    expect(r.classes).toContain('CUnit')
    expect(r.classes.every(name => name.toLowerCase().startsWith('cun'))).toBe(true)
  })

  it("offers this file's namespace classes + const at the Catalog root", () => {
    const { text, offset } = cursor('<Catalog><CTerrain id="X"/><|</Catalog>')
    const r = computeCompletions(text, offset)
    expect(r.kind).toBe('classes')
    if (r.kind === 'classes') {
      expect(r.classes).toContain('CTerrain')
      expect(r.classes).toContain('const')
    }
  })

  it('completes a partially-typed root class name', () => {
    const { text, offset } = cursor('<Catalog><CUnit id="X"/><CUn|</Catalog>')
    const r = computeCompletions(text, offset)
    expect(r.kind).toBe('classes')
    if (r.kind === 'classes') expect(r.classes).toContain('CUnit')
  })

  it('does not offer classes when not at the catalog root', () => {
    const { text, offset } = cursor('<Catalog><CUnit id="X">|</CUnit></Catalog>')
    const r = computeCompletions(text, offset)
    expect(r.kind).not.toBe('classes') // inside an entity → field completion
  })
})

describe('computeCompletions — fields', () => {
  it('filters partially typed field names before the host result limit is applied', () => {
    const { text, offset } = cursor('<CUnit id="X"><Life|</CUnit>')
    const r = computeCompletions(text, offset)
    expect(r.kind).toBe('fields')
    if (r.kind !== 'fields') return
    expect(r.fields.some(field => field.name === 'LifeMax')).toBe(true)
    expect(r.fields.every(field => field.name.toLowerCase().startsWith('life'))).toBe(true)
  })

  it('offers entity fields in content position', () => {
    const { text, offset } = cursor('<CUnit id="X">|</CUnit>')
    const r = computeCompletions(text, offset)
    expect(r.kind).toBe('fields')
    if (r.kind !== 'fields') return
    expect(r.fields.length).toBeGreaterThan(30)
    expect(r.replaceStart).toBe(r.replaceEnd) // insertion (full element snippet)
  })

  it('completes a partially-typed field name', () => {
    const { text, offset } = cursor('<CUnit id="X"><Lif|</CUnit>')
    const r = computeCompletions(text, offset)
    expect(r.kind).toBe('fields')
    if (r.kind !== 'fields') return
    // Replaces the typed name fragment, and offers real fields (e.g. LifeMax/LifeStart).
    expect(r.replaceEnd).toBeGreaterThan(r.replaceStart)
    expect(r.fields.some(f => f.name.startsWith('Life'))).toBe(true)
  })

  it('does not re-offer a present non-repeatable field, but keeps array fields', () => {
    const arr = findField(i => i.kind === 'array')
    const scalar = findField(i => i.kind === 'enum' || i.kind === 'link')
    if (!scalar) return
    const doc = `<CUnit id="X"><${scalar.name} value="x"/>|</CUnit>`
    const { text, offset } = cursor(doc)
    const r = computeCompletions(text, offset)
    if (r.kind !== 'fields') throw new Error('expected fields')
    expect(r.fields.some(f => f.name === scalar.name)).toBe(false)
    if (arr) expect(r.fields.some(f => f.name === arr.name)).toBe(true)
  })
})

describe('computeCompletions — values', () => {
  it('offers enum members inside value="…"', () => {
    const enumField = findField(i => i.kind === 'enum' && (i.enumMembers?.length ?? 0) > 0)
    expect(enumField, 'expected an enum field on CUnit').toBeDefined()
    const { text, offset } = cursor(`<CUnit id="X"><${enumField!.name} value="|"/></CUnit>`)
    const r = computeCompletions(text, offset)
    expect(r.kind).toBe('values')
    if (r.kind !== 'values') return
    expect(r.values).toEqual([...enumField!.info.enumMembers!])
  })

  it('quotes an enum value selected immediately after =', () => {
    const enumField = findField(i => i.kind === 'enum' && (i.enumMembers?.length ?? 0) > 0)
    expect(enumField, 'expected an enum field on CUnit').toBeDefined()
    const { text, offset } = cursor(`<CUnit id="X"><${enumField!.name} value=|/></CUnit>`)
    const result = computeCompletions(text, offset)
    expect(result.kind).toBe('values')
    if (result.kind !== 'values') return
    expect(result.quote).toBe(true)
    expect(result.replaceStart).toBe(offset)
    expect(result.replaceEnd).toBe(offset)
  })

  it('completes only the current flag after comma or semicolon', () => {
    const flagField = findField(i => i.kind === 'flags' && (i.enumMembers?.length ?? 0) > 1)
    expect(flagField, 'expected a flags field on CUnit').toBeDefined()
    const first = flagField!.info.enumMembers![0]!
    for (const separator of [',', ';']) {
      const { text, offset } = cursor(
        `<CUnit id="X"><${flagField!.name} value="${first}${separator}|"/></CUnit>`,
      )
      const result = computeCompletions(text, offset)
      expect(result.kind).toBe('values')
      if (result.kind !== 'values') continue
      expect(result.values).not.toContain(first)
      expect(result.replaceStart).toBe(offset)
      expect(result.replaceEnd).toBe(offset)
    }
  })

  it('offers reference ids from the catalog for a link field', () => {
    const linkField = findField(
      i => i.kind === 'link' && !!i.linkNamespace && !i.isTextLink && !i.isFileLink,
    )
    if (!linkField) return
    const ns = linkField.info.linkNamespace!
    const { text, offset } = cursor(`<CUnit id="X"><${linkField.name} value="|"/></CUnit>`)
    const r = computeCompletions(text, offset, n => (n === ns ? ['Alpha', 'Beta'] : []))
    expect(r.kind).toBe('values')
    if (r.kind !== 'values') return
    expect(r.values).toEqual(['Alpha', 'Beta'])
  })

  it('offers only the Catalog wrapper outside an entity', () => {
    const { text, offset } = cursor('|<CUnit id="X"></CUnit>')
    const r = computeCompletions(text, offset)
    expect(r.kind).toBe('classes')
    if (r.kind === 'classes') expect(r.classes).toEqual(['Catalog'])
  })

  it('completes parent="…" with catalog ids ∪ in-document ids of the namespace', () => {
    const { text, offset } = cursor(
      '<Catalog><CUnit id="Base"/><CUnit id="X" parent="|"></CUnit></Catalog>',
    )
    const r = computeCompletions(text, offset, ns => (ns === 'Unit' ? ['Marine'] : []))
    expect(r.kind).toBe('values')
    if (r.kind !== 'values') return
    expect(r.values).toEqual(expect.arrayContaining(['Marine', 'Base'])) // catalog + in-doc
  })

  it('keeps a typed "<" (empty range, no lead) so the list shows and the snippet does not double it', () => {
    const { text, offset } = cursor('<CUnit id="X"><|</CUnit>')
    const r = computeCompletions(text, offset)
    expect(r.kind).toBe('fields')
    if (r.kind !== 'fields') return
    expect(r.snippet).toBe(true)
    // The typed '<' stays outside the range (so VS Code shows the whole list on '<'),
    // and the snippet omits its own '<' to avoid '<<'.
    expect(r.replaceStart).toBe(offset)
    expect(r.replaceEnd).toBe(offset)
    expect(r.lead).toBe(false)
  })

  it('offers entity attributes id/parent on the catalog class open tag', () => {
    const { text, offset } = cursor('<CUnit |></CUnit>')
    const r = computeCompletions(text, offset)
    expect(r.kind).toBe('attributes')
    if (r.kind === 'attributes') {
      const names = r.attributes.map(a => a.name)
      expect(names).toContain('id')
      expect(names).toContain('parent')
      expect(names).not.toContain('default') // no parent set yet
    }
  })

  it('offers default on the class open tag once a parent is set', () => {
    const { text, offset } = cursor('<CUnit parent="Base" |></CUnit>')
    const r = computeCompletions(text, offset)
    expect(r.kind).toBe('attributes')
    if (r.kind === 'attributes') expect(r.attributes.map(a => a.name)).toContain('default')
  })

  it('offers attribute names (not element snippets) in the open-tag attribute area', () => {
    const { text, offset } = cursor('<CUnit id="X"><AbilArray |index="0"/></CUnit>')
    const result = computeCompletions(text, offset)
    // Never an element snippet here (that produced `<AbilArray <Field…>`).
    expect(result.kind).not.toBe('fields')
    expect(result.kind).toBe('attributes')
    if (result.kind === 'attributes') {
      // `index` is already present on the element, so it isn't re-offered.
      expect(result.attributes.map(a => a.name)).not.toContain('index')
    }
  })

  it('replaces only the category key after a comma separator', () => {
    const { text, offset } = cursor(
      '<CUnit id="X"><EditorCategories value="ObjectType:Unit,Ra|"/></CUnit>',
    )
    const r = computeCompletions(text, offset, undefined, () => [
      { name: 'ObjectType', values: ['Unit'] },
      { name: 'Race', values: ['Terran', 'Zerg'] },
    ])
    expect(r.kind).toBe('values')
    if (r.kind !== 'values') return
    expect(r.values).toEqual(['ObjectType', 'Race'])
    expect(text.slice(r.replaceStart, r.replaceEnd)).toBe('Ra')
  })

  it('replaces only the category value after a colon separator', () => {
    const { text, offset } = cursor(
      '<CUnit id="X"><EditorCategories value="ObjectType:Unit,Race:Ter|"/></CUnit>',
    )
    const r = computeCompletions(text, offset, undefined, () => [
      { name: 'ObjectType', values: ['Unit'] },
      { name: 'Race', values: ['Terran', 'Zerg'] },
    ])
    expect(r.kind).toBe('values')
    if (r.kind !== 'values') return
    expect(r.values).toEqual(['Terran', 'Zerg'])
    expect(text.slice(r.replaceStart, r.replaceEnd)).toBe('Ter')
  })
})

describe('fileExtensions', () => {
  it('maps file types to extensions', () => {
    expect(fileExtensions('CImageFile')).toEqual(['.dds', '.tga'])
    expect(fileExtensions('CTexturePath')).toEqual(['.dds', '.tga'])
    expect(fileExtensions('CModelFile')).toEqual(['.m3'])
    expect(fileExtensions('CSoundFile')).toContain('.ogg')
    expect(fileExtensions(undefined)).toEqual([]) // unknown → offer all
  })
})

describe('file-field completion', () => {
  it('returns an assets request for a file-typed field', () => {
    let hit: { className: string; name: string } | undefined
    for (const className of ['CButton', 'CActor', 'CActorModel', 'CModel', 'CUnit']) {
      const schema = getClassFields(className)
      if (!schema) continue
      for (const [name, ft] of Object.entries(schema)) {
        if (classifyField(ft).kind === 'file') {
          hit = { className, name }
          break
        }
      }
      if (hit) break
    }
    if (!hit) return // no plain CFile field on these classes — skip
    const { text, offset } = cursor(
      `<${hit.className} id="X"><${hit.name} value="|"/></${hit.className}>`,
    )
    expect(computeCompletions(text, offset).kind).toBe('assets')
  })
})
