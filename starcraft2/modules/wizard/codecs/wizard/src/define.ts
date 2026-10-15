import { defineCodec, type CodecAuthoringSpec } from '@modkit/sdk/authoring'
import { contractId, traitId } from '@modkit/core'
import { createCodec, operations as implementedOperations } from './codec.js'

const runtime = createCodec()
const handler = async (): Promise<never> => { throw new Error('operation dispatch is owned by the opened codec session') }
const operations = [
  { id: 'view.inspect', handlerId: 'inspect', mutatesSource: false, requiredPermissions: ['read-source'], outputKinds: ['json'], handler },
  ...implementedOperations.map(operation => ({ ...operation, handler })),
] as CodecAuthoringSpec['operations']

export const displayName = 'StarCraft II Data Wizard'
export const status = 'partial'
export const limitations = Object.freeze([
  'The format follows Blizzard’s shipped FileFormat specification; the game ships no wizard documents, so fixtures are spec-derived plus a nine-file author-written corpus read in place.',
  'Catalog ref evaluation requires loaded SC2 data and fails closed when that dependency is absent.',
  'Catalog, entry-type and field-path checks require a host-provided schema.',
  'Unknown elements and attributes are preserved and reported as information.',
  'edit.field returns a revision-pinned edit plan that replaces exactly one existing value (input default, item value or text, macro text, named condition value, entry field value); it never adds, removes or reorders elements, and source.save remains owned by the host.',
])

export const codec = defineCodec({
  id: 'blizzard/sc2-wizard', displayName, format: { formatId: 'sc2-wizard', label: displayName }, roles: ['semantic'], topology: 'single',
  stages: ['authored'], intents: ['probe', 'inspect', 'full', 'export'],
  match: { extensions: ['blizwiz'], pathGlobs: ['**/*.BlizWiz', '**/EditorWizards/**'] },
  companions: [{ id: 'embedded-wizards', role: 'wizard', required: false, patterns: ['*.BlizWiz'], searchScopes: ['current-mount', 'workspace-dependency-layer'] }],
  probe: { kind: 'bytes', ranges: [{ from: 'start', length: 4096 }], maxBytes: 4096, run: runtime.probe }, open: runtime.open, operations,
  representations: [{ id: 'wizard-file', contract: contractId('common.document/flow-metadata'), major: 1, stage: 'authored', lossy: false }],
  publishesDataSources: [
    { contract: 'common.view/text-data-source', major: 1 }, { contract: 'common.view/tree-data-source', major: 1 },
    { contract: 'common.view/table-data-source', major: 1 }, { contract: 'common.view/byte-range-source', major: 1 },
    { contract: 'common.view/subject-facts-source', major: 1 }, { contract: 'common.view/relation-graph-source', major: 1 },
  ],
  traitDeclarations: ['content.text', 'structure.hierarchy', 'content.metadata'].map(id => ({ presence: 'will-expose' as const, representation: 'source' as const, id: traitId(id) })),
  budgets: { maxInputBytes: 1_073_741_824n, maxDepth: 64, maxNodes: 100_000, maxScalarBytes: 104_857_600, maxDiagnostics: 1_000 }, implementationTier: { claimed: 1 },
  profile: 'explicit', permissions: ['read-source', 'write-source'], targets: [
    { variantId: 'trusted-node', environments: ['node'], entrypoint: './modules/wizard/codecs/wizard/runtime.js', executionProfile: 'trusted-in-process' },
    { variantId: 'portable', environments: ['browser-worker', 'node-worker'], entrypoint: './modules/wizard/codecs/wizard/runtime.js', executionProfile: 'worker-brokered' },
  ],
})
