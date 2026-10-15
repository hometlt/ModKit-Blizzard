/**
 * One filename for served SC2 documents in semantic analyses and mixed-language links.
 * Layer/path spelling and order are preserved; this module performs no parsing or source reads.
 */
/** Name the same native document identically in every served analysis cache. */
export const servedDocumentUri = (layerId, path) => `modkit-served-links://${encodeURIComponent(layerId)}/${path}`
