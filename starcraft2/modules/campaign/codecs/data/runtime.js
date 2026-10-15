import {
  createInspectionCodec,
  createTreeDataSource,
  editPlanFromInput,
  replaceBytes,
} from '@modkit/codec-kit'
import { createTableDataSource } from '../../../../shared/inspection/structured-text.js'
import {
  declareCampaignDataText,
  parseCampaignDataText,
  patchCampaignDataText,
} from '../../services/workspace.js'

const ID = 'blizzard/sc2-campaign-data'
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: false })

const operations = Object.freeze([
  Object.freeze({
    id: 'edit.content',
    handlerId: 'edit-campaign-data',
    mutatesSource: true,
    requiredPermissions: Object.freeze(['read-source', 'write-source']),
    outputKinds: Object.freeze(['edit-plan']),
  }),
  Object.freeze({
    id: 'edit.structure',
    handlerId: 'declare-campaign-data',
    mutatesSource: true,
    requiredPermissions: Object.freeze(['read-source', 'write-source']),
    outputKinds: Object.freeze(['edit-plan']),
  }),
])

function editOutput(context, originalBytes, change, operation) {
  return Object.freeze({
    kind: 'edit-plan',
    plan: editPlanFromInput(context.input, {
      planId: `${ID}:${context.input.revisions.revision}:${operation}`,
      edits: Object.freeze([
        replaceBytes(0, originalBytes.byteLength, encoder.encode(change.text), change.label),
      ]),
      fidelity: Object.freeze({
        roundTrip: 'byte-identical',
        preservesUnknownData: true,
        notes: Object.freeze(['Only the selected CCampaign XML declaration is changed.']),
      }),
    }),
  })
}

function campaignTree(campaigns) {
  return createTreeDataSource({
    kind: 'campaign-data',
    label: 'CampaignData',
    preview: `${campaigns.length} CCampaign declaration(s)`,
    children: campaigns.map(campaign => ({
      kind: 'campaign',
      label: campaign.id,
      preview: campaign.name ?? campaign.shortName ?? campaign.id,
      children: Object.entries(campaign)
        .filter(([key]) => !['id', 'sourcePath', 'launchMaps'].includes(key))
        .map(([key, value]) => ({
          kind: 'campaign-field',
          label: key,
          preview: Array.isArray(value) ? value.join(', ') : String(value),
        })),
    })),
  })
}

export const abiVersion = 1
export const createCodec = context => createInspectionCodec({
  id: ID,
  version: '1.0.0',
  format: Object.freeze({ id: 'sc2-campaign-data', label: 'StarCraft II CampaignData' }),
  operations,
  async detect(prefix, uri) {
    const text = decoder.decode(prefix)
    const campaignPath = /(?:^|[/?\\])campaigndata\.xml(?:$|[?&#])/iu.test(uri)
    const catalog = /<Catalog(?:\s|>)/u.test(text)
    const declaration = /<CCampaign(?:\s|>)/u.test(text)
    return Object.freeze({
      confidence: declaration ? 0.999 : campaignPath && catalog ? 0.998 : 0,
      kind: declaration ? 'structure' : 'context',
      note: declaration
        ? 'native-ccampaign-catalog'
        : campaignPath && catalog
          ? 'empty-campaign-data-catalog'
          : 'not-campaign-data',
    })
  },
  async inspect(bytes, inspectionContext) {
    const text = decoder.decode(bytes)
    const sourcePath = inspectionContext.primary.source.uri
    const campaigns = parseCampaignDataText(text, inspectionContext.budget, sourcePath)
    return Object.freeze({
      summary: Object.freeze({
        schemaVersion: 1,
        campaigns,
      }),
      metadata: Object.freeze([Object.freeze({
        id: 'campaign-data',
        label: 'CampaignData',
        entries: Object.freeze([
          Object.freeze({ key: 'campaigns', value: campaigns.length }),
          Object.freeze({ key: 'source', value: sourcePath }),
        ]),
      })]),
      traits: Object.freeze([
        Object.freeze({ id: 'content.text', parameters: Object.freeze({ language: 'xml' }) }),
        Object.freeze({ id: 'structure.hierarchy', parameters: Object.freeze({ campaigns: campaigns.length }) }),
        Object.freeze({ id: 'game.catalog', parameters: Object.freeze({ namespace: 'Campaign' }) }),
      ]),
      text,
      dataSources: Object.freeze({
        'common.view/tree-data-source': campaignTree(campaigns),
        'common.view/table-data-source': createTableDataSource(
          ['Id', 'Name', 'Launch map', 'Prerequisite', 'Source'],
          campaigns.map(campaign => [
            campaign.id,
            campaign.name ?? '',
            campaign.launchMap ?? '',
            campaign.prerequisiteCampaignId ?? '',
            campaign.sourcePath,
          ]),
        ),
      }),
      handlers: Object.freeze({
        'edit-campaign-data': async input => editOutput(
          inspectionContext,
          bytes,
          patchCampaignDataText(text, inspectionContext.budget, input, sourcePath),
          'edit',
        ),
        'declare-campaign-data': async input => editOutput(
          inspectionContext,
          bytes,
          declareCampaignDataText(text, inspectionContext.budget, input, sourcePath),
          'declare',
        ),
      }),
      maxDecodedBytes: inspectionContext.budget.maxScalarBytes,
      unsupportedFeatures: Object.freeze([
        'campaign-mission-order-is-scenario-defined',
        'campaign-data-file-creation-not-advertised',
      ]),
    })
  },
}, context)
