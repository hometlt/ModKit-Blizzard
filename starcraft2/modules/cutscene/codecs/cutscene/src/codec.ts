/**
 * `.SC2Cutscene` / `.StormCutscene` and legacy `.SC2Scene`: scene tree, timeline and dependencies.
 * scene-at adds a bounded, pure native-state/gaze-target query via evaluate.ts; it never plays audio,
 * executes markers, resolves assets or writes the source. See codec.json for its input schema.
 * world.ts separately publishes the existing world source: CModel resources through Host,
 * immutable frame samples and TargetCamera for the common CPU/WebGL renderer.
 *
 * Nothing read this format before — not MK2, not MK3 — so a campaign's cinematics were opaque
 * bytes, and the models, sounds, conversation lines and facial animations they name were invisible
 * to "where is this used?". Most of a campaign's model references live in cutscenes, so that
 * question was answering wrongly rather than partially.
 *
 * Three decisions here are worth stating because the obvious alternative is wrong in each case.
 *
 * Identifiers are strings. 3 % of them exceed `uint64` and all of them exceed `2^53`, so both
 * `Number` and `BigInt64Array` corrupt the reference graph — see `model.ts`.
 *
 * Editing is `dependency-required`, not `disabled` and not shipped. Reading and byte-identical
 * writing work today, and the meaning of the two attributes an editor depends on is measured from
 * the corpus — `startLinkAttachToPoint` (1 = target start, 2 = target end, `timeline.ts`) and the
 * tangent types (`curves.ts`). What is still missing is proof that a file this codec *writes* plays
 * and reopens the same in the Cutscene Editor, and the single writer path edits must go through.
 * Until both exist, the operation says why it is unavailable instead of writing.
 *
 * The dependency graph is published as a relation graph rather than as
 * `common.view/model-resource-refs-source`. That contract's `role` is `texture | sidecar`, which
 * fits a model's own requirements and not a cutscene's — a `soundLink` is neither, and calling it
 * one would put a wrong fact into the graph in exchange for reusing a name.
 */
import {
  createInspectionCodec,
  createRelationGraphSource,
  createSubjectFactsSource,
  createTableDataSource,
  createTreeDataSource,
  fact,
  subjectIdFor,
  type InspectionTreeNode,
} from '@modkit/codec-kit'
import { operationId } from '@modkit/core'

import { curveChannelsOf, curveSummary } from './curves.js'
import { CutsceneParseError, decodeCutscene, looksLikeCutscene } from './decode.js'
import { encodeCutscene } from './encode.js'
import { assertCutsceneTime, compileCutscene, type CompiledCutscene } from './evaluate.js'
import { guidOf, valueOf, walk, type CutsceneDocument, type CutsceneElement } from './model.js'
import { includedCutscenes, referenceGroups, type CutsceneReferenceRole } from './refs.js'
import { kindOf, roleOf, tagEntry } from './registry.js'
import { resolveTimeline } from './timeline.js'
import { createCutsceneWorldSource } from './world.js'
import { findingsOf, validateCutscene } from './validate.js'

const ID = 'blizzard/sc2-cutscene'
const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true })

const TIMELINE_OPERATION = operationId('blizzard/sc2-cutscene.timeline', { contributionId: ID })
const REFERENCES_OPERATION = operationId('blizzard/sc2-cutscene.references', { contributionId: ID })
const SCENE_AT_OPERATION = operationId('blizzard/sc2-cutscene.scene-at', { contributionId: ID })
const FACIAL_AT_OPERATION = operationId('blizzard/sc2-cutscene.facial-at', { contributionId: ID })

export const operations = Object.freeze([
  Object.freeze({
    id: 'view.inspect',
    handlerId: 'inspect',
    mutatesSource: false,
    requiredPermissions: Object.freeze(['read-source']),
    outputKinds: Object.freeze(['json']),
  }),
  Object.freeze({
    id: 'asset.validate',
    handlerId: 'validate',
    mutatesSource: false,
    requiredPermissions: Object.freeze(['read-source']),
    outputKinds: Object.freeze(['json']),
  }),
  Object.freeze({
    id: 'export.raw',
    handlerId: 'export-raw',
    mutatesSource: false,
    requiredPermissions: Object.freeze(['read-source']),
    outputKinds: Object.freeze(['bytes']),
  }),
  Object.freeze({
    id: TIMELINE_OPERATION,
    handlerId: 'timeline',
    mutatesSource: false,
    requiredPermissions: Object.freeze(['read-source']),
    outputKinds: Object.freeze(['json']),
  }),
  Object.freeze({
    id: REFERENCES_OPERATION,
    handlerId: 'references',
    mutatesSource: false,
    requiredPermissions: Object.freeze(['read-source']),
    outputKinds: Object.freeze(['json']),
  }),
  Object.freeze({
    id: SCENE_AT_OPERATION,
    handlerId: 'scene-at',
    mutatesSource: false,
    requiredPermissions: Object.freeze(['read-source']),
    outputKinds: Object.freeze(['json']),
    inputSchema: Object.freeze({
      $ref: 'modkit://blizzard/sc2-cutscene/scene-at.v1',
      document: {
        type: 'object', additionalProperties: false, required: ['timeMs'],
        properties: { timeMs: { type: 'number', minimum: 0, maximum: Number.MAX_SAFE_INTEGER,
          description: 'Explicit scene position; milliseconds provisionally. Does not execute playback markers.' } },
      },
    }),
  }),
  Object.freeze({
    id: FACIAL_AT_OPERATION, handlerId: 'facial-at', mutatesSource: false,
    requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['json']),
    inputSchema: Object.freeze({ $ref: 'modkit://blizzard/sc2-cutscene/facial-at.v1',
      document: { type: 'object', additionalProperties: false, required: ['timeMs'],
        properties: { timeMs: { type: 'number', minimum: 0, maximum: Number.MAX_SAFE_INTEGER,
          description: 'Explicit scene position, provisional milliseconds; publishes active conversation clocks and exact catalog FaceFX references without playing the graph.' } } } }),
  }),
  Object.freeze({
    id: 'edit.structure',
    handlerId: 'edit-structure',
    mutatesSource: true,
    requiredPermissions: Object.freeze(['read-source', 'write-source']),
    outputKinds: Object.freeze(['edit-plan']),
  }),
])

/** Why `edit.structure` is declared but unavailable, in the words a reader needs to act on it. */
const EDIT_BLOCKED_REASON =
  'structural editing waits on SC2 Editor verification: the startLinkAttachToPoint and curveInType meanings are measured from the corpus, but no edited file has yet been reopened in the Cutscene Editor, and edits must go through the single writer path'

function basename(uri: string): string {
  const normalized = String(uri).replaceAll('\\', '/').replace(/\/$/u, '')
  const last = normalized.slice(normalized.lastIndexOf('/') + 1)
  return last === '' ? normalized : last
}

function labelOf(element: CutsceneElement): string {
  const name = valueOf(element, 'name')
  if (name !== undefined && name !== '') return name
  const property = valueOf(element, 'propertyName')
  if (property !== undefined && property !== '') return property
  return kindOf(element.tag)
}

/**
 * The scene as a tree, bounded by the host's node budget.
 *
 * The largest shipped file holds tens of thousands of elements, of which almost all are curve keys;
 * a tree that expanded every one would cost more to build than the document costs to read, and no
 * reader scrolls 142 000 rows. Tracks are always shown in full — they are the scene's structure —
 * and clips are shown until the budget runs out, after which the count says what was left off. A
 * truncated tree that says so is honest; a silently truncated one is not.
 */
function treeOf(document: CutsceneDocument, maxNodes: number): { root: InspectionTreeNode; omitted: number } {
  let remaining = Math.max(1, maxNodes)
  let omitted = 0

  const build = (element: CutsceneElement, path: readonly string[]): InspectionTreeNode => {
    const role = roleOf(element.tag) ?? 'element'
    const guid = guidOf(element)
    const label = labelOf(element)
    const semanticPath = [...path, guid ?? label]
    const start = valueOf(element, 'start')
    const duration = valueOf(element, 'duration')

    const children: InspectionTreeNode[] = []
    for (const child of element.children) {
      if (remaining <= 0) {
        omitted += 1
        continue
      }
      remaining -= 1
      children.push(build(child, semanticPath))
    }
    if (element.children.length > children.length) {
      children.push({
        kind: 'sc2-cutscene-omitted',
        label: `… ${element.children.length - children.length} more, beyond the node budget`,
        semanticPath: [...semanticPath, 'omitted'],
      })
    }

    const preview =
      start === undefined
        ? `${element.children.length} child${element.children.length === 1 ? '' : 'ren'}`
        : duration === undefined
          ? `at ${start}`
          : `${start} + ${duration}`

    return {
      kind: `sc2-cutscene-${role}`,
      label,
      preview,
      semanticPath,
      ...(children.length > 0 ? { children } : {}),
    }
  }

  return { root: build(document.root, []), omitted }
}

const TIMELINE_COLUMNS = Object.freeze(['track', 'clip', 'start', 'end', 'duration', 'anchored', 'approximate'])

const definition = Object.freeze({
  id: ID,
  format: Object.freeze({ id: 'sc2-cutscene', label: 'StarCraft II Cutscene' }),
  operations,

  async detect(prefix: Uint8Array, uri: string) {
    const text = decoder.decode(prefix)
    if (looksLikeCutscene(text)) {
      return { confidence: 0.99, kind: 'structure' as const, note: 'cutscene-state-root-element' }
    }
    /*
     * The extension alone is weak evidence and deliberately not enough on its own: `.SC2Cutscene`
     * and `.SC2Layout` open with the same XML declaration, so a claim made from the name would take
     * a truncated or misnamed file away from a codec that can actually read it.
     */
    if (/\.(sc2cutscene|stormcutscene|sc2scene)$/iu.test(uri)) {
      return { confidence: 0.4, kind: 'context' as const, note: 'cutscene-path-evidence' }
    }
    return { confidence: 0, kind: 'structure' as const, note: 'cutscene-state-root-missing' }
  },

  async inspect(bytes: Uint8Array, context: any) {
    let document: CutsceneDocument
    try {
      document = decodeCutscene(bytes)
    } catch (error) {
      if (error instanceof CutsceneParseError) throw new TypeError(error.message)
      throw error
    }

    const source = context.primary.source
    const name = basename(source.uri)
    const report = validateCutscene(document)
    const findings = findingsOf(report)
    const timeline = resolveTimeline(document)
    const channels = curveChannelsOf(document)
    let compiled: CompiledCutscene | undefined
    const scene = () => compiled ??= compileCutscene(document, Number(context.budget.maxNodes ?? 100_000),
      Number(context.budget.maxDiagnostics ?? 1_000), { timeline, channels })
    const curves = curveSummary(channels)
    const groups = referenceGroups(document)
    const included = includedCutscenes(document)

    const tracks = [...walk(document.root)].filter(element => roleOf(element.tag) === 'node')
    const unknownTagTotal = [...report.unknownTags.values()].reduce((sum, count) => sum + count, 0)
    const origin = new Set(
      [...walk(document.root)]
        .map(element => tagEntry(element.tag)?.origin)
        .filter((item): item is 'both' | 'sc2' | 'storm' => item !== undefined && item !== 'both'),
    )

    const tree = treeOf(document, Number(context.budget.maxNodes ?? 100_000))

    const summary = Object.freeze({
      format: 'sc2-cutscene',
      version: document.version ?? null,
      elements: report.elements,
      tracks: tracks.length,
      clips: timeline.clips.length,
      depth: report.depth,
      curveChannels: curves.channels,
      curveKeys: curves.keys,
      length: timeline.length,
      timeUnit: timeline.timeUnit,
      approximateClips: timeline.approximateClips,
      externalReferences: groups.reduce((sum, group) => sum + group.values.length, 0),
      includedCutscenes: included.length,
      unknownTags: unknownTagTotal,
      gameSpecificTags: [...origin].sort(),
      // Stated rather than left implicit: a reader looking at a truncated tree should be able to
      // find out that it is one without counting the rows.
      treeElementsOmitted: tree.omitted,
    })

    const referenceNodeId = (role: CutsceneReferenceRole, value: string) =>
      subjectIdFor(ID, ['reference', role, value])
    const world = createCutsceneWorldSource(context, scene)

    return {
      summary,
      metadata: [
        Object.freeze({
          id: 'cutscene',
          label: 'Cutscene',
          entries: Object.freeze([
            { key: 'version', value: document.version ?? '(absent)' },
            { key: 'tracks', value: tracks.length },
            { key: 'clips', value: timeline.clips.length },
            { key: 'curveKeys', value: curves.keys },
            { key: 'length', value: timeline.length },
            { key: 'timeUnit', value: 'milliseconds (probable; unconfirmed)' },
          ]),
        }),
        Object.freeze({
          id: 'dependencies',
          label: 'Depends on',
          entries: Object.freeze(
            groups.map(group => ({ key: group.role, value: group.values.length })),
          ),
        }),
      ],
      traits: [
        Object.freeze({ id: 'content.text', parameters: { language: 'xml', encoding: 'utf-8' } }),
        Object.freeze({ id: 'structure.hierarchy', parameters: { kind: 'cutscene-scene' } }),
        Object.freeze({ id: 'structure.nodes', parameters: { count: report.elements } }),
        Object.freeze({ id: 'source.dependencies', parameters: { kinds: groups.map(g => g.role) } }),
      ],
      text: document.text,
      dataSources: {
        'common.view/world-scene-source': world,
        'common.view/tree-data-source': createTreeDataSource({
          kind: 'sc2-cutscene',
          label: name,
          preview: `${tracks.length} tracks, ${timeline.clips.length} clips`,
          children: tree.root.children ?? [],
        }),
        /*
         * The timeline as a table, with `approximate` as a column rather than a footnote. A reader
         * sorting by start time needs to see which rows are one of two possible answers.
         */
        'common.view/table-data-source': createTableDataSource({
          header: TIMELINE_COLUMNS,
          rows: timeline.clips.map(clip => [
            clip.trackName ?? kindOf(clip.trackTag),
            kindOf(clip.tag),
            String(clip.start),
            String(clip.end),
            String(clip.duration),
            clip.startAnchor === undefined ? '' : clip.startAnchor.targetGuid,
            clip.approximate ? 'yes' : '',
          ]),
        }),
        /*
         * The dependency graph. Every node here is a name the document wrote down; none is a path
         * this codec assembled, and none is resolved — resolution needs the workspace's mounts,
         * which belong to the host.
         */
        'common.view/relation-graph-source': createRelationGraphSource({
          snapshotId: String(context.input.revisions.revision),
          nodes: [
            { id: String(source.id), label: name, type: 'Cutscene', kind: 'sc2-cutscene' },
            ...groups.flatMap(group =>
              group.values.map(entry => ({
                id: referenceNodeId(group.role, entry.value),
                label: entry.value,
                type: group.role,
                kind: `sc2-cutscene-${group.role}`,
              })),
            ),
          ],
          edges: groups.flatMap(group =>
            group.values.map(entry => ({
              from: String(source.id),
              to: referenceNodeId(group.role, entry.value),
              role: group.role,
            })),
          ),
          completeness: 'partial',
          reason:
            'these are the names this cutscene writes down; which archive each resolves against is the host’s mount table, not the file’s',
        }),
        'common.view/subject-facts-source': createSubjectFactsSource({
          snapshotId: String(context.input.revisions.revision),
          subjectId: source.id,
          label: name,
          kind: 'sc2-cutscene',
          type: 'StarCraft II cutscene',
          source,
          groups: [
            {
              id: 'scene',
              label: 'Scene',
              facts: [
                fact(source, 'tracks', 'Tracks', tracks.length),
                fact(source, 'clips', 'Clips', timeline.clips.length),
                fact(source, 'curve-channels', 'Animated properties', curves.channels),
                fact(source, 'curve-keys', 'Curve keys', curves.keys),
              ],
            },
            {
              id: 'timeline',
              label: 'Timeline',
              facts: [
                fact(source, 'length', 'Resolved length', timeline.length),
                fact(source, 'approximate', 'Clips of uncertain time', timeline.approximateClips),
                fact(source, 'master-sound', 'Master sound duration', timeline.masterSoundDuration ?? 0),
              ],
            },
            {
              id: 'integrity',
              label: 'Integrity',
              facts: [
                fact(source, 'unresolved', 'References naming nothing here', report.danglingReferences.length),
                fact(source, 'duplicate-guids', 'Identifiers used twice', report.duplicateGuids.length),
                fact(source, 'wide-guids', 'Identifiers wider than uint64', report.widerThanUint64),
              ],
            },
          ],
        }),
      },
      diagnostics: findings.map((item, ordinal) =>
        Object.freeze({
          id: `sc2-cutscene.${ordinal}.${item.code}`,
          category: 'structure' as const,
          code: `blizzard.sc2-cutscene/${item.code}`,
          message: item.message,
          // The contract spells the third level `information`; the finding type uses the shorter
          // name internally, and this is the one place the two meet.
          severity: item.severity === 'info' ? ('information' as const) : item.severity,
        }),
      ),
      operationStates: [
        Object.freeze({
          id: 'edit.structure',
          state: 'dependency-required' as const,
          reason: EDIT_BLOCKED_REASON,
        }),
      ],
      unsupportedFeatures: Object.freeze([
        'source.save is owned by the host',
        'structural editing waits on SC2 Editor verification and the single writer path',
        'scene-at returns partial native state; visual preview needs resource resolution and the shared renderer, not Galaxy natives',
      ]),
      handlers: {
        'facial-at': async (input: unknown, options?: { signal?: AbortSignal }) => {
          if (input === null || typeof input !== 'object' || Array.isArray(input) ||
              Object.keys(input).some(key => key !== 'timeMs')) throw new TypeError('facial-at requires only { timeMs }')
          const timeMs = (input as { timeMs?: unknown }).timeMs
          assertCutsceneTime(timeMs)
          return { kind: 'json' as const, value: await world.facialAt(timeMs, options?.signal ?? context.signal) }
        },
        'scene-at': async (input: unknown) => {
          if (input === null || typeof input !== 'object' || Array.isArray(input) ||
              Object.keys(input).some(key => key !== 'timeMs')) throw new TypeError('scene-at requires only { timeMs }')
          const timeMs = (input as { timeMs?: unknown }).timeMs
          assertCutsceneTime(timeMs)
          compiled ??= compileCutscene(document, Number(context.budget.maxNodes ?? 100_000),
            Number(context.budget.maxDiagnostics ?? 1_000), { timeline, channels })
          return { kind: 'json' as const, value: {
            revision: String(context.input.revisions.revision), ...compiled.sceneAt(timeMs),
          } }
        },
        validate: async () => ({
          kind: 'json' as const,
          value: {
            findings,
            danglingReferences: report.danglingReferences.slice(0, 500),
            danglingReferenceTotal: report.danglingReferences.length,
            duplicateGuids: report.duplicateGuids,
            unknownTags: Object.fromEntries(report.unknownTags),
            widerThanUint64: report.widerThanUint64,
          },
        }),
        'export-raw': async () => ({ kind: 'bytes' as const, value: bytes.slice() }),
        timeline: async () => ({
          kind: 'json' as const,
          value: {
            timeUnit: timeline.timeUnit,
            length: timeline.length,
            masterSoundDuration: timeline.masterSoundDuration ?? null,
            approximateClips: timeline.approximateClips,
            unresolvedAnchors: timeline.unresolvedAnchors,
            cyclicAnchors: timeline.cyclicAnchors,
            clips: timeline.clips,
          },
        }),
        references: async () => {
          const facialResources = await world.facialResources(context.signal)
          return { kind: 'json' as const, value: { groups, includedCutscenes: included,
            facialResources } }
        },
        /*
         * Declared so the operation exists and can be asked about, and refused so nobody gets a
         * plausible answer. `operationStates` already reports it as dependency-required; this is
         * the same answer for a caller that invokes it anyway.
         */
        'edit-structure': async () => {
          throw new TypeError(EDIT_BLOCKED_REASON)
        },
      },
    }
  },
})

export const abiVersion = 1
export const allOperations = operations
export const createCodec = (context?: unknown) =>
  createInspectionCodec(definition as never, context as never)

/** Read and write back, for callers that want the round trip rather than the surfaces. */
export { decodeCutscene, encodeCutscene }
/** Native traversal shares the evaluator but remains independent of any clock or renderer. */
export { advanceCutscene } from './playback.js'
