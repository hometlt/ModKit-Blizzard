/** SC2 cutscene manifest owner: inspection and provisional scene-at; native edits remain blocked.
 * Generates codec.json with the same operations used by the opened codec session.
 */
import { defineCodec, type CodecAuthoringSpec } from '@modkit/sdk/authoring'
import { contractId, traitId } from '@modkit/core'
import { createCodec, operations as implementedOperations } from './codec.js'

const runtime = createCodec()
const handler = async (): Promise<never> => { throw new Error('operation dispatch is owned by the opened codec session') }
const operations = implementedOperations.map(operation => ({ ...operation, handler })) as CodecAuthoringSpec['operations']

export const displayName = 'StarCraft II Cutscene'
export const status = 'partial'
export const limitations = Object.freeze([
  'Reading and byte-identical rewriting are complete for the shipped SC2 and Heroes of the Storm corpus.',
  'Structural editing stays dependency-required until edited files are verified in SC2 Editor through the single writer path.',
  'Resolved times mark anchors with an unmeasured attach point as approximate and the time unit as probable milliseconds.',
  'External names are published as relations; workspace mounts own reference resolution.',
  'scene-at returns partial native state without side effects; the world source adds CModel/RequiredAnims resources, sparse animation layers and provisional TargetCamera/model camera. facial-at publishes exact conversation/controller/Sound references and line clocks; FaceFX graph and bone binding, attachments, lighting, effects and playback UI remain incomplete.',
])

export const codec = defineCodec({
  id: 'blizzard/sc2-cutscene', displayName, format: { formatId: 'sc2-cutscene', label: displayName }, roles: ['semantic'], topology: 'single',
  stages: ['authored'], intents: ['probe', 'inspect', 'full', 'export'],
  match: { extensions: ['sc2cutscene', 'stormcutscene', 'sc2scene'], pathGlobs: ['**/*.SC2Cutscene', '**/*.StormCutscene', '**/*.SC2Scene'] },
  probe: { kind: 'bytes', ranges: [{ from: 'start', length: 4096 }], maxBytes: 4096, run: runtime.probe }, open: runtime.open, operations,
  representations: [{ id: 'cutscene-scene', contract: contractId('common.document/flow-metadata'), major: 1, stage: 'authored', lossy: false }],
  publishesDataSources: [
    { contract: 'common.view/world-scene-source', major: 1 },
    { contract: 'common.view/text-data-source', major: 1 }, { contract: 'common.view/tree-data-source', major: 1 },
    { contract: 'common.view/table-data-source', major: 1 }, { contract: 'common.view/byte-range-source', major: 1 },
    { contract: 'common.view/subject-facts-source', major: 1 }, { contract: 'common.view/relation-graph-source', major: 1 },
  ],
  traitDeclarations: ['content.text', 'structure.hierarchy', 'structure.nodes', 'source.dependencies'].map(id => ({ presence: 'will-expose' as const, representation: 'source' as const, id: traitId(id) })),
  budgets: { maxInputBytes: 1_073_741_824n, maxDepth: 64, maxNodes: 1_000_000, maxScalarBytes: 104_857_600, maxDiagnostics: 1_000 }, implementationTier: { claimed: 1 },
  profile: 'explicit', permissions: ['read-source', 'write-source'], targets: [
    { variantId: 'trusted-node', environments: ['node'], entrypoint: './modules/cutscene/codecs/cutscene/runtime.js', executionProfile: 'trusted-in-process' },
    { variantId: 'portable', environments: ['browser-worker', 'node-worker'], entrypoint: './modules/cutscene/codecs/cutscene/runtime.js', executionProfile: 'worker-brokered' },
  ],
})
