/** A publication's locale document: the names Battle.net lists it under, one per string id. */
import { createInspectionCodec } from '@modkit/codec-kit'
import { createOpaqueXmlDefinition, opaqueXmlOperations } from '../../../../../map/shared/documents/opaque-xml-codec.js'

export const operations = opaqueXmlOperations
export const definition = createOpaqueXmlDefinition({
  id: 'blizzard/sc2-publication-locale',
  formatId: 'sc2-publication-locale',
  label: 'Publication locale',
  rootTag: 'Locale',
  pathPattern: /\.s2ml$/iu,
  invalidRootCode: 'blizzard.sc2-publication-locale/invalid-root',
})
export const abiVersion = 1
export const createCodec = (context?: unknown) => createInspectionCodec(definition, context as never)
