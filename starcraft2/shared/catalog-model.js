/** Shared SC2 catalog asset naming, owned by SC2 data/resource semantics.
 * Maps and cutscenes use the same dependency-overlay paths and CModel variation rules.
 * It does not read files, resolve catalogs or convert models; Host owns those operations.
 */
const textField = value => typeof value === 'string' && value.length > 0 ? value : undefined

export function catalogAssetLogicalId(_entity, _fieldId, value) {
  // Catalog field provenance identifies the XML declaration that supplied the value; it does not
  // own the referenced asset. SC2 resolves game-logical paths through the complete dependency
  // overlay, where an inherited template in Core may name a model physically shipped by Liberty,
  // Swarm, Void, a map, or an asset-only override.
  const logicalId = textField(value)?.replace(/\\/gu, '/')
  if (logicalId === undefined) return undefined
  const folded = logicalId.toLowerCase()
  if (
    folded.startsWith('base.sc2assets/') ||
    folded.startsWith('mods/') ||
    folded.startsWith('campaigns/') ||
    folded.startsWith('maps/')
  ) {
    return logicalId
  }
  return `base.sc2assets/${logicalId}`
}

// A multi-variation model stores <Model>_NN.m3; a single variation keeps the authored file path.
export function modelVariationFor(model, object) {
  const variationCount = Number(model?.fields?.VariationCount)
  if (!Number.isSafeInteger(variationCount) || variationCount <= 1) return undefined
  const requested = Number.isSafeInteger(object.variation) ? object.variation : 0
  return Math.min(Math.max(requested, 0), variationCount - 1)
}

export function catalogModelVariationLogicalId(logicalId, variation) {
  if (variation === undefined) return logicalId
  const suffix = `_${String(variation).padStart(2, '0')}`
  return /\.m3$/iu.test(logicalId)
    ? logicalId.replace(/\.m3$/iu, `${suffix}.m3`)
    : `${logicalId}${suffix}`
}
