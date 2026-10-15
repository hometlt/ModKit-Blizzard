/**
 * Service-provider entrypoint for the `sc2-data` language services.
 *
 * The analysis lives in `language.ts`, which adapts the ported MK2 library. This file used to hold
 * 892 lines that re-derived completion, hover, definition, references, rename and diagnostics
 * beside that library — two implementations of the same rules, of which the smaller one ran. It is
 * now only the contribution boundary the host resolves through, matching every other SC2 language
 * provider.
 */
import { LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT } from '@modkit/sdk/language'
import {
  SC2_MIXED_WORKSPACE_LANGUAGE_IDS,
  createSc2WorkspaceLinkIndex,
} from '@modkit/blizzard-starcraft2/galaxy/sc2-workspace-links'
import {
  createSc2DataLanguageProvider,
  SC2_DATA_LANGUAGE_ID,
} from '../../../../dist/modules/data/providers/language/src/language.js'
import { SC2_ENTITY_ID } from '../../../../dist/shared/language/entity-id.js'
import { referenceTargetAt } from '@modkit/blizzard-starcraft2/data/references'
import { servedLanguageFeature } from '../../../../shared/language/served-feature.js'
import { servedRenameFeature } from '../../../../shared/language/served-rename.js'
import { servedProjectDiagnostics } from '../../../../shared/language/served-project-diagnostics.js'

export const abiVersion = 1
export const provides = Object.freeze([LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT])

export function createProvider(selection, context) {
  if (selection.contract !== LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT || selection.major !== 1) {
    throw new TypeError(
      `Unsupported SC2 data language selection ${selection.contract}@${selection.major}`,
    )
  }
  // The loaded mod's server answers this provider's features through the host's port (07.10).
  const provider = createSc2DataLanguageProvider(
    context?.modContexts === undefined ? {} : { modContexts: context.modContexts },
  )
  return Object.freeze({
    value: Object.freeze({
      ...provider,
      completion: async request => context?.modContexts !== undefined && request.workspaceContext?.modContext?.document !== undefined &&
        !(await provider.modContextCompletionApplies(request)) ? servedLanguageFeature(request, context.modContexts, 'completion') : provider.completion(request),
      definition: async request => context?.modContexts !== undefined && request.workspaceContext?.modContext?.document !== undefined &&
        !(await provider.modContextFeatureApplies({ ...request, feature: 'definition' })) ? servedLanguageFeature(request, context.modContexts, 'definition') : provider.definition(request),
      ...(context?.modContexts === undefined ? {} : { modContextCompletionApplies: () => true, modContextFeatureApplies: () => true }),
      ...Object.fromEntries(['workspaceSymbols', 'codeLenses', 'codeActions'].map(feature => [feature, request =>
        context?.modContexts !== undefined && request.workspaceContext?.modContext?.document !== undefined
          ? servedLanguageFeature(request, context.modContexts, feature) : provider[feature](request)])),
      references: request => context?.modContexts !== undefined && request.workspaceContext?.modContext?.document !== undefined
        ? provider.references(request) : referencesAcrossLanguages(provider, request),
      rename: request => context?.modContexts !== undefined && request.workspaceContext?.modContext?.document !== undefined
        ? servedRenameFeature(request, context.modContexts, 'rename') : renameAcrossLanguages(provider, request),
      prepareRename: request => context?.modContexts !== undefined && request.workspaceContext?.modContext?.document !== undefined
        ? servedRenameFeature(request, context.modContexts, 'prepareRename') : provider.prepareRename(request),
      ...(context?.modContexts === undefined ? {} : { modContextFeatures: Object.freeze([...provider.modContextFeatures, 'rename', 'prepareRename', 'projectDiagnostics', 'workspaceSymbols', 'codeLenses', 'codeActions']),
        projectDiagnostics: request => servedProjectDiagnostics(request, context.modContexts) }),
      languageIds: Object.freeze([SC2_DATA_LANGUAGE_ID]),
      /*
       * Kept from the previous provider: GameData links reach into Galaxy and the other SC2
       * languages, so the host is told this provider can read those documents in a mixed workspace
       * snapshot. Dropping it would silently narrow what cross-language navigation can see.
       */
      workspaceLanguageIds: SC2_MIXED_WORKSPACE_LANGUAGE_IDS,
      // Syntax-only outline; other features still need the mod server and/or mixed documents.
      documentLocalFeatures: Object.freeze(['documentSymbols', 'prepareRename', 'documentColors', 'colorPresentations', 'formatting']),
    }),
    release: async () => undefined,
  })
}

/*
 * The feature functions, by name.
 *
 * The 892-line provider this file replaced exported one function per feature, and the mixed-language
 * suite calls those directly rather than through the contract — deliberately, because what it checks
 * is that a Galaxy, TriggerData, Layout and GameData request all land on the same catalog. Keeping
 * the names is what lets the adapter be a drop-in replacement; they delegate rather than reimplement,
 * so there is still one set of rules.
 */
const shared = createSc2DataLanguageProvider()

/**
 * References, extended across the languages that name catalog entities.
 *
 * The library answers what GameData itself says; a Galaxy call to `UnitCreate(…, "Marine", …)` and a
 * TriggerData game link are usages too, and a modder renaming an entity needs to see them. Which
 * strings in those files are proven references is the workspace-link index's knowledge, shared with
 * the Galaxy and Layout providers, so this merges rather than re-deriving it — and stays incomplete
 * when the index says the snapshot was.
 */
async function referencesAcrossLanguages(provider, request) {
  const own = await provider.references(request)
  const crossLinks = createSc2WorkspaceLinkIndex(request)
  // The Data owner can identify the target while an XML tag is still being typed.
  // A strict mixed-index parse must not hide proven usages in the other languages.
  const target = referenceTargetAt(request.document.text, offsetOf(request.document.text, request.position))
  const cross = target === undefined ? [] : crossLinks.referencesTo(
    target.namespace, target.id, request.includeDeclaration === true,
  )
  const merged = [
    ...new Map([...own.locations, ...cross].map(item => [JSON.stringify(item), item])).values(),
  ]
  return Object.freeze({
    locations: Object.freeze(merged.slice(0, request.maxResults)),
    isIncomplete:
      own.isIncomplete ||
      merged.length > request.maxResults ||
      (cross.length > 0 && crossLinks.isIncomplete),
  })
}

/**
 * Rename, extended the same way. GameData's own occurrences are the library's; the usages in every
 * other SC2 language — Galaxy, TriggerData, Layout, Strings, a map's Objects and Preload — come from
 * the workspace-link index, and a rename that reaches them on a partial snapshot is refused.
 */
export async function renameAcrossLanguages(provider, request, heldLinks) {
  const own = await provider.rename(request)
  if (own === undefined) return undefined
  const links = heldLinks ?? createSc2WorkspaceLinkIndex(request)
  // A partial graph cannot prove that the entity has no users outside its indexed documents.
  if (links.isIncomplete) return undefined
  const target = links.targetAt(
    request.document.uri,
    offsetOf(request.document.text, request.position),
  )
  if (target === undefined) return own
  const documents = [request.document, ...request.workspaceDocuments]
  const catalogUris = new Set(
    documents.filter(document => document.languageId === 'sc2-data').map(document => document.uri),
  )
  const cross = links
    .referencesTo(target.namespace, target.entityId)
    .filter(location => !catalogUris.has(location.uri))
  if (cross.length === 0) return own
  // The provider already refused a name GameData cannot hold (`SC2_ENTITY_ID`); one rule for both.
  if (links.isIncomplete || !SC2_ENTITY_ID.test(request.newName)) return undefined
  const changes = new Map(own.documentChanges.map(change => [change.uri, [...change.edits]]))
  for (const location of cross)
    changes.set(location.uri, [
      ...(changes.get(location.uri) ?? []),
      { range: location.range, newText: request.newName },
    ])
  const total = [...changes.values()].reduce((sum, edits) => sum + edits.length, 0)
  if (total > request.maxEdits) return undefined
  const versions = new Map(documents.map(document => [document.uri, document.version]))
  return Object.freeze({
    documentChanges: Object.freeze(
      [...changes.entries()].map(([uri, edits]) =>
        Object.freeze({ uri, documentVersion: versions.get(uri), edits: Object.freeze(edits) }),
      ),
    ),
    isComplete: true,
  })
}

/** The contract counts lines and characters; the link index counts bytes from the start. */
function offsetOf(text, position) {
  let offset = 0
  for (let line = 0; line < position.line; line += 1) {
    const next = text.indexOf('\n', offset)
    if (next < 0) return text.length
    offset = next + 1
  }
  return Math.min(text.length, offset + position.character)
}

export const analyzeSc2Data = request => shared.analyze(request)
export const sc2DataCompletion = request => shared.completion(request)
export const sc2DataHover = request => shared.hover(request)
export const sc2DataDefinition = request => shared.definition(request)
export const sc2DataReferences = request => referencesAcrossLanguages(shared, request)
export const sc2DataRename = request => renameAcrossLanguages(shared, request)
export const sc2DataDocumentSymbols = request => shared.documentSymbols(request)
export const sc2DataDiagnostics = request => shared.diagnostics(request)
