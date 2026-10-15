import { createSc2DirectoryCodec } from '../../../../shared/package-namespace/runtime.js'
import { campaignOperations, extendCampaignInspection } from '../../services/workspace.js'
import { sc2BuiltinDocumentInfo } from '../../../mod/shared/workspace/implicit-dependencies.js'

export const abiVersion = 1
export const createCodec = context =>
  createSc2DirectoryCodec(
    {
      id: 'blizzard/sc2-campaign',
      kind: 'campaign',
      formatId: 'sc2-campaign',
      displayName: 'StarCraft II campaign',
      topology: 'mpq-namespace',
      packed: true,
      virtualDocumentInfo: sc2BuiltinDocumentInfo,
      operations: campaignOperations('blizzard/sc2-campaign'),
      extendInspection: extendCampaignInspection,
    },
    context,
  )
