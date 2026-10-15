/** SC2 catalog XML: the raw entry model and its parser (data owns the catalog format). */
export { catalogFileOfElements, parseCatalogXml, parseCatalogXmlElements } from './parser.js'
export type {
  CatalogXmlElement,
  RawCatalogEntry,
  RawValue,
  RawObject,
  RawArray,
  RawFields,
  ParsedCatalogFile,
  EntrySource,
  EntrySpan,
  Sc2XmlParseOptions,
  TokenDecl,
} from './types.js'
