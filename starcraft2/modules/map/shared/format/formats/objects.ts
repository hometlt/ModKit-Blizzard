/**
 * Parser and writer for the `Objects` file (also `mapObjects`) embedded in
 * `.SC2Map` archives. Format: XML root `<PlacedObjects Version="N">`.
 *
 * Contains every placed unit, doodad, point, and camera on the map. Fields
 * critical for rename and relation operations:
 *  - `PlacedUnit.unitType`       → links to `CUnit` catalog entries
 *  - `PlacedPoint.sound`         → links to `SSound` catalog entries
 *  - `PlacedPoint.model`         → links to `CModel` catalog entries
 *  - `PlacedPoint.soundActor`    → links to `CActor` catalog entries
 *
 * Browser-safe: pure regex / string scanning, zero external dependencies.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ObjectTexture {
  texSlot: string
  texProps: string
  texLink: string
  /** Any additional attributes not captured above. */
  extra: Record<string, string>
}

export interface ObjectFlag {
  index: string
  value: string
}

export interface ObjectCameraValue {
  index: string
  value: string
}

/** A placed unit on the map. */
export interface PlacedUnit {
  id: number
  variation: number
  position: string
  scale: string
  /** Links to a `CUnit` catalog entry — rename target. */
  unitType: string
  player: number
  rotation?: string
  textures: ObjectTexture[]
  /** Attributes on the element not covered by the typed fields above. */
  extra: Record<string, string>
}

/** A placed decorative doodad. */
export interface PlacedDoodad {
  id: number
  variation: number
  position: string
  scale: string
  type: string
  rotation?: string
  flags: ObjectFlag[]
  extra: Record<string, string>
}

/** A named point (start location, trigger anchor, sound emitter, …). */
export interface PlacedPoint {
  id: number
  position: string
  scale: string
  type: string
  name?: string
  color?: string
  rotation?: string
  /** Links to a `SSound` catalog entry — rename target. */
  sound?: string
  /** Links to a `CModel` catalog entry — rename target. */
  model?: string
  /** Links to a `CActor` catalog entry — rename target. */
  soundActor?: string
  extra: Record<string, string>
}

/** A camera position + settings block. */
export interface PlacedCamera {
  id: number
  position: string
  name?: string
  color?: string
  rotation?: string
  scale?: string
  cameraTarget?: string
  cameraValues: ObjectCameraValue[]
  extra: Record<string, string>
}

export interface PlacedObjectsResult {
  version: number
  units: PlacedUnit[]
  doodads: PlacedDoodad[]
  points: PlacedPoint[]
  cameras: PlacedCamera[]
  /** O(1) lookup by integer id across all four types. */
  byId: Map<number, PlacedUnit | PlacedDoodad | PlacedPoint | PlacedCamera>
}

/**
 * Which attribute of which placed-object element names which catalog namespace: the one table for
 * a map's Objects — references and rename in the link index, the world writer's reference rename,
 * relations (MK2 `renameSc2MapObjectReferences`: unit type, a unit's texture links, a point's
 * sound, model and sound actor).
 */
export const OBJECT_CATALOG_ATTRIBUTES: ReadonlyMap<
  string,
  readonly { readonly attribute: string; readonly namespace: string }[]
> = new Map([
  ['ObjectUnit', [{ attribute: 'UnitType', namespace: 'Unit' }]],
  ['Texture', [{ attribute: 'TexLink', namespace: 'Texture' }]],
  [
    'ObjectPoint',
    [
      { attribute: 'Sound', namespace: 'Sound' },
      { attribute: 'Model', namespace: 'Model' },
      { attribute: 'SoundActor', namespace: 'Actor' },
    ],
  ],
])

/** A single entity-link entry for rename / relation graph construction. */
export interface ObjectEntityLink {
  /** Element type: 'unit' | 'doodad' | 'point' | 'camera' */
  elementType: string
  /** Element id. */
  id: number
  /** Attribute name: 'unitType' | 'texLink' | 'sound' | 'model' | 'soundActor' */
  field: string
  /** Catalog link name (e.g. 'Civilian', 'MainTheme'). */
  value: string
  /** The catalog namespace the value names, from {@link OBJECT_CATALOG_ATTRIBUTES}. */
  namespace: string
}

const catalogNamespace = (element: string, attribute: string): string =>
  OBJECT_CATALOG_ATTRIBUTES.get(element)!.find(link => link.attribute === attribute)!.namespace

// ---------------------------------------------------------------------------
// XML helpers (browser-safe)
// ---------------------------------------------------------------------------

function xmlUnescape(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Extract all key="value" pairs from a tag's attribute string. */
function parseAttrs(attrStr: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /\b(\w+)="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(attrStr)) !== null) {
    out[m[1]!] = xmlUnescape(m[2]!)
  }
  return out
}

/** Render a key="value" attribute string from a record. */
function attrsStr(attrs: Record<string, string>): string {
  return Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${xmlEscape(v)}"`)
    .join('')
}

interface ScannedBlock {
  attrs: Record<string, string>
  /** null if the element was self-closing. */
  body: string | null
}

/**
 * Iterate over all occurrences of `<tagName …>…</tagName>` or `<tagName …/>`
 * inside `xml`. Does NOT handle deeply nested same-name elements.
 */
function* scanBlocks(xml: string, tagName: string): Generator<ScannedBlock> {
  // Non-greedy [^>]*? so that the '/' in '/>' is captured by the (/?) group
  // rather than being consumed by the attribute character class.
  const openPat = new RegExp(`<${tagName}((?:\\s[^>]*?)?)(/?)>`, 'g')
  let m: RegExpExecArray | null
  while ((m = openPat.exec(xml)) !== null) {
    const attrStr = m[1] ?? ''
    const attrs = parseAttrs(attrStr)
    if (m[2] === '/') {
      // self-closing
      yield { attrs, body: null }
    } else {
      const closeTag = `</${tagName}>`
      const bodyStart = m.index + m[0].length
      const bodyEnd = xml.indexOf(closeTag, bodyStart)
      if (bodyEnd === -1) continue
      yield { attrs, body: xml.slice(bodyStart, bodyEnd) }
      openPat.lastIndex = bodyEnd + closeTag.length
    }
  }
}

/** Parse all self-closing child elements of `tagName` inside `body`. */
function parseChildElements(body: string, tagName: string): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = []
  for (const block of scanBlocks(body, tagName)) {
    out.push(block.attrs)
  }
  return out
}

// ---------------------------------------------------------------------------
// Element-level parsers
// ---------------------------------------------------------------------------

const UNIT_OWN = new Set(['Id', 'Variation', 'Position', 'Scale', 'UnitType', 'Player', 'Rotation'])
const DOODAD_OWN = new Set(['Id', 'Variation', 'Position', 'Scale', 'Type', 'Rotation'])
const POINT_OWN = new Set(['Id', 'Position', 'Scale', 'Type', 'Name', 'Color', 'Rotation', 'Sound', 'Model', 'SoundActor'])
const CAMERA_OWN = new Set(['Id', 'Position', 'Scale', 'Name', 'Color', 'Rotation', 'CameraTarget'])

function extra(attrs: Record<string, string>, own: Set<string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(attrs)) {
    if (!own.has(k)) out[k] = v
  }
  return out
}

function parseUnit(block: ScannedBlock): PlacedUnit {
  const a = block.attrs
  const body = block.body ?? ''
  const rawTextures = parseChildElements(body, 'Texture')
  const textures: ObjectTexture[] = rawTextures.map((t) => ({
    texSlot: t['TexSlot'] ?? '',
    texProps: t['TexProps'] ?? '',
    texLink: t['TexLink'] ?? '',
    extra: extra(t, new Set(['TexSlot', 'TexProps', 'TexLink'])),
  }))
  const u: PlacedUnit = {
    id: Number(a['Id'] ?? 0),
    variation: Number(a['Variation'] ?? 0),
    position: a['Position'] ?? '0,0,0',
    scale: a['Scale'] ?? '1,1,1',
    unitType: a['UnitType'] ?? '',
    player: Number(a['Player'] ?? 0),
    textures,
    extra: extra(a, UNIT_OWN),
  }
  if (a['Rotation'] !== undefined) u.rotation = a['Rotation']
  return u
}

function parseDoodad(block: ScannedBlock): PlacedDoodad {
  const a = block.attrs
  const body = block.body ?? ''
  const rawFlags = parseChildElements(body, 'Flag')
  const flags: ObjectFlag[] = rawFlags.map((f) => ({
    index: f['Index'] ?? '',
    value: f['Value'] ?? '',
  }))
  const d: PlacedDoodad = {
    id: Number(a['Id'] ?? 0),
    variation: Number(a['Variation'] ?? 0),
    position: a['Position'] ?? '0,0,0',
    scale: a['Scale'] ?? '1,1,1',
    type: a['Type'] ?? '',
    flags,
    extra: extra(a, DOODAD_OWN),
  }
  if (a['Rotation'] !== undefined) d.rotation = a['Rotation']
  return d
}

function parsePoint(block: ScannedBlock): PlacedPoint {
  const a = block.attrs
  const p: PlacedPoint = {
    id: Number(a['Id'] ?? 0),
    position: a['Position'] ?? '0,0,0',
    scale: a['Scale'] ?? '1,1,1',
    type: a['Type'] ?? '',
    extra: extra(a, POINT_OWN),
  }
  if (a['Name'] !== undefined) p.name = a['Name']
  if (a['Color'] !== undefined) p.color = a['Color']
  if (a['Rotation'] !== undefined) p.rotation = a['Rotation']
  if (a['Sound'] !== undefined) p.sound = a['Sound']
  if (a['Model'] !== undefined) p.model = a['Model']
  if (a['SoundActor'] !== undefined) p.soundActor = a['SoundActor']
  return p
}

function parseCamera(block: ScannedBlock): PlacedCamera {
  const a = block.attrs
  const body = block.body ?? ''
  const rawValues = parseChildElements(body, 'CameraValue')
  const cameraValues: ObjectCameraValue[] = rawValues.map((v) => ({
    index: v['Index'] ?? '',
    value: v['Value'] ?? '',
  }))
  const c: PlacedCamera = {
    id: Number(a['Id'] ?? 0),
    position: a['Position'] ?? '0,0,0',
    cameraValues,
    extra: extra(a, CAMERA_OWN),
  }
  if (a['Name'] !== undefined) c.name = a['Name']
  if (a['Color'] !== undefined) c.color = a['Color']
  if (a['Rotation'] !== undefined) c.rotation = a['Rotation']
  if (a['Scale'] !== undefined) c.scale = a['Scale']
  if (a['CameraTarget'] !== undefined) c.cameraTarget = a['CameraTarget']
  return c
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Parse a `<PlacedObjects>` XML string. */
export function readObjects(xml: string): PlacedObjectsResult {
  // Extract root version attribute
  const verMatch = /<PlacedObjects\b[^>]*\bVersion="(\d+)"/.exec(xml)
  const version = verMatch ? Number(verMatch[1]) : 0

  const units: PlacedUnit[] = []
  const doodads: PlacedDoodad[] = []
  const points: PlacedPoint[] = []
  const cameras: PlacedCamera[] = []
  const byId = new Map<number, PlacedUnit | PlacedDoodad | PlacedPoint | PlacedCamera>()

  for (const block of scanBlocks(xml, 'ObjectUnit')) {
    const u = parseUnit(block)
    units.push(u)
    byId.set(u.id, u)
  }
  for (const block of scanBlocks(xml, 'ObjectDoodad')) {
    const d = parseDoodad(block)
    doodads.push(d)
    byId.set(d.id, d)
  }
  for (const block of scanBlocks(xml, 'ObjectPoint')) {
    const p = parsePoint(block)
    points.push(p)
    byId.set(p.id, p)
  }
  for (const block of scanBlocks(xml, 'ObjectCamera')) {
    const c = parseCamera(block)
    cameras.push(c)
    byId.set(c.id, c)
  }

  return { version, units, doodads, points, cameras, byId }
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

function writeUnit(u: PlacedUnit): string {
  let tag = `<ObjectUnit Id="${u.id}" Variation="${u.variation}" Position="${xmlEscape(u.position)}" Scale="${xmlEscape(u.scale)}" UnitType="${xmlEscape(u.unitType)}" Player="${u.player}"`
  if (u.rotation !== undefined) tag += ` Rotation="${xmlEscape(u.rotation)}"`
  tag += attrsStr(u.extra)
  if (u.textures.length === 0) {
    return `    ${tag}/>\n`
  }
  let out = `    ${tag}>\n`
  for (const t of u.textures) {
    let tTag = `<Texture TexSlot="${xmlEscape(t.texSlot)}" TexProps="${xmlEscape(t.texProps)}" TexLink="${xmlEscape(t.texLink)}"`
    tTag += attrsStr(t.extra)
    out += `        ${tTag}/>\n`
  }
  out += `    </ObjectUnit>\n`
  return out
}

function writeDoodad(d: PlacedDoodad): string {
  let tag = `<ObjectDoodad Id="${d.id}" Variation="${d.variation}" Position="${xmlEscape(d.position)}"`
  if (d.rotation !== undefined) tag += ` Rotation="${xmlEscape(d.rotation)}"`
  tag += ` Scale="${xmlEscape(d.scale)}" Type="${xmlEscape(d.type)}"`
  tag += attrsStr(d.extra)
  if (d.flags.length === 0) {
    return `    ${tag}/>\n`
  }
  let out = `    ${tag}>\n`
  for (const f of d.flags) {
    out += `        <Flag Index="${xmlEscape(f.index)}" Value="${xmlEscape(f.value)}"/>\n`
  }
  out += `    </ObjectDoodad>\n`
  return out
}

function writePoint(p: PlacedPoint): string {
  let tag = `<ObjectPoint Id="${p.id}" Position="${xmlEscape(p.position)}" Scale="${xmlEscape(p.scale)}" Type="${xmlEscape(p.type)}"`
  if (p.name !== undefined) tag += ` Name="${xmlEscape(p.name)}"`
  if (p.color !== undefined) tag += ` Color="${xmlEscape(p.color)}"`
  if (p.rotation !== undefined) tag += ` Rotation="${xmlEscape(p.rotation)}"`
  if (p.sound !== undefined) tag += ` Sound="${xmlEscape(p.sound)}"`
  if (p.model !== undefined) tag += ` Model="${xmlEscape(p.model)}"`
  if (p.soundActor !== undefined) tag += ` SoundActor="${xmlEscape(p.soundActor)}"`
  tag += attrsStr(p.extra)
  return `    ${tag}/>\n`
}

function writeCamera(c: PlacedCamera): string {
  let tag = `<ObjectCamera Id="${c.id}" Position="${xmlEscape(c.position)}"`
  if (c.rotation !== undefined) tag += ` Rotation="${xmlEscape(c.rotation)}"`
  if (c.scale !== undefined) tag += ` Scale="${xmlEscape(c.scale)}"`
  if (c.name !== undefined) tag += ` Name="${xmlEscape(c.name)}"`
  if (c.color !== undefined) tag += ` Color="${xmlEscape(c.color)}"`
  if (c.cameraTarget !== undefined) tag += ` CameraTarget="${xmlEscape(c.cameraTarget)}"`
  tag += attrsStr(c.extra)
  if (c.cameraValues.length === 0) {
    return `    ${tag}/>\n`
  }
  let out = `    ${tag}>\n`
  for (const v of c.cameraValues) {
    out += `        <CameraValue Index="${xmlEscape(v.index)}" Value="${xmlEscape(v.value)}"/>\n`
  }
  out += `    </ObjectCamera>\n`
  return out
}

/** Serialize a `PlacedObjectsResult` back to XML. */
export function writeObjects(data: PlacedObjectsResult): string {
  let out = `<?xml version="1.0" encoding="utf-8"?>\n`
  out += `<PlacedObjects Version="${data.version}">\n`
  for (const u of data.units) out += writeUnit(u)
  for (const d of data.doodads) out += writeDoodad(d)
  for (const p of data.points) out += writePoint(p)
  for (const c of data.cameras) out += writeCamera(c)
  out += `</PlacedObjects>\n`
  return out
}

/**
 * Collect all catalog entity links in the placed objects data.
 * Useful for building rename targets and relation graphs.
 */
export function getObjectEntityLinks(data: PlacedObjectsResult): ObjectEntityLink[] {
  const links: ObjectEntityLink[] = []
  const link = (elementType: string, id: number, field: string, value: string, element: string, attribute: string) =>
    links.push({ elementType, id, field, value, namespace: catalogNamespace(element, attribute) })
  for (const u of data.units) {
    if (u.unitType) link('unit', u.id, 'unitType', u.unitType, 'ObjectUnit', 'UnitType')
    for (const t of u.textures) if (t.texLink) link('unit', u.id, 'texLink', t.texLink, 'Texture', 'TexLink')
  }
  for (const p of data.points) {
    if (p.sound) link('point', p.id, 'sound', p.sound, 'ObjectPoint', 'Sound')
    if (p.model) link('point', p.id, 'model', p.model, 'ObjectPoint', 'Model')
    if (p.soundActor) link('point', p.id, 'soundActor', p.soundActor, 'ObjectPoint', 'SoundActor')
  }
  return links
}
