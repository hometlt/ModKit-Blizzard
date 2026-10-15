/**
 * Map preview preparation for Warcraft III (`common.map/preview-preparation`): a map opened as
 * `blizzard/war3-map` is one package over the game's installation. The workspace has the map (the
 * opened subject's namespace, its root) above the game (the installation's one tree, `local:warcraft3`
 * at its root), so a map's own `Units/*.slk` or imported model stands in front of the game's. The
 * host resolves the game root through the content sources, which open the map inside the
 * installation (`openModContext`); no path to the installation is named here.
 */
import type {
  MapPreviewPreparationDiagnostic,
  MapPreviewPreparationRequest,
  MapPreviewPreparationResult,
} from '@modkit/sdk/maps'
import { WAR3_GAME_ID } from './world.js'

export const WAR3_MAP_PREVIEW_ID = 'blizzard.warcraft3.map-preview'
const SUBJECT_FORMAT_IDS = Object.freeze(['war3-map'])
/** The host resolver a map preview over an installation names, as StarCraft II's does. */
const INSTALLATION_RESOURCE_RESOLVER_ID = 'modkit.node/game-installation-resource-map-preview'

const diagnostic = (severity: MapPreviewPreparationDiagnostic['severity'], code: string, message: string): MapPreviewPreparationDiagnostic =>
  Object.freeze({ severity, code: `blizzard.warcraft3/${code}`, message })

export async function prepareWar3MapPreview(request: MapPreviewPreparationRequest): Promise<MapPreviewPreparationResult> {
  request.signal?.throwIfAborted()
  const subject = request.subject
  if (!SUBJECT_FORMAT_IDS.includes(subject.formatId))
    return Object.freeze({
      state: 'not-applicable' as const,
      diagnostics: Object.freeze([diagnostic('information', 'map-preview-format-not-applicable', `Warcraft III map preparation does not inspect ${subject.formatId}`)]),
    })
  // The map codec recognised war3map.w3i already, by listing or by the hash table of a map that lists
  // no names; its namespace root is the map.
  const displayName = subject.subjectUri.split(/[\\/]/u).at(-1) ?? 'map'
  return Object.freeze({
    state: 'prepared' as const,
    plan: Object.freeze({
      schemaVersion: 1 as const,
      workspace: Object.freeze({
        workspaceId: `warcraft3-map-preview:${subject.revision}`,
        gameId: WAR3_GAME_ID,
        activeRootId: 'map',
        sources: Object.freeze([
          Object.freeze({ sourceId: 'warcraft3-opened-map', kind: 'war3-map-subject', location: 'map-preview:opened-subject' }),
          Object.freeze({ sourceId: 'local:warcraft3', kind: 'warcraft3-installation', location: 'content-source:local:warcraft3' }),
        ]),
        roots: Object.freeze([
          Object.freeze({
            rootId: 'map',
            sourceId: 'warcraft3-opened-map',
            // The host confines the map's reads below its root: the opened namespace answers `map/…`.
            sourcePath: 'map',
            displayName: decodeURIComponent(displayName),
            kind: 'map',
            dependencies: Object.freeze([Object.freeze({ targetRootId: 'game', ref: 'Warcraft III', required: true, provenance: 'implicit' as const })]),
          }),
          Object.freeze({ rootId: 'game', sourceId: 'local:warcraft3', sourcePath: '', displayName: 'Warcraft III', kind: 'installation', dependencies: Object.freeze([]) }),
        ]),
        maxRoots: 2,
        maxDepth: 2,
      }),
      resources: Object.freeze({
        schemaVersion: 1 as const,
        strategy: 'host-resolved' as const,
        resolverId: INSTALLATION_RESOURCE_RESOLVER_ID,
        subjectNamespaceRoots: Object.freeze([Object.freeze({ rootId: 'map', namespacePrefix: '' })]),
        roots: Object.freeze([
          Object.freeze({
            rootId: 'game',
            locator: Object.freeze({
              schemaVersion: 1,
              kind: 'game-installation-subject',
              gameId: WAR3_GAME_ID,
              relativePaths: Object.freeze(['war3.mpq']),
              namespaceFallbackPrefix: '',
              openedSubjectPolicy: 'installation-only',
            }),
          }),
        ]),
      }),
    }),
    diagnostics: Object.freeze([]),
  })
}

export const abiVersion = 1
export const provides = Object.freeze(['common.map/preview-preparation'])

export function createProvider(selection: { readonly contract: string; readonly major: number }) {
  if (selection.contract !== 'common.map/preview-preparation' || selection.major !== 1)
    throw new TypeError(`unsupported Warcraft III map preview selection ${selection.contract}@${String(selection.major)}`)
  return Object.freeze({
    value: Object.freeze({
      contract: 'common.map/preview-preparation' as const,
      preparationId: WAR3_MAP_PREVIEW_ID,
      subjectFormatIds: SUBJECT_FORMAT_IDS,
      prepare: prepareWar3MapPreview,
    }),
    release: async () => undefined,
  })
}
