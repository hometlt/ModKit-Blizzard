// Static browser bridge; the frozen native implementation remains unchanged.
export { schemaText } from './schema.js'
export { M3SectionList } from '../../../dist/m3/native/binary/sections.js'
export {
  appendM3Section,
  appendM3ReferencedRecord,
  removeM3ReferencedRecord,
  replaceM3ReferencedRecords,
  pointM3ReferenceAtSection,
  serializeM3SectionGraph,
} from '../../../dist/m3/native/structural.js'
