/**
 * The entities of a package — a mod, or a map's own Base.SC2Data — as subjects: its own listed,
 * any entity of its context opened through the catalog, the card drawn from the chain's values.
 *
 * Kept apart from the mod card so a map codec lends its entities without the resource tree.
 */
import type { AssetSourceRef, SubjectCatalogPort } from '@modkit/sdk'
import { entitySubjects } from '../../../../data/codecs/sc2data/src/entity-cards.js'
import { plainName } from '../../../shared/core/entities.js'
import { sc2NamespaceEntrySubjectId } from '../../../../../shared/package-namespace/runtime.js'
import type { ModCardInput } from './mod-card.js'

export function modEntitySelector(input: {
  readonly mod: ModCardInput['mod']
  readonly root: AssetSourceRef
  readonly revision: string
  readonly catalog?: SubjectCatalogPort
  readonly locale?: string
  readonly editOperation?: string
}) {
  return entitySubjects(input.mod as never, {
    snapshotId: input.revision,
    source: input.root,
    ...(input.editOperation === undefined ? {} : { editOperation: input.editOperation }),
    ...(input.catalog === undefined ? {} : { catalog: input.catalog }),
    nameOf: (namespace, id) => plainName(input.mod, input.locale ?? 'enUS', namespace, id),
    // The context names each layer by its address (`layerRoot`): a field opens in the layer's file.
    sourceOf: (rootId, file) => {
      if (!rootId.includes('://')) return undefined
      const uri = sc2NamespaceEntrySubjectId({ id: rootId, uri: rootId }, file)
      return { id: uri, uri }
    },
  })
}
