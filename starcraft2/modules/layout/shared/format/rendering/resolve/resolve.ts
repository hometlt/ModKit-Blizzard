/**
 * Frame-tree resolution: merge a desc's contributions (template chain, own
 * declarations, `file=` hookup extensions) into `ResolvedFrame`s, with
 * per-property source attribution.
 *
 * Merge order (weakest → strongest), per
 * `docs/tasks-active/layout-rendering/SPEC_LAYOUT_SEMANTICS.md` §2:
 *   1. the desc's template chain, deepest template first;
 *   2. the desc itself;
 *   3. hookup descs extending it (`file=`), in index order — each hookup's own
 *      template chain (weaker than the hookup itself) applies first.
 *
 * Hookup matching happens in two coordinate systems, both required:
 *   - the desc's *home* path (`targetFile` + `descRelativeName`) — extensions
 *     written against the file that declares the frame;
 *   - the *runtime* path of the resolved node (root target file + resolved
 *     name chain) — the engine resolves hookup paths against the built tree,
 *     so a hookup can target frames that only exist through templates (e.g.
 *     `GameUI/…/HelpMenuDialogGame/PanelFrame/TechTreePanel`, where
 *     `PanelFrame` comes from `HelpMenuDialog/HelpMenuDialogTemplate`).
 * Hookups may also *create* children that don't exist in the base tree; those
 * are discovered by scanning extension paths one segment below the node.
 *
 * Children merge by name (case-insensitive) across all contributions; child
 * list order is first-seen in merge order, so template-created children come
 * before instance-only ones.
 */

import { DescKind, ElementDefKind } from '../../../layout-engine/sc2-layout-core/core.js'
import type {
  Store,
  DescIndex,
  DescNamespace,
  XMLElement,
  XMLDocument,
} from '../../../layout-engine/sc2-layout-core/core.js'
import type {
  AnchorSide,
  Contribution,
  ContributionOrigin,
  ResolveDiagnostic,
  ResolvedAnchor,
  ResolvedFrame,
  ResolvedProperty,
  SourceRef,
} from './types.js'
import type { ResolvedStateGroup } from '../states/types.js'
import { parseStateGroup } from '../states/parse.js'
import { ANCHOR_SIDES } from './types.js'

export interface ResolveFrameOptions {
  /** Cap on resolved tree depth (safety for pathological inputs). Default 64. */
  maxDepth?: number
  /** Maximum expanded nodes; checked during construction, including template children. */
  maxNodes?: number
}

/**
 * Resolve a frame by its desc path (`FileName/Frame/Child/…`). The path must
 * name a *declared* desc — frames that only exist through templates or
 * hookups are not addressable this way; resolve their nearest declared
 * ancestor and navigate with {@link getResolvedDescendant}.
 */
export function resolveFrameByPath(
  store: Store,
  descPath: string,
  options: ResolveFrameOptions = {},
): ResolvedFrame | undefined {
  const desc = store.index.rootNs.getDeep(descPath)
  if (!desc || desc.kind !== DescKind.Frame) return undefined
  return resolveFrameFromDesc(store.index, desc, options)
}

/** Resolve a frame from an already-located desc. */
export function resolveFrameFromDesc(
  index: DescIndex,
  desc: DescNamespace,
  options: ResolveFrameOptions = {},
): ResolvedFrame {
  if (options.maxNodes !== undefined && (!Number.isSafeInteger(options.maxNodes) || options.maxNodes < 1)) {
    throw new RangeError('SC2Layout maxNodes must be a positive safe integer')
  }
  if (options.maxDepth !== undefined && (!Number.isSafeInteger(options.maxDepth) || options.maxDepth < 0)) {
    throw new RangeError('SC2Layout maxDepth must be a nonnegative safe integer')
  }
  const ctx: Ctx = { index, ext: buildExtCache(index), remainingNodes: options.maxNodes }
  // Runtime coordinates: for hookup descs the coordinate system is the file
  // they extend (`targetFile`) and their slash name is already the full path.
  const extFile = (desc.targetFile ?? '').toLowerCase()
  const extPath = desc.descRelativeName.toLowerCase()
  return resolveNode(
    ctx,
    desc.name,
    [{ desc, origin: 'own' }],
    [desc.name],
    extFile,
    extPath,
    options.maxDepth ?? 64,
  )
}

/** Navigate a resolved tree by child frame names (case-insensitive). */
export function getResolvedDescendant(
  frame: ResolvedFrame,
  framePath: readonly string[],
): ResolvedFrame | undefined {
  let current: ResolvedFrame | undefined = frame
  for (const name of framePath) {
    const lower = name.toLowerCase()
    current = current?.children.find(c => c.name.toLowerCase() === lower)
    if (!current) return undefined
  }
  return current
}

// ---------------------------------------------------------------------------

interface Seed {
  desc: DescNamespace
  origin: ContributionOrigin
  via?: string
}

interface Contrib {
  desc: DescNamespace
  contribution: Contribution
}

/** fileLower → extension relPathLower → extending descs (from `DescIndex.fileRefs`). */
type ExtCache = Map<string, Map<string, Set<DescNamespace>>>

interface Ctx {
  index: DescIndex
  ext: ExtCache
  remainingNodes: number | undefined
}

function buildExtCache(index: DescIndex): ExtCache {
  const out: ExtCache = new Map()
  for (const [file, relMap] of index.fileRefs) {
    const fileLower = file.toLowerCase()
    let fm = out.get(fileLower)
    if (!fm) {
      fm = new Map()
      out.set(fileLower, fm)
    }
    for (const [rel, descs] of relMap) {
      const relLower = rel.toLowerCase()
      let set = fm.get(relLower)
      if (!set) {
        set = new Set()
        fm.set(relLower, set)
      }
      for (const d of descs) set.add(d)
    }
  }
  return out
}

function resolveNode(
  ctx: Ctx,
  name: string,
  seeds: Seed[],
  path: string[],
  extFile: string,
  extPath: string,
  depthLeft: number,
): ResolvedFrame {
  if (ctx.remainingNodes !== undefined) {
    if (ctx.remainingNodes === 0) throw new RangeError('SC2Layout resolved tree exceeds maxNodes')
    ctx.remainingNodes -= 1
  }
  const diagnostics: ResolveDiagnostic[] = []
  const contribs: Contrib[] = []
  const visited = new Set<DescNamespace>()

  const addDesc = (desc: DescNamespace, origin: ContributionOrigin, via?: string): void => {
    if (visited.has(desc)) return
    visited.add(desc)

    // Template chain first — weaker than the desc that references it.
    const tpl = desc.template
    if (tpl !== null && tpl !== undefined && tpl !== '') {
      const tplDesc = ctx.index.rootNs.getDeep(tpl)
      if (!tplDesc) {
        diagnostics.push({
          code: 'missing-template',
          message: `template "${tpl}" not found in the index`,
          descFqn: desc.fqn,
        })
      } else if (tplDesc.kind !== desc.kind) {
        diagnostics.push({
          code: 'template-kind-mismatch',
          message: `template "${tpl}" is not a frame desc`,
          descFqn: desc.fqn,
        })
      } else {
        addDesc(tplDesc, 'template', tpl)
      }
    }

    contribs.push({
      desc,
      contribution: { descFqn: desc.fqn, origin, ...(via !== undefined ? { via } : {}) },
    })

    // Hookups extending this desc's home path (later-loaded files override).
    const homeExt = ctx.ext
      .get((desc.targetFile ?? '').toLowerCase())
      ?.get(desc.descRelativeName.toLowerCase())
    if (homeExt) {
      for (const extDesc of homeExt) {
        if (extDesc !== desc) addDesc(extDesc, 'hookup')
      }
    }
  }

  for (const seed of seeds) addDesc(seed.desc, seed.origin, seed.via)

  // Hookups targeting this node's *runtime* path (may address template-created
  // frames whose home path differs from the runtime path).
  const runtimeExt = ctx.ext.get(extFile)?.get(extPath)
  if (runtimeExt) {
    for (const extDesc of runtimeExt) addDesc(extDesc, 'hookup')
  }

  // --- merge declarations, weakest → strongest ---
  const properties = new Map<string, ResolvedProperty>()
  const anchors: Partial<Record<AnchorSide, ResolvedAnchor>> = {}
  const animations: string[] = []
  const stateGroups: ResolvedStateGroup[] = []
  const stateGroupIdx = new Map<string, number>()
  const childSeeds = new Map<string, { name: string; seeds: Seed[]; descs: Set<DescNamespace> }>()
  let type: string | undefined
  let source: SourceRef | undefined
  let ownSource: SourceRef | undefined

  const addChildSeed = (
    childName: string,
    desc: DescNamespace,
    origin: ContributionOrigin,
    via?: string,
  ): void => {
    const key = childName.toLowerCase()
    let entry = childSeeds.get(key)
    if (!entry) {
      entry = { name: childName, seeds: [], descs: new Set() }
      childSeeds.set(key, entry)
    }
    if (entry.descs.has(desc)) return
    entry.descs.add(desc)
    entry.seeds.push({ desc, origin, ...(via !== undefined ? { via } : {}) })
  }

  for (const { desc, contribution } of contribs) {
    for (const decl of desc.xDecls) {
      const el = decl as XMLElement
      if (typeof el.getAttributeValue !== 'function') continue
      const declType = el.getAttributeValue('type', '')
      if (declType) type = declType
      // Strongest declaration wins as the frame's source (contribs run
      // weakest→strongest, so later assignments override). `ownSource` tracks
      // the strongest OWN declaration specifically — the instance the editor
      // materialises overrides into, distinct from a stronger hookup/template.
      const ref = sourceRefOf(el, contribution)
      source = ref
      if (contribution.origin === 'own') ownSource = ref

      for (const child of el.children) {
        applyElement(child, contribution, properties, anchors)
      }
    }

    for (const childDesc of desc.children.values()) {
      switch (childDesc.kind) {
        case DescKind.Frame:
          addChildSeed(childDesc.name, childDesc, contribution.origin, contribution.via)
          break
        case DescKind.Animation:
          if (!animations.includes(childDesc.name)) animations.push(childDesc.name)
          break
        case DescKind.StateGroup: {
          // Strongest contribution wins the whole StateGroup (deterministic subset).
          const sg = parseStateGroup(childDesc)
          const at = stateGroupIdx.get(childDesc.name.toLowerCase())
          if (at !== undefined) stateGroups[at] = sg
          else {
            stateGroupIdx.set(childDesc.name.toLowerCase(), stateGroups.length)
            stateGroups.push(sg)
          }
          break
        }
      }
    }
  }

  // Child-creating hookups: extension paths exactly one segment below this
  // node — in the runtime coordinate system and in each contribution's home
  // system (a hookup can add a new frame to a template file's frame).
  const scanCreatedChildren = (file: string, base: string): void => {
    const fm = ctx.ext.get(file)
    if (!fm) return
    const prefix = `${base}/`
    for (const [rel, descs] of fm) {
      if (!rel.startsWith(prefix)) continue
      const tail = rel.slice(prefix.length)
      if (tail.length === 0 || tail.includes('/')) continue
      for (const extDesc of descs) {
        // Name from the desc's own slash name keeps original casing.
        const segs = extDesc.name.split('/')
        addChildSeed(segs[segs.length - 1] ?? tail, extDesc, 'hookup')
      }
    }
  }
  scanCreatedChildren(extFile, extPath)
  for (const { desc } of contribs) {
    scanCreatedChildren((desc.targetFile ?? '').toLowerCase(), desc.descRelativeName.toLowerCase())
  }

  const children: ResolvedFrame[] = []
  if (depthLeft <= 0 && childSeeds.size > 0) {
    throw new RangeError('SC2Layout resolved tree exceeds maxDepth')
  }
  if (depthLeft > 0) {
    for (const entry of childSeeds.values()) {
      const childName = entry.name.includes('/') ? entry.name.split('/').pop()! : entry.name
      children.push(
        resolveNode(
          ctx,
          childName,
          entry.seeds,
          [...path, childName],
          extFile,
          `${extPath}/${childName.toLowerCase()}`,
          depthLeft - 1,
        ),
      )
    }
  }

  const mainDesc = seeds[0]!.desc
  return {
    name,
    type: type ?? mainDesc.stype?.name ?? 'Frame',
    path,
    ...(source !== undefined ? { source } : {}),
    ...(ownSource !== undefined ? { ownSource } : {}),
    contributions: contribs.map(c => c.contribution),
    properties,
    anchors,
    animations,
    stateGroups,
    children,
    diagnostics,
  }
}

/** Apply one XML child element of a frame declaration into the merged maps. */
function applyElement(
  el: XMLElement,
  contribution: Contribution,
  properties: Map<string, ResolvedProperty>,
  anchors: Partial<Record<AnchorSide, ResolvedAnchor>>,
): void {
  if (!el.tag) return
  const nodeKind = el.lang?.sdef?.nodeKind
  // Frames/Animations/StateGroups are merged through the desc tree, not as properties.
  if (
    nodeKind === ElementDefKind.Frame ||
    nodeKind === ElementDefKind.Animation ||
    nodeKind === ElementDefKind.StateGroup
  )
    return

  const source = sourceRefOf(el, contribution)

  if (el.tag.toLowerCase() === 'anchor') {
    applyAnchor(el, source, anchors)
    return
  }

  const attrs: Record<string, string> = {}
  for (const attrName of Object.keys(el.attributes)) {
    const attr = el.attributes[attrName]
    if (attr?.startValue !== undefined && attr.value !== undefined) attrs[attrName] = attr.value
  }

  const val = attrs['val']
  const indexAttr = attrs['index']
  const key =
    indexAttr !== undefined ? `${el.tag.toLowerCase()}[${indexAttr}]` : el.tag.toLowerCase()

  const previous = properties.get(key)
  properties.set(key, {
    tag: el.tag,
    attrs,
    ...(val !== undefined ? { val } : {}),
    source,
    overridden: previous ? [...previous.overridden, { ...previous, overridden: [] }] : [],
  })
}

/**
 * Anchor merge (spec §2): each `<Anchor side="X">` replaces the slot for X; a
 * side-less `<Anchor>` resets all four sides. Sides not re-declared by a
 * stronger contribution keep the inherited anchor (per-side coexistence).
 */
function applyAnchor(
  el: XMLElement,
  source: SourceRef,
  anchors: Partial<Record<AnchorSide, ResolvedAnchor>>,
): void {
  const read = (name: string): string | undefined => {
    const v = el.getAttributeValue(name, '')
    return v === '' && !el.hasAttribute(name) ? undefined : v
  }
  const sideRaw = read('side')
  const relative = read('relative')
  const pos = read('pos')
  const offset = read('offset')

  const base = {
    ...(relative !== undefined ? { relative } : {}),
    ...(pos !== undefined ? { pos } : {}),
    ...(offset !== undefined ? { offset } : {}),
    source,
  }

  if (sideRaw !== undefined) {
    const side = normalizeSide(sideRaw)
    if (side) anchors[side] = { side, implicitSide: false, ...base }
    return
  }
  for (const side of ANCHOR_SIDES) {
    anchors[side] = { side, implicitSide: true, ...base }
  }
}

function normalizeSide(raw: string): AnchorSide | undefined {
  const s = raw.toLowerCase()
  return ANCHOR_SIDES.find(k => k.toLowerCase() === s)
}

function sourceRefOf(el: XMLElement, contribution: Contribution): SourceRef {
  const doc = el.getDocument() as XMLDocument
  return {
    uri: doc.lang?.tdoc?.uri ?? '',
    start: el.start,
    end: el.end,
    contribution,
  }
}
