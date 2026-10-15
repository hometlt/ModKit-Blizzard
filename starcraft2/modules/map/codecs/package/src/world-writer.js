import { decodeXmlEntities, encodeXmlAttribute } from '@modkit/codec-kit'
import { readTextureMasks, writeTextureMasks, setTextureMaskWindow } from '../../../shared/format/formats/texture-masks.js'
import {
  OBJECT_CATALOG_ATTRIBUTES,
  PRELOAD_TAG_LINKS,
} from '@modkit/blizzard-starcraft2/map/catalog-usages'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const MAP_DOCUMENT_BASENAMES = Object.freeze([
  'objects',
  'mapobjects',
  'regions',
  'mapregions',
  't3heightmap',
  'mapheightmap',
  't3syncpathinginfo',
  'mappathinginfo',
  't3syncclifflevel',
  'mapsyncclifflevel',
  't3texturemasks',
  'maptexturemasks',
  'preload',
])
/*
 * The grids a layer write (`grid.set`) edits: which documents hold it, their magic, the bytes per
 * cell and where the layer's uint16 sits in a cell (a height cell is base, adjustment, mask).
 */
const LAYER_GRIDS = new Map([
  ['height', { names: ['t3heightmap', 'mapheightmap'], label: 't3HeightMap', magic: 'HMAP', stride: 6, at: 0 }],
  ['cliff-level', { names: ['t3syncclifflevel', 'mapsyncclifflevel'], label: 't3SyncCliffLevel', magic: 'CLIF', stride: 2, at: 0 }],
  ['pathing', { names: ['t3syncpathinginfo', 'mappathinginfo'], label: 't3SyncPathingInfo', magic: 'PATH', stride: 2, at: 0 }],
])
const OBJECT_TAGS = new Map([
  ['objectunit', 'unit'],
  ['objectdoodad', 'doodad'],
  ['objectpoint', 'point'],
  ['objectcamera', 'camera'],
])
const OBJECT_TAG_FOR_KIND = new Map([...OBJECT_TAGS].map(([tag, kind]) => [kind, tag]))
// What Objects and Preload name from the catalog is the map format's own table, read case-blind.
const lowerKeys = table => new Map([...table].map(([tag, links]) => [tag.toLowerCase(), links]))
const OBJECT_LINKS = lowerKeys(OBJECT_CATALOG_ATTRIBUTES)
const PRELOAD_LINKS = lowerKeys(PRELOAD_TAG_LINKS)

const NAMED_REMAINDER = Object.freeze([
  'map bounds and resize because MapInfo is not in the proven semantic decoder',
  'terrain material palettes and texture matching, water, normalized cliffs and lighting',
  'creation or deletion of archive entries in native fixed-slot mode',
  'encrypted, implode, patch, sector-CRC and high-offset changed MPQ entries',
  'Blizzard signing and signature regeneration',
])

function requiredBasenamesForEdits(edits) {
  if (!Array.isArray(edits)) return MAP_DOCUMENT_BASENAMES
  const required = new Set()
  for (const candidate of edits) {
    const kind = candidate?.kind
    if (typeof kind !== 'string') continue
    if (kind.startsWith('object.')) required.add('objects').add('mapobjects')
    else if (kind.startsWith('region.')) required.add('regions').add('mapregions')
    else if (kind === 'terrain.cell.set') required.add('t3heightmap').add('mapheightmap')
    else if (kind === 'pathing.cell.set') required.add('t3syncpathinginfo').add('mappathinginfo')
    else if (kind === 'reference.rename') required.add('objects').add('mapobjects').add('preload')
    else if (kind === 'grid.set') {
      const names = /^texture-weight-\d+$/u.test(candidate.grid) ? ['t3texturemasks', 'maptexturemasks'] : LAYER_GRIDS.get(candidate.grid)?.names ?? []
      for (const name of names) required.add(name)
    }
  }
  return required.size === 0 ? MAP_DOCUMENT_BASENAMES : Object.freeze([...required])
}

function record(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value
}

function nonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return value
}

function positiveLimit(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${label} must be a positive safe integer no greater than ${maximum}`)
  }
  return value
}

function abort(signal) {
  if (signal?.aborted) throw new DOMException('operation cancelled', 'AbortError')
}

function portablePath(value, label) {
  const path = nonEmpty(value, label).replaceAll('\\', '/')
  if (
    path.startsWith('/') ||
    /^[A-Za-z]:/u.test(path) ||
    path.includes('\0') ||
    path.length > 1_024 ||
    path.split('/').some(part => part === '' || part === '.' || part === '..')
  ) {
    throw new TypeError(`${label} must be a portable relative path`)
  }
  return path
}

function basename(path) {
  return path.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? ''
}

/*
 * Escaping and unescaping come from the shared XML text layer. This writer and the scanner that
 * reads its output have to agree on the entity set, and two hand-written copies do not stay in
 * agreement — the local unescape knew the five named entities and not the numeric forms, so a
 * `&#34;` written by the game round-tripped as literal text. `String(value)` stays because callers
 * pass numbers.
 */
const xmlEscape = (value, quote = '"') =>
  encodeXmlAttribute(String(value), quote === "'" ? "'" : quote === 'both' ? 'both' : '"')

function tagEnd(text, start) {
  let quote
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== undefined) {
      if (char === quote) quote = undefined
    } else if (char === '"' || char === "'") quote = char
    else if (char === '>') return index + 1
  }
  throw new TypeError('XML tag is truncated')
}

function xmlTokens(text, maxNodes) {
  if (/<!DOCTYPE|<!ENTITY/iu.test(text)) {
    throw new TypeError('SC2 map XML forbids DTD and custom entities')
  }
  const tokens = []
  let cursor = 0
  while (cursor < text.length) {
    const start = text.indexOf('<', cursor)
    if (start < 0) break
    if (tokens.length >= maxNodes) throw new RangeError('SC2 map XML exceeds maxNodes')
    if (text.startsWith('<!--', start)) {
      const end = text.indexOf('-->', start + 4)
      if (end < 0) throw new TypeError('SC2 map XML comment is truncated')
      cursor = end + 3
      continue
    }
    if (text.startsWith('<![CDATA[', start)) {
      const end = text.indexOf(']]>', start + 9)
      if (end < 0) throw new TypeError('SC2 map XML CDATA is truncated')
      cursor = end + 3
      continue
    }
    if (text.startsWith('<?', start)) {
      const end = text.indexOf('?>', start + 2)
      if (end < 0) throw new TypeError('SC2 map XML processing instruction is truncated')
      cursor = end + 2
      continue
    }
    if (text.startsWith('<!', start)) {
      cursor = tagEnd(text, start)
      continue
    }
    const end = tagEnd(text, start)
    const raw = text.slice(start, end)
    const match = /^<\s*(\/?)\s*([A-Za-z_][\w.:-]*)/u.exec(raw)
    if (match === null) throw new TypeError('SC2 map XML tag name is invalid')
    tokens.push(
      Object.freeze({
        start,
        end,
        raw,
        close: match[1] === '/',
        name: match[2],
        selfClosing: /\/\s*>$/u.test(raw),
      }),
    )
    cursor = end
  }
  return tokens
}

/**
 * @typedef {{start: number, end: number, raw: string, close: boolean, name: string, selfClosing: boolean}} XmlToken
 * @typedef {{name: string, open: XmlToken, openEnd: number}} OpenXmlRoot
 * @typedef {OpenXmlRoot & {close: XmlToken, end: number}} CompleteXmlRoot
 * @typedef {{name: string, start: number, openEnd: number, end: number}} XmlChild
 */

/**
 * @param {string} text
 * @param {string} expectedRoot
 * @param {number} maxNodes
 * @returns {Readonly<{root: Readonly<CompleteXmlRoot>, children: readonly Readonly<XmlChild>[], tokens: readonly Readonly<XmlToken>[]} >}
 */
function parsedXml(text, expectedRoot, maxNodes) {
  const tokens = xmlTokens(text, maxNodes)
  const stack = []
  const children = []
  /** @type {Readonly<OpenXmlRoot> | Readonly<CompleteXmlRoot> | undefined} */
  let root
  for (const token of tokens) {
    if (token.close) {
      const opened = stack.pop()
      if (opened === undefined || opened.name.toLowerCase() !== token.name.toLowerCase()) {
        throw new TypeError(`SC2 map XML closing tag ${token.name} is unbalanced`)
      }
      if (stack.length === 0) {
        if (root === undefined || root.open !== opened)
          throw new TypeError('SC2 map XML root drift')
        root = Object.freeze({
          name: root.name,
          open: root.open,
          openEnd: root.openEnd,
          close: token,
          end: token.end,
        })
      } else if (stack.length === 1) {
        children.push(
          Object.freeze({
            name: opened.name,
            start: opened.start,
            openEnd: opened.end,
            end: token.end,
          }),
        )
      }
      continue
    }
    if (stack.length === 0) {
      if (root !== undefined) throw new TypeError('SC2 map XML has multiple roots')
      root = Object.freeze({ name: token.name, open: token, openEnd: token.end })
    } else if (stack.length === 1 && token.selfClosing) {
      children.push(
        Object.freeze({ name: token.name, start: token.start, openEnd: token.end, end: token.end }),
      )
    }
    if (!token.selfClosing) stack.push(token)
  }
  if (
    stack.length !== 0 ||
    root === undefined ||
    !('end' in root) ||
    root.name.toLowerCase() !== expectedRoot.toLowerCase()
  ) {
    throw new TypeError(`expected complete ${expectedRoot} XML root`)
  }
  const completeRoot = /** @type {Readonly<CompleteXmlRoot>} */ (root)
  return Object.freeze({
    root: completeRoot,
    children: Object.freeze(children),
    tokens: Object.freeze(tokens),
  })
}

function attribute(openTag, requestedName) {
  const expression = /\s+([A-Za-z_][\w.:-]*)\s*=\s*(["'])(.*?)\2/gsu
  let match
  while ((match = expression.exec(openTag)) !== null) {
    if (match[1].toLowerCase() !== requestedName.toLowerCase()) continue
    const valueStart = match.index + match[0].indexOf(match[3])
    return Object.freeze({
      name: match[1],
      quote: match[2],
      value: decodeXmlEntities(match[3]),
      valueStart,
      valueEnd: valueStart + match[3].length,
    })
  }
  return undefined
}

function setAttribute(openTag, name, value) {
  const found = attribute(openTag, name)
  if (found !== undefined) {
    return `${openTag.slice(0, found.valueStart)}${xmlEscape(value, found.quote === "'" ? "'" : '"')}${openTag.slice(found.valueEnd)}`
  }
  const insert = openTag.search(/\/?>\s*$/u)
  if (insert < 0) throw new TypeError('SC2 map XML open tag is invalid')
  return `${openTag.slice(0, insert)} ${name}="${xmlEscape(value)}"${openTag.slice(insert)}`
}

function replaceRanges(text, replacements) {
  const sorted = [...replacements].sort((left, right) => right.start - left.start)
  let result = text
  let previous = text.length
  for (const replacement of sorted) {
    if (
      !Number.isSafeInteger(replacement.start) ||
      !Number.isSafeInteger(replacement.end) ||
      replacement.start < 0 ||
      replacement.end < replacement.start ||
      replacement.end > previous
    ) {
      throw new TypeError('overlapping or invalid SC2 map XML replacement')
    }
    result = `${result.slice(0, replacement.start)}${replacement.text}${result.slice(replacement.end)}`
    previous = replacement.start
  }
  return result
}

function finite(value, label) {
  const result = Number(value)
  if (!Number.isFinite(result)) throw new TypeError(`${label} must be finite`)
  return Object.is(result, -0) ? 0 : result
}

function integer(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new TypeError(`${label} must be a safe integer in ${minimum}..${maximum}`)
  }
  return result
}

function scalarText(value, label) {
  return String(finite(value, label))
}

function vectorText(value, label, dimensions = 3) {
  const source = Array.isArray(value)
    ? value
    : value !== null && typeof value === 'object'
      ? [value.x, value.y, ...(dimensions === 3 ? [value.z ?? 0] : [])]
      : undefined
  if (!Array.isArray(source) || source.length !== dimensions) {
    throw new TypeError(`${label} must contain ${dimensions} coordinates`)
  }
  return source.map((item, index) => scalarText(item, `${label}[${index}]`)).join(',')
}

function objectBlocks(text, maxNodes) {
  const parsed = parsedXml(text, 'PlacedObjects', maxNodes)
  return Object.freeze({
    parsed,
    blocks: Object.freeze(
      parsed.children.filter(child => OBJECT_TAGS.has(child.name.toLowerCase())),
    ),
  })
}

function objectId(text, block) {
  const open = text.slice(block.start, block.openEnd)
  return integer(attribute(open, 'Id')?.value ?? 0, `${block.name}.Id`)
}

function uniqueObjectIds(text, blocks) {
  const ids = new Set()
  for (const block of blocks) {
    const id = objectId(text, block)
    if (ids.has(id)) throw new TypeError(`Objects contains duplicate object Id ${id}`)
    ids.add(id)
  }
  return ids
}

function objectAttributes(kind, object, label) {
  const value = record(object, label)
  const common = [
    ['Id', String(integer(value.objectId, `${label}.objectId`))],
    ['Position', vectorText(value.position, `${label}.position`)],
  ]
  if (kind === 'unit') {
    return [
      ...common,
      ['Variation', String(integer(value.variation ?? 0, `${label}.variation`))],
      ['Scale', vectorText(value.scale ?? [1, 1, 1], `${label}.scale`)],
      ['UnitType', nonEmpty(value.typeId, `${label}.typeId`)],
      ['Player', String(integer(value.player ?? 0, `${label}.player`))],
      ...(value.rotation === undefined
        ? []
        : [['Rotation', scalarText(value.rotation, `${label}.rotation`)]]),
    ]
  }
  if (kind === 'doodad') {
    return [
      ...common,
      ['Variation', String(integer(value.variation ?? 0, `${label}.variation`))],
      ['Scale', vectorText(value.scale ?? [1, 1, 1], `${label}.scale`)],
      ['Type', nonEmpty(value.typeId, `${label}.typeId`)],
      ...(value.rotation === undefined
        ? []
        : [['Rotation', scalarText(value.rotation, `${label}.rotation`)]]),
    ]
  }
  if (kind === 'point') {
    return [
      ...common,
      ['Scale', vectorText(value.scale ?? [1, 1, 1], `${label}.scale`)],
      ['Type', String(value.typeId ?? '')],
      ...(value.name === undefined ? [] : [['Name', String(value.name)]]),
      ...(value.rotation === undefined
        ? []
        : [['Rotation', scalarText(value.rotation, `${label}.rotation`)]]),
    ]
  }
  if (kind === 'camera') {
    return [
      ...common,
      ...(value.scale === undefined ? [] : [['Scale', vectorText(value.scale, `${label}.scale`)]]),
      ...(value.name === undefined ? [] : [['Name', String(value.name)]]),
      ...(value.rotation === undefined
        ? []
        : [['Rotation', scalarText(value.rotation, `${label}.rotation`)]]),
    ]
  }
  throw new TypeError(`unsupported SC2 object kind ${String(kind)}`)
}

function canonicalObject(object, label) {
  const kind = nonEmpty(object.kind, `${label}.kind`).toLowerCase()
  const tag = OBJECT_TAG_FOR_KIND.get(kind)
  if (tag === undefined) throw new TypeError(`unsupported SC2 object kind ${kind}`)
  const name = `Object${tag.slice('object'.length).replace(/^./u, char => char.toUpperCase())}`
  const attributes = objectAttributes(kind, object, label)
  return `<${name}${attributes.map(([key, value]) => ` ${key}="${xmlEscape(value)}"`).join('')}/>`
}

function patchedObjectOpen(open, kind, patch, label) {
  const allowed = new Set([
    'position',
    'scale',
    'rotation',
    'typeId',
    'player',
    'variation',
    'name',
  ])
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) throw new TypeError(`${label} has unsupported field ${key}`)
  }
  let result = open
  if (patch.position !== undefined)
    result = setAttribute(result, 'Position', vectorText(patch.position, `${label}.position`))
  if (patch.scale !== undefined)
    result = setAttribute(result, 'Scale', vectorText(patch.scale, `${label}.scale`))
  if (patch.rotation !== undefined)
    result = setAttribute(result, 'Rotation', scalarText(patch.rotation, `${label}.rotation`))
  if (patch.typeId !== undefined) {
    result = setAttribute(
      result,
      kind === 'unit' ? 'UnitType' : 'Type',
      nonEmpty(patch.typeId, `${label}.typeId`),
    )
  }
  if (patch.player !== undefined)
    result = setAttribute(result, 'Player', String(integer(patch.player, `${label}.player`)))
  if (patch.variation !== undefined)
    result = setAttribute(
      result,
      'Variation',
      String(integer(patch.variation, `${label}.variation`)),
    )
  if (patch.name !== undefined) result = setAttribute(result, 'Name', String(patch.name))
  return result
}

function editObjects(text, edit, maxNodes) {
  const scanned = objectBlocks(text, maxNodes)
  const ids = uniqueObjectIds(text, scanned.blocks)
  if (edit.kind === 'object.add') {
    const object = record(edit.object, 'object.add.object')
    const id = integer(object.objectId, 'object.add.object.objectId')
    if (ids.has(id)) throw new TypeError(`object.add collides with object Id ${id}`)
    const newline = text.includes('\r\n') ? '\r\n' : '\n'
    const indent =
      scanned.blocks[0] === undefined
        ? '    '
        : (text.slice(scanned.blocks[0].start).match(/^[ \t]*/u)?.[0] ?? '    ')
    const inserted = `${indent}${canonicalObject(object, 'object.add.object')}${newline}`
    return replaceRanges(text, [
      {
        start: scanned.parsed.root.close.start,
        end: scanned.parsed.root.close.start,
        text: inserted,
      },
    ])
  }
  const id = integer(edit.objectId, `${edit.kind}.objectId`)
  const block = scanned.blocks.find(candidate => objectId(text, candidate) === id)
  if (block === undefined) throw new TypeError(`${edit.kind} cannot find object Id ${id}`)
  if (edit.kind === 'object.remove') {
    return replaceRanges(text, [{ start: block.start, end: block.end, text: '' }])
  }
  if (edit.kind !== 'object.update') throw new TypeError(`unsupported object edit ${edit.kind}`)
  const patch = record(edit.patch, 'object.update.patch')
  const kind = OBJECT_TAGS.get(block.name.toLowerCase())
  const open = text.slice(block.start, block.openEnd)
  const nextOpen = patchedObjectOpen(open, kind, patch, 'object.update.patch')
  return replaceRanges(text, [{ start: block.start, end: block.openEnd, text: nextOpen }])
}

function canonicalShape(shape, label) {
  const value = record(shape, label)
  const type = nonEmpty(value.type, `${label}.type`)
  const parameters = record(value.parameters ?? {}, `${label}.parameters`)
  const body = Object.entries(parameters)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `<${key} value="${xmlEscape(String(item))}"/>`)
    .join('')
  return `<shape type="${xmlEscape(type)}">${body}</shape>`
}

function canonicalRegion(region, label) {
  const value = record(region, label)
  const id = integer(value.regionId, `${label}.regionId`)
  if (!Array.isArray(value.shapes)) throw new TypeError(`${label}.shapes must be an array`)
  const fields = [
    `<name value="${xmlEscape(String(value.name ?? ''))}"/>`,
    ...(value.color === undefined ? [] : [`<color value="${xmlEscape(String(value.color))}"/>`]),
    ...value.shapes.map((shape, index) => canonicalShape(shape, `${label}.shapes[${index}]`)),
  ]
  return `<region id="${id}">${fields.join('')}</region>`
}

function regionId(text, block) {
  return integer(attribute(text.slice(block.start, block.openEnd), 'id')?.value ?? 0, 'region.id')
}

function setRegionValue(blockText, name, value, maxNodes) {
  const parsed = parsedXml(blockText, 'region', maxNodes)
  const child = parsed.children.find(item => item.name.toLowerCase() === name.toLowerCase())
  if (child !== undefined) {
    const open = blockText.slice(child.start, child.openEnd)
    return replaceRanges(blockText, [
      { start: child.start, end: child.openEnd, text: setAttribute(open, 'value', value) },
    ])
  }
  return replaceRanges(blockText, [
    {
      start: parsed.root.openEnd,
      end: parsed.root.openEnd,
      text: `<${name} value="${xmlEscape(value)}"/>`,
    },
  ])
}

function replaceRegionShapes(blockText, shapes, maxNodes) {
  if (!Array.isArray(shapes)) throw new TypeError('region.update.patch.shapes must be an array')
  const parsed = parsedXml(blockText, 'region', maxNodes)
  const shapeBlocks = parsed.children.filter(item => item.name.toLowerCase() === 'shape')
  const replacement = shapes
    .map((shape, index) => canonicalShape(shape, `region.update.patch.shapes[${index}]`))
    .join('')
  if (shapeBlocks.length === 0) {
    return replaceRanges(blockText, [
      { start: parsed.root.close.start, end: parsed.root.close.start, text: replacement },
    ])
  }
  return replaceRanges(
    blockText,
    shapeBlocks.map((shape, index) => ({
      start: shape.start,
      end: shape.end,
      text: index === 0 ? replacement : '',
    })),
  )
}

function editRegions(text, edit, maxNodes, losses) {
  const parsed = parsedXml(text, 'Regions', maxNodes)
  const blocks = parsed.children.filter(item => item.name.toLowerCase() === 'region')
  const ids = new Set()
  for (const block of blocks) {
    const id = regionId(text, block)
    if (ids.has(id)) throw new TypeError(`Regions contains duplicate region id ${id}`)
    ids.add(id)
  }
  if (edit.kind === 'region.add') {
    const region = record(edit.region, 'region.add.region')
    const id = integer(region.regionId, 'region.add.region.regionId')
    if (ids.has(id)) throw new TypeError(`region.add collides with region id ${id}`)
    const newline = text.includes('\r\n') ? '\r\n' : '\n'
    const inserted = `    ${canonicalRegion(region, 'region.add.region')}${newline}`
    return replaceRanges(text, [
      { start: parsed.root.close.start, end: parsed.root.close.start, text: inserted },
    ])
  }
  const id = integer(edit.regionId, `${edit.kind}.regionId`)
  const block = blocks.find(candidate => regionId(text, candidate) === id)
  if (block === undefined) throw new TypeError(`${edit.kind} cannot find region id ${id}`)
  if (edit.kind === 'region.remove') {
    return replaceRanges(text, [{ start: block.start, end: block.end, text: '' }])
  }
  if (edit.kind !== 'region.update') throw new TypeError(`unsupported region edit ${edit.kind}`)
  const patch = record(edit.patch, 'region.update.patch')
  const allowed = new Set(['name', 'color', 'shapes'])
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) throw new TypeError(`region.update.patch has unsupported field ${key}`)
  }
  let blockText = text.slice(block.start, block.end)
  if (patch.name !== undefined)
    blockText = setRegionValue(blockText, 'name', String(patch.name), maxNodes)
  if (patch.color !== undefined)
    blockText = setRegionValue(blockText, 'color', String(patch.color), maxNodes)
  if (patch.shapes !== undefined) {
    blockText = replaceRegionShapes(blockText, patch.shapes, maxNodes)
    losses.push('edited region shape nodes are deterministically normalized')
  }
  return replaceRanges(text, [{ start: block.start, end: block.end, text: blockText }])
}

function editGrid(bytes, edit, label, magic, maxCells) {
  if (bytes.byteLength < 32 || decoder.decode(bytes.subarray(0, 4)) !== magic) {
    throw new TypeError(`${label} header is missing or truncated`)
  }
  const output = bytes.slice()
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength)
  const width = view.getUint32(8, true)
  const height = view.getUint32(12, true)
  const cells = width * height
  if (!Number.isSafeInteger(cells) || cells <= 0 || cells > maxCells) {
    throw new RangeError(`${label} cells exceeds maxTerrainCells`)
  }
  const stride = magic === 'HMAP' ? 6 : 2
  if (32 + cells * stride > output.byteLength)
    throw new TypeError(`${label} cell array is truncated`)
  const x = integer(edit.x, `${edit.kind}.x`, 0, width - 1)
  const y = integer(edit.y, `${edit.kind}.y`, 0, height - 1)
  const offset = 32 + (y * width + x) * stride
  if (magic === 'HMAP') {
    const allowed = new Set(['kind', 'x', 'y', 'heightBase', 'heightAdjustment', 'mask'])
    for (const key of Object.keys(edit)) {
      if (!allowed.has(key)) throw new TypeError(`${edit.kind} has unsupported field ${key}`)
    }
    if (edit.heightBase !== undefined)
      view.setUint16(offset, integer(edit.heightBase, `${edit.kind}.heightBase`, 0, 0xffff), true)
    if (edit.heightAdjustment !== undefined)
      view.setUint16(
        offset + 2,
        integer(edit.heightAdjustment, `${edit.kind}.heightAdjustment`, 0, 0xffff),
        true,
      )
    if (edit.mask !== undefined)
      view.setUint16(offset + 4, integer(edit.mask, `${edit.kind}.mask`, 0, 0xffff), true)
  } else {
    view.setUint16(offset, integer(edit.flags, `${edit.kind}.flags`, 0, 0xffff), true)
  }
  return output
}

/**
 * A layer window in one pass: `values` row-major with row 0 at the map's north edge (image order),
 * placed by `x` (from the west) and `y` (from the north), both or neither; without them the window
 * is the whole layer. The documents store row 0 at the south, so rows flip here. Cells outside the
 * window keep their bytes.
 */
function setGridWindow(bytes, edit, grid, maxCells) {
  if (bytes.byteLength < 32 || decoder.decode(bytes.subarray(0, 4)) !== grid.magic) {
    throw new TypeError(`${grid.label} header is missing or truncated`)
  }
  const output = bytes.slice()
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength)
  const width = view.getUint32(8, true)
  const height = view.getUint32(12, true)
  if (width * height > maxCells) throw new RangeError(`${grid.label} cells exceeds maxTerrainCells`)
  if ((edit.x === undefined) !== (edit.y === undefined)) throw new RangeError(`grid.set ${edit.grid}: x and y go together`)
  const left = edit.x === undefined ? 0 : integer(edit.x, `grid.set ${edit.grid}.x`, 0, width - 1)
  const top = edit.y === undefined ? 0 : integer(edit.y, `grid.set ${edit.grid}.y`, 0, height - 1)
  const columns = integer(edit.width, `grid.set ${edit.grid}.width`, 1, width - left)
  const rows = integer(edit.height, `grid.set ${edit.grid}.height`, 1, height - top)
  if (edit.x === undefined && (columns !== width || rows !== height)) {
    throw new RangeError(`grid.set ${edit.grid} is ${columns}x${rows}; ${grid.label} is ${width}x${height}`)
  }
  if (!Array.isArray(edit.values) || edit.values.length !== columns * rows) {
    throw new TypeError(`grid.set ${edit.grid} needs ${columns * rows} values`)
  }
  if (32 + width * height * grid.stride > output.byteLength) {
    throw new TypeError(`${grid.label} cell array is truncated`)
  }
  for (let row = 0; row < rows; row += 1) {
    const y = height - 1 - (top + row)
    for (let column = 0; column < columns; column += 1) {
      const x = left + column
      const value = integer(edit.values[row * columns + column], `grid.set ${edit.grid}[${x},${top + row}]`, 0, 0xffff)
      view.setUint16(32 + (y * width + x) * grid.stride + grid.at, value, true)
    }
  }
  return output
}

function renameReferences(text, expectedRoot, edit, maxNodes) {
  const namespace = nonEmpty(edit.namespace, 'reference.rename.namespace')
  const from = nonEmpty(edit.from, 'reference.rename.from')
  const to = nonEmpty(edit.to, 'reference.rename.to')
  if (from === to) throw new TypeError('reference.rename from and to must differ')
  const parsed = parsedXml(text, expectedRoot, maxNodes)
  const replacements = []
  let patched = 0
  for (const token of parsed.tokens) {
    if (token.close) continue
    const lower = token.name.toLowerCase()
    const targets = []
    if (expectedRoot === 'PlacedObjects') {
      for (const link of OBJECT_LINKS.get(lower) ?? []) targets.push([link.namespace, link.attribute])
    } else {
      const link = PRELOAD_LINKS.get(lower)
      if (link !== undefined) targets.push([link.namespace, link.attr])
    }
    let open = token.raw
    let changed = false
    for (const [candidateNamespace, attributeName] of targets) {
      const value = attribute(open, attributeName)
      if (candidateNamespace === namespace && value?.value === from) {
        open = setAttribute(open, attributeName, to)
        changed = true
        patched += 1
      }
    }
    if (changed) replacements.push({ start: token.start, end: token.end, text: open })
  }
  return Object.freeze({ text: replaceRanges(text, replacements), patched })
}

async function digest(bytes, signal) {
  abort(signal)
  if (globalThis.crypto?.subtle === undefined) throw new TypeError('SHA-256 is unavailable')
  const value = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))
  abort(signal)
  return `sha256:${[...value].map(item => item.toString(16).padStart(2, '0')).join('')}`
}

function documentMap(documents, limits) {
  if (
    !Array.isArray(documents) ||
    documents.length === 0 ||
    documents.length > limits.maxDocuments
  ) {
    throw new TypeError(`documents must contain 1..${limits.maxDocuments} entries`)
  }
  const result = new Map()
  let total = 0
  for (let index = 0; index < documents.length; index += 1) {
    const item = record(documents[index], `documents[${index}]`)
    const path = portablePath(item.path, `documents[${index}].path`)
    if (!(item.bytes instanceof Uint8Array)) throw new TypeError(`${path} has no byte payload`)
    if (item.bytes.byteLength > limits.maxDocumentBytes) {
      throw new RangeError(`${path} exceeds maxDocumentBytes`)
    }
    const key = path.toLowerCase()
    if (result.has(key)) throw new TypeError(`duplicate map document path ${path}`)
    total += item.bytes.byteLength
    if (total > limits.maxTotalBytes) throw new RangeError('map documents exceed maxTotalBytes')
    result.set(key, Object.freeze({ path, bytes: item.bytes.slice() }))
  }
  return result
}

function optionalDocumentFor(documents, candidates, label) {
  const matches = [...documents.values()].filter(document =>
    candidates.includes(basename(document.path)),
  )
  if (matches.length > 1) {
    throw new TypeError(
      `${label} map document is ambiguous: ${matches.map(item => item.path).join(', ')}`,
    )
  }
  return matches[0]
}

function documentFor(documents, candidates, label) {
  const document = optionalDocumentFor(documents, candidates, label)
  if (document !== undefined) return document
  throw new TypeError(`${label} map document is unavailable`)
}

/** Apply bounded semantic map edits and return only changed, reopenable native documents. */
export async function applyStarcraft2MapWorldEdits(options) {
  const value = record(options, 'SC2 map edit request')
  abort(value.signal)
  const sourceRevision = nonEmpty(value.sourceRevision, 'sourceRevision')
  const expectedSourceRevision = nonEmpty(value.expectedSourceRevision, 'expectedSourceRevision')
  if (sourceRevision !== expectedSourceRevision) {
    throw new TypeError(
      `stale SC2 map revision: expected ${expectedSourceRevision}, received ${sourceRevision}`,
    )
  }
  const limits = Object.freeze({
    maxDocuments: positiveLimit(value.maxDocuments ?? 32, 'maxDocuments', 1_024),
    maxDocumentBytes: positiveLimit(
      value.maxDocumentBytes ?? 16_777_216,
      'maxDocumentBytes',
      1_073_741_824,
    ),
    maxTotalBytes: positiveLimit(value.maxTotalBytes ?? 67_108_864, 'maxTotalBytes', 1_073_741_824),
    maxEdits: positiveLimit(value.maxEdits ?? 10_000, 'maxEdits', 100_000),
    maxNodes: positiveLimit(value.maxNodes ?? 200_000, 'maxNodes', 2_000_000),
    maxTerrainCells: positiveLimit(
      value.maxTerrainCells ?? 4_194_304,
      'maxTerrainCells',
      16_777_216,
    ),
  })
  if (
    !Array.isArray(value.edits) ||
    value.edits.length === 0 ||
    value.edits.length > limits.maxEdits
  ) {
    throw new TypeError(`edits must contain 1..${limits.maxEdits} semantic operations`)
  }
  const documents = documentMap(value.documents, limits)
  const original = new Map([...documents].map(([key, item]) => [key, item.bytes]))
  const losses = []
  let referencePatches = 0
  for (let index = 0; index < value.edits.length; index += 1) {
    abort(value.signal)
    const edit = record(value.edits[index], `edits[${index}]`)
    const kind = nonEmpty(edit.kind, `edits[${index}].kind`)
    if (kind.startsWith('object.')) {
      const document = documentFor(documents, ['objects', 'mapobjects'], 'Objects')
      const text = decoder.decode(document.bytes)
      documents.set(
        document.path.toLowerCase(),
        Object.freeze({
          path: document.path,
          bytes: encoder.encode(editObjects(text, edit, limits.maxNodes)),
        }),
      )
    } else if (kind.startsWith('region.')) {
      const document = documentFor(documents, ['regions', 'mapregions'], 'Regions')
      const text = decoder.decode(document.bytes)
      documents.set(
        document.path.toLowerCase(),
        Object.freeze({
          path: document.path,
          bytes: encoder.encode(editRegions(text, edit, limits.maxNodes, losses)),
        }),
      )
    } else if (kind === 'terrain.cell.set') {
      const document = documentFor(documents, ['t3heightmap', 'mapheightmap'], 't3HeightMap')
      documents.set(
        document.path.toLowerCase(),
        Object.freeze({
          path: document.path,
          bytes: editGrid(document.bytes, edit, document.path, 'HMAP', limits.maxTerrainCells),
        }),
      )
    } else if (kind === 'pathing.cell.set') {
      const document = documentFor(
        documents,
        ['t3syncpathinginfo', 'mappathinginfo'],
        't3SyncPathingInfo',
      )
      documents.set(
        document.path.toLowerCase(),
        Object.freeze({
          path: document.path,
          bytes: editGrid(document.bytes, edit, document.path, 'PATH', limits.maxTerrainCells),
        }),
      )
    } else if (kind === 'grid.set') {
      if (/^texture-weight-\d+$/u.test(edit.grid)) {
        const document = documentFor(documents, ['t3texturemasks', 'maptexturemasks'], 't3TextureMasks')
        const masks = readTextureMasks(document.bytes), layer = Number(edit.grid.slice('texture-weight-'.length))
        if ((edit.x === undefined) !== (edit.y === undefined)) throw new RangeError('Texture mask x and y go together')
        if (edit.x === undefined && (edit.width !== masks.sizeX || edit.height !== masks.sizeY))
          throw new RangeError('Whole texture mask write requires complete dimensions')
        const next = setTextureMaskWindow(masks, layer, { x: edit.x ?? 0, y: edit.y ?? 0,
          width: edit.width, height: edit.height, values: edit.values }, { maxSamples: limits.maxTerrainCells, signal: value.signal })
        documents.set(document.path.toLowerCase(), Object.freeze({ path: document.path, bytes: writeTextureMasks(next) }))
        continue
      }
      const grid = LAYER_GRIDS.get(edit.grid)
      if (grid === undefined) throw new TypeError(`grid.set cannot write ${String(edit.grid)}`)
      const document = documentFor(documents, grid.names, grid.label)
      documents.set(
        document.path.toLowerCase(),
        Object.freeze({
          path: document.path,
          bytes: setGridWindow(document.bytes, edit, grid, limits.maxTerrainCells),
        }),
      )
    } else if (kind === 'reference.rename') {
      let found = false
      for (const [candidates, root] of [
        [['objects', 'mapobjects'], 'PlacedObjects'],
        [['preload'], 'Preload'],
      ]) {
        const document = optionalDocumentFor(documents, candidates, root)
        if (document === undefined) continue
        const renamed = renameReferences(
          decoder.decode(document.bytes),
          root,
          edit,
          limits.maxNodes,
        )
        referencePatches += renamed.patched
        if (renamed.patched > 0) found = true
        documents.set(
          document.path.toLowerCase(),
          Object.freeze({ path: document.path, bytes: encoder.encode(renamed.text) }),
        )
      }
      if (!found) losses.push(`reference.rename ${edit.namespace}/${edit.from} was a no-op`)
    } else {
      throw new TypeError(`unsupported SC2 map semantic edit ${kind}`)
    }
    value.onProgress?.({ completed: index + 1, total: value.edits.length, kind })
  }
  abort(value.signal)
  const replacements = []
  for (const [key, document] of documents) {
    const before = original.get(key)
    if (
      before !== undefined &&
      before.byteLength === document.bytes.byteLength &&
      before.every((item, index) => item === document.bytes[index])
    ) {
      continue
    }
    replacements.push(
      Object.freeze({
        path: document.path,
        bytes: document.bytes,
        sourceDigest: await digest(before ?? new Uint8Array(), value.signal),
        outputDigest: await digest(document.bytes, value.signal),
      }),
    )
  }
  replacements.sort((left, right) => left.path.localeCompare(right.path))
  return Object.freeze({
    schemaVersion: 1,
    kind: 'sc2-map-semantic-edit-receipt-v1',
    sourceRevision,
    editsApplied: value.edits.length,
    referencePatches,
    replacements: Object.freeze(replacements),
    fidelity: Object.freeze({
      roundTrip: 'semantic',
      preservesUnknownData: losses.every(item => !item.includes('normalized')),
      losses: Object.freeze([...new Set(losses)]),
      notes: Object.freeze([
        'untouched XML bytes and unknown attributes/children remain byte-identical',
        'HMAP and PATH headers, untouched cells, padding and trailing bytes remain byte-identical',
      ]),
    }),
    provenance: Object.freeze({
      implementation: 'modkit-blizzard/starcraft2/modules/map/codecs/package/src/world-writer.js',
      legacyReferenceRevision: '1a14ba4eddd0ae88de273348ebd44cfb98a0581d',
      nativeFormatReference: 'StarCraft II installed map corpus and legacy typed decoders',
    }),
    namedRemainder: NAMED_REMAINDER,
  })
}

export const starcraft2MapWorldNamedRemainder = NAMED_REMAINDER
