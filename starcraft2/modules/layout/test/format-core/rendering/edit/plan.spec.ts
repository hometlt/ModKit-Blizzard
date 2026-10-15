import { describe, it, expect, beforeAll } from 'vitest'
import { Store } from '../../../../shared/layout-engine/sc2-layout-core/core.js'
import type { SchemaRegistry } from '../../../../shared/layout-engine/sc2-layout-core/core.js'
import {
  resolveFrameByPath,
  getResolvedDescendant,
} from '../../../../shared/format/rendering/resolve/resolve.js'
import {
  planPropertyEdit,
  planAnchorEdit,
  type PlanEditContext,
  type TextEdit,
} from '../../../../shared/format/rendering/edit/plan.js'
import { createTestRegistry } from '../repo-root.js'

let schema: SchemaRegistry
beforeAll(() => {
  schema = createTestRegistry()
})

const TPL = `<?xml version="1.0" encoding="utf-8"?>
<Desc>
  <Frame type="Frame" name="BaseTpl">
    <Width val="100"/>
    <Anchor side="Left" relative="$parent" pos="Min" offset="0"/>
  </Frame>
</Desc>`

const MAIN = `<?xml version="1.0" encoding="utf-8"?>
<Desc>
  <Frame type="Frame" name="Panel">
    <Frame type="Frame" name="Instance" template="Tpl/BaseTpl">
      <Height val="75"/>
      <Anchor side="Top" relative="$parent" pos="Min" offset="10"/>
    </Frame>
  </Frame>
</Desc>`

const TPL_URI = 'file:///Tpl.SC2Layout'
const MAIN_URI = 'file:///Main.SC2Layout'

function setup(readOnlyTpl = false) {
  const store = new Store(schema)
  store.updateDocument(TPL_URI, TPL)
  store.updateDocument(MAIN_URI, MAIN)
  const texts: Record<string, string> = { [TPL_URI]: TPL, [MAIN_URI]: MAIN }
  const ctx: PlanEditContext = {
    getText: uri => texts[uri],
    isEditable: uri => uri === MAIN_URI || (!readOnlyTpl && uri === TPL_URI),
  }
  const instance = resolveFrameByPath(store, 'Main/Panel/Instance')!
  return { instance, ctx, texts }
}

/** Apply edits to a doc text (offsets are into that doc; apply right-to-left). */
function apply(text: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start)
  let out = text
  for (const e of sorted) out = out.slice(0, e.start) + e.newText + out.slice(e.end)
  return out
}

describe('planPropertyEdit', () => {
  it('edits an own-declared property in place', () => {
    const { instance, ctx, texts } = setup()
    const plan = planPropertyEdit(instance, 'Height', '90', ctx)
    expect(plan.action).toBe('replace-value')
    expect(plan.currentOrigin).toBe('own')
    expect(plan.edits[0]!.uri).toBe(MAIN_URI)
    expect(apply(texts[MAIN_URI]!, plan.edits)).toContain('<Height val="90"/>')
  })

  it('materialises an override for a template-inherited property', () => {
    const { instance, ctx, texts } = setup()
    // Width comes from BaseTpl (template) — must not edit the template.
    const plan = planPropertyEdit(instance, 'Width', '250', ctx)
    expect(plan.action).toBe('insert-override')
    expect(plan.currentOrigin).toBe('template')
    expect(plan.edits[0]!.uri).toBe(MAIN_URI) // written into the instance file, not Tpl
    const out = apply(texts[MAIN_URI]!, plan.edits)
    expect(out).toContain('<Width val="250"/>')
    // Template file untouched.
    expect(plan.edits.every(e => e.uri === MAIN_URI)).toBe(true)
  })

  it('materialises an override for a property not present at all', () => {
    const { instance, ctx, texts } = setup()
    const plan = planPropertyEdit(instance, 'Alpha', '128', ctx)
    expect(plan.action).toBe('insert-override')
    expect(apply(texts[MAIN_URI]!, plan.edits)).toContain('<Alpha val="128"/>')
  })
})

describe('planAnchorEdit (drag → offset)', () => {
  it('edits an own explicit-side anchor offset in place', () => {
    const { instance, ctx, texts } = setup()
    const plan = planAnchorEdit(instance, 'Top', { offset: '25' }, ctx)
    expect(plan.action).toBe('replace-value')
    const out = apply(texts[MAIN_URI]!, plan.edits)
    expect(out).toMatch(/side="Top"[^/]*offset="25"/)
  })

  it('materialises a full Anchor override when the side is inherited from a template', () => {
    const { instance, ctx, texts } = setup()
    // Left anchor comes from BaseTpl — nudging it must materialise, not edit Tpl.
    const plan = planAnchorEdit(instance, 'Left', { offset: '5' }, ctx)
    expect(plan.action).toBe('insert-override')
    const out = apply(texts[MAIN_URI]!, plan.edits)
    expect(out).toMatch(/<Anchor side="Left"[^>]*relative="\$parent"[^>]*offset="5"\/>/)
  })
})

describe('read-only guards', () => {
  it('blocks when the only own declaration is in a read-only source', () => {
    const store = new Store(schema)
    store.updateDocument(TPL_URI, TPL)
    // Resolve BaseTpl itself (its own declaration lives in the read-only Tpl file).
    const base = resolveFrameByPath(store, 'Tpl/BaseTpl')!
    const ctx: PlanEditContext = { getText: () => TPL, isEditable: () => false }
    const plan = planPropertyEdit(base, 'Width', '5', ctx)
    expect(plan.action).toBe('blocked')
    expect(plan.reason).toContain('read-only')
  })
})
