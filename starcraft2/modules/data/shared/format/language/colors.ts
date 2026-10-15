/**
 * Colour values in a GameData document, found by field type rather than by name (parity plan 1.9).
 *
 * `CColor` is four bytes written `A,R,G,B` — the order `CTerrain.FogColor` is read in by the map
 * world — and `CColorRGB`/`CColorHDR` are three, `R,G,B`. That is the order the shared
 * `shared/language/sc2-colors.js` parses, so the swatch and the picker come from one parser.
 */
import { scanXml, type ScannedElement, type ScannedAttr } from './xml-scan.js'
import { catalogEntities } from './entity.js'
import {
  classifyField,
  getClassFields,
  lookupField,
  type FieldInfo,
} from '../../catalog-engine/sc2-catalog/index.js'

const COLOR_TYPES = new Set(['CColor', 'CColorRGB', 'CColorHDR'])
const MAX_DEPTH = 32

/** The attribute that holds a colour value, with its field type. */
export interface ColorSite {
  readonly attr: ScannedAttr
  readonly typeName: string
}

export function colorSites(text: string): ColorSite[] {
  const sites: ColorSite[] = []
  const take = (attr: ScannedAttr | undefined, info: FieldInfo): void => {
    if (attr !== undefined && info.typeName !== undefined && COLOR_TYPES.has(info.typeName)) {
      sites.push({ attr, typeName: info.typeName })
    }
  }
  const walk = (el: ScannedElement, schema: Record<string, unknown>, depth: number): void => {
    if (depth > MAX_DEPTH) return
    for (const attr of el.attrs) {
      const field = lookupField(schema, attr.name)
      if (field !== undefined) take(attr, classifyField(field))
    }
    for (const child of el.children) {
      const field = lookupField(schema, child.tag)
      if (field !== undefined) descend(child, classifyField(field), depth + 1)
    }
  }
  const descend = (el: ScannedElement, info: FieldInfo, depth: number): void => {
    if (info.kind === 'struct') {
      if (info.nested) walk(el, info.nested, depth)
      return
    }
    if (info.kind === 'array' || info.kind === 'record') {
      const item = classifyField(info.itemType)
      if (item.kind === 'struct') {
        if (item.nested) walk(el, item.nested, depth)
      } else take(el.attrs.find(a => a.name === 'value'), item)
      return
    }
    take(el.attrs.find(a => a.name === 'value'), info)
  }
  for (const entity of catalogEntities(scanXml(text))) {
    const schema = getClassFields(entity.tag)
    if (schema) walk(entity, schema, 0)
  }
  return sites
}
