/** A matchmaking queue's locale table (`.s2ql`): its name, short name and description, one per string id. */
import { createInspectionCodec } from '@modkit/codec-kit'
import { createOpaqueXmlDefinition, opaqueXmlOperations } from '../../../../../map/shared/documents/opaque-xml-codec.js'

export const operations = opaqueXmlOperations
export const definition = createOpaqueXmlDefinition({
  id: 'blizzard/sc2-queue-locale',
  formatId: 'sc2-queue-locale',
  label: 'Queue locale table',
  // Unlike a map's `.s2ml` (`<Locale region=…>`), the queue tables have a lower-case root.
  rootTag: 'locale',
  pathPattern: /\.s2ql$/iu,
  invalidRootCode: 'blizzard.sc2-queue-locale/invalid-root',
})
export const abiVersion = 1
export const createCodec = (context?: unknown) => createInspectionCodec(definition, context as never)
