// SPDX-License-Identifier: GPL-2.0-only
// The small RenderModel traversal needed by the M3 encoder, kept local so the Blizzard extension
// does not depend on the retired Modkit application packages at runtime.

export function listRenderModelTextureRequests(model) {
  const requests = []
  const seen = new Set()
  const materials = Array.isArray(model?.materials) ? model.materials : []
  for (let materialIndex = 0; materialIndex < materials.length; materialIndex += 1) {
    const material = materials[materialIndex]
    if (material === undefined || material === null) continue
    for (const layer of Array.isArray(material.layers) ? material.layers : []) {
      if (typeof layer?.path !== 'string' || layer.path.length === 0) continue
      const label = typeof layer.label === 'string' ? layer.label : 'texture'
      const key = `${materialIndex}:${label}:${layer.path.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      requests.push(Object.freeze({ path: layer.path, slot: label, materialIndex }))
    }
    const layers = material.standard?.layers
    if (typeof layers !== 'object' || layers === null) continue
    for (const [slot, layer] of Object.entries(layers)) {
      if (typeof layer?.texturePath !== 'string' || layer.texturePath.length === 0) continue
      const key = `${materialIndex}:${slot}:${layer.texturePath.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      requests.push(Object.freeze({ path: layer.texturePath, slot, materialIndex }))
    }
  }
  return requests
}
