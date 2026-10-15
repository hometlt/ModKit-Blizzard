/**
 * `sc2-data` structural detection.
 *
 * Canonical architecture section 5.8 is explicit about what this probe must prove:
 *
 * > `.xml` alone never identifies SC2 GameData: the source must have a `Catalog` root and valid
 * > SC2 map/mod/campaign or mounted archive context.
 *
 * So detection is a real structural check, and it is built entirely from primitives the SC2
 * existing cores already export — `scanXml`/`catalogEntities` from this codec's language core (the same
 * lenient, offset-aware scanner its diagnostics and completion use) and `hasCatalogClass` from
 * `@modkitx/data-processing/sc2-catalog` (which answers from `DATA_CLASS_SCHEMA`). No new SC2 structural rule is
 * invented here, and no class-name list is duplicated.
 *
 * `scanXml` is deliberately lenient about truncated markup, which is what makes it safe to run
 * over a bounded header read rather than the whole file (pipeline rule 2: "Detection is abortable
 * and never fully decodes the asset").
 */

import { hasCatalogClass } from '../catalog-engine/sc2-catalog/index.js'
import { catalogEntities } from './language/entity.js'
import { scanXml } from './language/xml-scan.js'
import {
  SC2_DATA_CODEC_ID,
  SC2_DATA_PARENT_ARTIFACTS,
  SC2_DATA_XML_ROOT,
  SC2_GAME_ID,
  isGameDataPath,
  sc2PackageFolderOf,
} from './identity.js'

/** The part of a source identity detection reads. */
export interface Sc2DataSource {
  readonly id: string
  readonly path: string
  readonly name: string
  readonly extension: string
  readonly context?: {
    readonly gameId?: string
    readonly parentArtifactIds?: readonly string[]
  }
}

/** Where the caller says the source sits. */
export interface Sc2DataDetectionContext {
  readonly gameId?: string
  readonly parentArtifactIds?: readonly string[]
}

export interface Sc2DataDetectionEvidence {
  readonly kind: 'structure' | 'path' | 'context' | 'extension'
  readonly detail: string
  readonly polarity?: 'negative'
  readonly range?: { readonly offset: number; readonly length: number }
}

export interface Sc2DataDetection {
  readonly pluginId: string
  readonly confidence: number
  readonly evidence: readonly Sc2DataDetectionEvidence[]
  readonly requiredRanges: readonly { readonly offset: number; readonly length: number }[]
}

/**
 * Sniff budget. Enough to see the `<Catalog>` root plus a healthy run of entities in any real
 * GameData file, while never reading a multi-megabyte `ActorData.xml` in full.
 */
export const SC2_DATA_MAX_SNIFF_BYTES = 64 * 1024

/** Entity elements to inspect before stopping; detection ranks, it does not inventory. */
const MAX_INSPECTED_ENTITIES = 64

const XML_EXTENSION = '.xml'

function clamp(value: number): number {
  return Math.max(0, Math.min(0.98, Number(value.toFixed(4))))
}

/** UTF-8 decode of a bounded header, tolerating a BOM and a truncated final code point. */
function decodeHeader(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export interface CatalogStructure {
  /** Whether a `<Catalog>` element was found at the top of the document. */
  readonly hasCatalogRoot: boolean
  /** Root element name actually seen, when the document has one. */
  readonly rootTag?: string
  /** Catalog-class entity tags found (`CUnit`, `CActorUnit`, …), deduplicated, bounded. */
  readonly entityTags: readonly string[]
  /** Elements that look like entities but name no class the schema knows. */
  readonly unknownEntityTags: readonly string[]
}

/**
 * Structural summary of a (possibly truncated) GameData document.
 *
 * Exported because `describe()` reuses the same rules; detection and description must never
 * disagree about what counts as an entity.
 */
export function inspectCatalogStructure(text: string): CatalogStructure {
  const roots = scanXml(text)
  const rootTag = roots[0]?.tag
  const hasCatalogRoot = roots.some(element => element.tag === SC2_DATA_XML_ROOT)

  // `catalogEntities` descends through non-entity wrappers (the `<Catalog>` root), so this works
  // for both real files and the wrapper-less snippets the SC2 packages' own tests use.
  const entities = catalogEntities(roots)
  const entityTags: string[] = []
  const unknownEntityTags: string[] = []
  for (const element of entities.slice(0, MAX_INSPECTED_ENTITIES)) {
    if (!entityTags.includes(element.tag)) entityTags.push(element.tag)
  }

  // A `<Catalog>` whose children are all unknown tags is still XML, not GameData. Look at the
  // root's direct children to say so, rather than silently reporting "no entities".
  if (hasCatalogRoot && entityTags.length === 0) {
    const catalogRoot = roots.find(element => element.tag === SC2_DATA_XML_ROOT)
    for (const child of catalogRoot?.children ?? []) {
      if (!hasCatalogClass(child.tag) && !unknownEntityTags.includes(child.tag)) {
        unknownEntityTags.push(child.tag)
      }
    }
  }

  return {
    hasCatalogRoot,
    ...(rootTag === undefined ? {} : { rootTag }),
    entityTags,
    unknownEntityTags,
  }
}

/** Whether `context` (or the source's own declared context) places this inside an SC2 artifact. */
function parentArtifactMatch(
  context: Sc2DataDetectionContext,
  declared: readonly string[] | undefined,
): string | undefined {
  const ids = [...(context.parentArtifactIds ?? []), ...(declared ?? [])]
  return ids.find(id => (SC2_DATA_PARENT_ARTIFACTS as readonly string[]).includes(id))
}

/**
 * Bounded structural detection of an SC2 GameData catalog document.
 *
 * Confidence composition:
 *
 * - validated `<Catalog>` root: +0.4 (`structure` evidence — the manifest's `xmlRoots`);
 * - at least one schema-known catalog class inside it: +0.3 (`structure` evidence);
 * - `**\/GameData/**\/*.xml` path: +0.15 (`path` evidence);
 * - enclosing `sc2-mod`/`sc2-map`/`sc2-campaign` artifact, or a path inside such a folder: +0.1
 *   (`context` evidence);
 * - `.xml` extension: +0.05 (`extension` evidence — "only selects candidates").
 *
 * Two negative outcomes, both of which `rankDetectionCandidates` treats as outright rejection
 * because they are `structure`-kind:
 *
 * 1. no `Catalog` root **and** no schema-known catalog class — arbitrary XML;
 * 2. a `Catalog` root whose children name no class the schema knows — a `Catalog`-shaped
 *    document from something that is not SC2 GameData.
 *
 * A structurally valid catalog with **neither** GameData path nor SC2 parent artifact is not
 * rejected, but it carries negative `context` evidence and loses its context/path credit, so it
 * stays reachable through **Open With** while never auto-claiming a loose `.xml`. This is exactly
 * section 5.8's "arbitrary XML outside those contexts is not claimed by `sc2-data`".
 */
export function detectSc2DataBytes(
  bytes: Uint8Array,
  descriptor: Pick<Sc2DataSource, 'path' | 'name' | 'extension' | 'context'>,
  context: Sc2DataDetectionContext = {},
): Sc2DataDetection {
  const evidence: Sc2DataDetectionEvidence[] = []
  let confidence = 0

  const header = bytes.subarray(0, SC2_DATA_MAX_SNIFF_BYTES)
  const structure = inspectCatalogStructure(decodeHeader(header))
  const range = { offset: 0, length: header.byteLength }

  if (structure.hasCatalogRoot) {
    evidence.push({ kind: 'structure', detail: `root element ${SC2_DATA_XML_ROOT}`, range })
    confidence += 0.4
  }
  if (structure.entityTags.length > 0) {
    evidence.push({
      kind: 'structure',
      detail: `catalog classes ${structure.entityTags.slice(0, 4).join(', ')}`,
      range,
    })
    confidence += 0.3
  }

  if (!structure.hasCatalogRoot && structure.entityTags.length === 0) {
    evidence.push({
      kind: 'structure',
      polarity: 'negative',
      detail: structure.rootTag
        ? `root element ${structure.rootTag} is not ${SC2_DATA_XML_ROOT} and declares no catalog class`
        : 'no XML element found in the sniffed header',
      range,
    })
    return { pluginId: SC2_DATA_CODEC_ID, confidence: 0, evidence, requiredRanges: [range] }
  }
  if (structure.hasCatalogRoot && structure.entityTags.length === 0) {
    evidence.push({
      kind: 'structure',
      polarity: 'negative',
      detail:
        structure.unknownEntityTags.length > 0
          ? `<${SC2_DATA_XML_ROOT}> children name no known catalog class (${structure.unknownEntityTags.slice(0, 4).join(', ')})`
          : `<${SC2_DATA_XML_ROOT}> declares no catalog entity`,
      range,
    })
    return { pluginId: SC2_DATA_CODEC_ID, confidence: 0, evidence, requiredRanges: [range] }
  }

  const onGameDataPath = isGameDataPath(descriptor.path)
  if (onGameDataPath) {
    evidence.push({ kind: 'path', detail: 'matches **/GameData/**/*.xml' })
    confidence += 0.15
  }

  // A catalog anywhere in an unpacked package folder (`GameData.xml` may include any path).
  const parent =
    parentArtifactMatch(context, descriptor.context?.parentArtifactIds) ?? sc2PackageFolderOf(descriptor.path)
  if (parent !== undefined) {
    evidence.push({ kind: 'context', detail: `inside ${parent}` })
    confidence += 0.1
  }
  if (context.gameId === SC2_GAME_ID || descriptor.context?.gameId === SC2_GAME_ID) {
    evidence.push({ kind: 'context', detail: `declared game ${SC2_GAME_ID}` })
    confidence += 0.05
  }

  // Section 5.8: a `Catalog` root is necessary but not sufficient — SC2 artifact or mounted
  // archive context is the other half. Absent both signals this stays an Open With route only.
  if (parent === undefined && !onGameDataPath) {
    evidence.push({
      kind: 'context',
      polarity: 'negative',
      detail:
        'no enclosing sc2-mod/sc2-map/sc2-campaign artifact and not on a GameData path; ' +
        'a Catalog root alone does not identify SC2 GameData',
    })
    confidence = Math.min(confidence, 0.3)
  }

  if (descriptor.extension === XML_EXTENSION) {
    evidence.push({ kind: 'extension', detail: descriptor.name })
    confidence += 0.05
  }

  return {
    pluginId: SC2_DATA_CODEC_ID,
    confidence: clamp(confidence),
    evidence,
    requiredRanges: [range],
  }
}
