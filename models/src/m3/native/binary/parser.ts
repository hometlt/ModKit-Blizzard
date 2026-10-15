import { M3FieldPrimitive, M3FieldStructure, M3FieldBytes } from './fields.js'
import { M3StructureHistory } from './structures.js'
import { setStructures } from './registry.js'
import { getDOMParser } from '../platform.js'

const PRIMITIVE_TYPES = new Set(['uint8', 'int16', 'uint16', 'int32', 'uint32', 'uint64', 'float'])
let cachedXmlText: string | null = null
let cachedHistories: Record<string, M3StructureHistory> | null = null

function childElements(parent: Element, tagName: string): Element[] {
  const result: Element[] = []
  const nodes = parent.childNodes
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    if (n.nodeType === 1 && (n as Element).tagName === tagName) result.push(n as Element)
  }
  return result
}

function parseHexString(hexString: string | null): Uint8Array | null {
  if (!hexString) return null
  const normalized = hexString.trim()
  if (!normalized.startsWith('0x')) return null
  const length = (normalized.length - 2) / 2
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i += 1) {
    bytes[i] = parseInt(normalized.substring(2 + i * 2, 4 + i * 2), 16)
  }
  return bytes
}

export async function loadM3StructuresXml(
  xmlText: string,
): Promise<Record<string, M3StructureHistory>> {
  if (xmlText === cachedXmlText && cachedHistories) {
    setStructures(cachedHistories)
    return cachedHistories
  }

  const parser = getDOMParser()
  const doc = new parser().parseFromString(xmlText, 'application/xml')
  const structureElements = doc.getElementsByTagName('structure')
  const histories: Record<string, M3StructureHistory> = {}

  for (let si = 0; si < structureElements.length; si++) {
    const structureElement = structureElements[si]
    const name = structureElement.getAttribute('name') || ''
    const versionToSize = new Map<number, number>()
    const versionsEl = childElements(structureElement, 'versions')[0]
    if (versionsEl) {
      const versionEls = childElements(versionsEl, 'version')
      for (let vi = 0; vi < versionEls.length; vi++) {
        const vEl = versionEls[vi]
        versionToSize.set(
          parseInt(vEl.getAttribute('number') || '0', 10),
          parseInt(vEl.getAttribute('size') || '0', 10),
        )
      }
    }

    const maxDefinedVersion = versionToSize.size > 0 ? Math.max(...versionToSize.keys()) : 36
    const fieldRecords: import('../types.js').FieldRecord[] = []
    const fieldsEl = childElements(structureElement, 'fields')[0]
    if (fieldsEl) {
      const fieldEls = childElements(fieldsEl, 'field')
      for (let fi = 0; fi < fieldEls.length; fi++) {
        const fieldElement = fieldEls[fi]
        const fieldName = fieldElement.getAttribute('name') || ''
        const typeAttr = fieldElement.getAttribute('type')
        const sizeAttr = fieldElement.getAttribute('size')
        const refTo = fieldElement.getAttribute('ref_to') || ''
        const sinceVersion = fieldElement.hasAttribute('since_version')
          ? parseInt(fieldElement.getAttribute('since_version')!, 10)
          : 0
        const tillVersion = fieldElement.hasAttribute('till_version')
          ? parseInt(fieldElement.getAttribute('till_version')!, 10)
          : maxDefinedVersion
        const defaultValueRaw = fieldElement.getAttribute('default_value')
        const expectedValueRaw = fieldElement.getAttribute('expected_value')
        const defaultValue = defaultValueRaw
          ? defaultValueRaw.startsWith('0x')
            ? parseInt(defaultValueRaw, 0)
            : parseFloat(defaultValueRaw)
          : 0
        const expectedValue = expectedValueRaw
          ? expectedValueRaw.startsWith('0x')
            ? parseInt(expectedValueRaw, 0)
            : parseFloat(expectedValueRaw)
          : null
        const bits: Record<string, number> = {}
        let hasBits = false
        const bitsEl = childElements(fieldElement, 'bits')[0]
        if (bitsEl) {
          const bitEls = childElements(bitsEl, 'bit')
          for (let bi = 0; bi < bitEls.length; bi++) {
            const bitEl = bitEls[bi]
            const mask = parseInt(bitEl.getAttribute('mask') || '0', 0)
            const bitName = bitEl.getAttribute('name') || ''
            if (bitName) {
              bits[bitName] = mask
              hasBits = true
            }
          }
        }

        let field: import('../types.js').M3Field
        if (!typeAttr) {
          const size = parseInt(sizeAttr || '0', 10)
          field = new M3FieldBytes(
            fieldName,
            size,
            parseHexString(defaultValueRaw) || new Uint8Array(size),
            parseHexString(expectedValueRaw),
          )
        } else if (
          (PRIMITIVE_TYPES.has(typeAttr) && typeAttr.includes('int')) ||
          typeAttr === 'float'
        ) {
          field = new M3FieldPrimitive(
            fieldName,
            typeAttr as import('../types.js').M3PrimitiveType,
            defaultValue,
            expectedValue,
          )
          if (hasBits) (field as M3FieldPrimitive).bitMaskMap = bits
        } else {
          let actualType = typeAttr
          let version = 0
          const vPos = typeAttr.lastIndexOf('V')
          if (
            vPos !== -1 &&
            vPos < typeAttr.length - 1 &&
            !Number.isNaN(Number(typeAttr.substring(vPos + 1)))
          ) {
            actualType = typeAttr.substring(0, vPos)
            version = parseInt(typeAttr.substring(vPos + 1), 10)
          }
          const referencedHistory = histories[actualType]
          if (!referencedHistory) {
            throw new Error(
              `Structure ${actualType} referenced by ${name}.${fieldName} is not defined yet`,
            )
          }
          const fieldDesc = referencedHistory.getVersion(version)
          field = new M3FieldStructure(fieldName, fieldDesc, refTo)
        }

        fieldRecords.push({ field, sinceVersion, tillVersion })
      }
    }

    histories[name] = new M3StructureHistory(name, versionToSize, fieldRecords)
  }

  setStructures(histories)
  cachedXmlText = xmlText
  cachedHistories = histories
  return histories
}
