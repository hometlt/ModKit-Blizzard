import { defineCodec, type CodecAuthoringSpec } from '@modkit/sdk/authoring'
import { contractId, traitId } from '@modkit/core'
import { createCodec, operations as implementedOperations } from './codec.js'

const runtime = createCodec()
const handler = async (): Promise<never> => { throw new Error('operation dispatch is owned by the opened codec session') }
const operations = [
  { id: 'view.inspect', handlerId: 'inspect', mutatesSource: false, requiredPermissions: ['read-source'], outputKinds: ['json'], handler },
  ...implementedOperations.map(operation => ({ ...operation, handler })),
] as CodecAuthoringSpec['operations']

export const limitations = Object.freeze([
  'Attribute writes replace exactly the bytes of one value, so comments, ordering and formatting survive; there is no whole-document serializer.',
  'References are resolved against the documents in the request workspace snapshot; a name declared further up the dependency chain is reported as inherited rather than broken.',
  'The element and attribute table is evidence from installed style sheets, not a published schema, so an unrecognized attribute is a warning.',
  'source.save remains disabled; edit.field returns a revision-pinned edit plan for host persistence.',
])
export const displayName = 'StarCraft II Style Sheet'
export const status = 'partial'

export const codec = defineCodec({
  id: 'blizzard/sc2-style', displayName: 'StarCraft II Style Sheet',
  format: { formatId: 'sc2-style', label: 'StarCraft II Style Sheet' }, roles: ['semantic'], topology: 'single', stages: ['authored'], intents: ['probe', 'inspect', 'full', 'export'],
  match: { extensions: ['sc2style'], pathGlobs: ['**/*.SC2Style'], signatures: [{ from: 'start', offset: 0, bytesHex: '3c5374796c6546696c65' }] },
  probe: { kind: 'bytes', ranges: [{ from: 'start', length: 4096 }], maxBytes: 4096, run: runtime.probe }, open: runtime.open, operations,
  representations: [{ id: 'style-sheet', contract: contractId('common.document/flow-metadata'), major: 1, stage: 'authored', lossy: false }],
  publishesDataSources: [
    { contract: 'common.view/text-data-source', major: 1 }, { contract: 'common.view/tree-data-source', major: 1 },
    { contract: 'common.view/table-data-source', major: 1 }, { contract: 'common.view/byte-range-source', major: 1 },
    { contract: 'common.view/subject-facts-source', major: 1 }, { contract: 'common.view/relation-graph-source', major: 1 },
  ],
  traitDeclarations: ['content.text', 'code.source', 'structure.hierarchy'].map(id => ({ presence: 'will-expose' as const, representation: 'source' as const, id: traitId(id) })),
  budgets: { maxInputBytes: 1_073_741_824n, maxDepth: 64, maxNodes: 100_000, maxScalarBytes: 104_857_600, maxDiagnostics: 1_000 }, implementationTier: { claimed: 1 },
  profile: 'explicit', permissions: ['read-source', 'write-source'], targets: [
    { variantId: 'trusted-node', environments: ['node'], entrypoint: './modules/style/codecs/style/runtime.js', executionProfile: 'trusted-in-process' },
    { variantId: 'portable', environments: ['browser-worker', 'node-worker'], entrypoint: './modules/style/codecs/style/runtime.js', executionProfile: 'worker-brokered' },
  ],
})
