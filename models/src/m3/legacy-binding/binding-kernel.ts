// Generated from immutable MK2 declarations. Change the strict adapter, not these algorithms.
// Source selection: models/m3-binding-extraction.json
import type { AnimatedScalar, AnimatedValueTracks, RenderMaterial, SequenceIndexedAnimationTrack, StandardLayerSlot, StandardMaterialLayer, StandardMaterialModel } from '@modkit/codec-kit/legacy/models'

interface M3MaterialTrackMerge {
  materials: RenderMaterial[]
  sourceTrackCount: number
  mergedTrackCount: number
}

function mergeM3MaterialAnimationTracks(
  base: readonly RenderMaterial[],
  bundle: readonly RenderMaterial[],
  sequenceOffset: number,
  bundleSequenceCount: number,
): M3MaterialTrackMerge {
  const materials = [...base]
  let sourceTrackCount = 0
  let mergedTrackCount = 0

  for (const [index, source] of bundle.entries()) {
    const sourceCount = countRenderMaterialTracks(source)
    sourceTrackCount += sourceCount
    if (sourceCount === 0) continue

    const target = materials[index]
    if (!target || !materialLayoutsCompatible(target, source)) continue

    const targetTrackCount = countRenderMaterialTracks(target)
    const merged = mergeRenderMaterialTracks(target, source, sequenceOffset, bundleSequenceCount)
    materials[index] = merged
    mergedTrackCount += Math.max(0, countRenderMaterialTracks(merged) - targetTrackCount)
  }

  return { materials, sourceTrackCount, mergedTrackCount }
}

function countRenderMaterialTracks(material: RenderMaterial): number {
  if (material.standard) return countStandardMaterialTracks(material.standard)
  if (!material.composite) return 0
  return material.composite.passes.reduce(
    (count, pass) =>
      countAnimatedTracks(pass.alphaFactor) + count + countStandardMaterialTracks(pass.material),
    0,
  )
}

function countStandardMaterialTracks(material: StandardMaterialModel): number {
  const materialTracks =
    countAnimatedTracks(material.parallaxHeight) +
    (material.normalBlendFactors ?? []).reduce(
      (count, factor) => count + countAnimatedTracks(factor),
      0,
    )
  return Object.values(material.layers).reduce(
    (count, layer) => count + (layer ? countLayerTracks(layer) : 0),
    materialTracks,
  )
}

function countLayerTracks(layer: StandardMaterialLayer): number {
  return (
    countAnimatedTracks(layer.constantColor) +
    countAnimatedTracks(layer.colorMultiply) +
    countAnimatedTracks(layer.colorAdd) +
    countAnimatedTracks(layer.alphaFactor) +
    countAnimatedTracks(layer.uvOffset) +
    countAnimatedTracks(layer.uvAngle) +
    countAnimatedTracks(layer.uvTiling) +
    countAnimatedTracks(layer.flipbook?.frame)
  )
}

function countAnimatedTracks(value: AnimatedValueTracks | undefined): number {
  return value?.sequenceTracks?.length ?? 0
}

function validBundleSequence(track: SequenceIndexedAnimationTrack, sequenceCount: number): boolean {
  return (
    Number.isInteger(track.sequenceIndex) &&
    track.sequenceIndex >= 0 &&
    track.sequenceIndex < sequenceCount
  )
}

function materialLayoutsCompatible(target: RenderMaterial, source: RenderMaterial): boolean {
  if (source.standard) {
    return !!target.standard && standardMaterialLayoutsCompatible(target.standard, source.standard)
  }
  if (source.composite) {
    const targetComposite = target.composite
    if (!targetComposite || targetComposite.passes.length !== source.composite.passes.length) {
      return false
    }
    return source.composite.passes.every((pass, index) => {
      const targetPass = targetComposite.passes[index]
      return !!targetPass && standardMaterialLayoutsCompatible(targetPass.material, pass.material)
    })
  }
  return false
}

function standardMaterialLayoutsCompatible(
  target: StandardMaterialModel,
  source: StandardMaterialModel,
): boolean {
  const targetSlots = Object.keys(target.layers).sort()
  const sourceSlots = Object.keys(source.layers).sort()
  if (
    targetSlots.length !== sourceSlots.length ||
    targetSlots.some((slot, index) => slot !== sourceSlots[index])
  ) {
    return false
  }
  return sourceSlots.every(slot => {
    const layerSlot = slot as StandardLayerSlot
    const targetLayer = target.layers[layerSlot]
    const sourceLayer = source.layers[layerSlot]
    return !!targetLayer && !!sourceLayer && layerLayoutsCompatible(targetLayer, sourceLayer)
  })
}

function layerLayoutsCompatible(
  target: StandardMaterialLayer,
  source: StandardMaterialLayer,
): boolean {
  return (
    target.slot === source.slot &&
    normalizeMaterialPath(target.texturePath) === normalizeMaterialPath(source.texturePath) &&
    target.uvSource === source.uvSource &&
    target.channels === source.channels &&
    target.op === source.op &&
    target.teamColorMode === source.teamColorMode &&
    target.invert === source.invert &&
    target.clampResult === source.clampResult &&
    target.wrapX === source.wrapX &&
    target.wrapY === source.wrapY &&
    !!target.constantColor === !!source.constantColor &&
    !!target.colorMultiply === !!source.colorMultiply &&
    !!target.colorAdd === !!source.colorAdd
  )
}

function flipbookLayoutsCompatible(
  target: StandardMaterialLayer['flipbook'],
  source: StandardMaterialLayer['flipbook'],
): boolean {
  return (
    Boolean(target) === Boolean(source) &&
    (!target || !source || (target.rows === source.rows && target.cols === source.cols))
  )
}

function normalizeMaterialPath(path: string | null): string | null {
  return path?.replace(/\\/g, '/').toLowerCase() ?? null
}

function mergeRenderMaterialTracks(
  target: RenderMaterial,
  source: RenderMaterial,
  sequenceOffset: number,
  bundleSequenceCount: number,
): RenderMaterial {
  if (target.standard && source.standard) {
    return {
      ...target,
      standard: mergeStandardMaterialTracks(
        target.standard,
        source.standard,
        sequenceOffset,
        bundleSequenceCount,
      ),
    }
  }
  if (target.composite && source.composite) {
    const sourceComposite = source.composite
    return {
      ...target,
      composite: {
        ...target.composite,
        passes: target.composite.passes.map((pass, index) => {
          const sourcePass = sourceComposite.passes[index]
          if (!sourcePass) return pass
          return {
            ...pass,
            material: mergeStandardMaterialTracks(
              pass.material,
              sourcePass.material,
              sequenceOffset,
              bundleSequenceCount,
            ),
            alphaFactor:
              mergeAnimatedTracks(
                pass.alphaFactor,
                sourcePass.alphaFactor,
                sequenceOffset,
                bundleSequenceCount,
              ) ?? pass.alphaFactor,
          }
        }),
      },
    }
  }
  return target
}

function mergeStandardMaterialTracks(
  target: StandardMaterialModel,
  source: StandardMaterialModel,
  sequenceOffset: number,
  bundleSequenceCount: number,
): StandardMaterialModel {
  const layers = { ...target.layers }
  for (const slot of Object.keys(source.layers) as StandardLayerSlot[]) {
    const targetLayer = target.layers[slot]
    const sourceLayer = source.layers[slot]
    if (!targetLayer || !sourceLayer) continue
    layers[slot] = mergeLayerTracks(targetLayer, sourceLayer, sequenceOffset, bundleSequenceCount)
  }
  const merged: StandardMaterialModel = { ...target, layers }
  const parallaxHeight = mergeAnimatedTracks(
    target.parallaxHeight,
    source.parallaxHeight,
    sequenceOffset,
    bundleSequenceCount,
    { value: 0 },
  )
  if (parallaxHeight) merged.parallaxHeight = parallaxHeight
  const normalBlendFactors = mergeNormalBlendFactorTracks(
    target.normalBlendFactors,
    source.normalBlendFactors,
    sequenceOffset,
    bundleSequenceCount,
  )
  if (normalBlendFactors) merged.normalBlendFactors = normalBlendFactors
  return merged
}

function mergeNormalBlendFactorTracks(
  target: StandardMaterialModel['normalBlendFactors'],
  source: StandardMaterialModel['normalBlendFactors'],
  sequenceOffset: number,
  bundleSequenceCount: number,
): StandardMaterialModel['normalBlendFactors'] {
  if (!target && !source) return undefined
  const defaults = [1, 0, 0, 0, 1, 0, 0, 0] as const
  const factor = (index: number): AnimatedScalar =>
    mergeAnimatedTracks(target?.[index], source?.[index], sequenceOffset, bundleSequenceCount, {
      value: defaults[index]!,
    }) ??
    target?.[index] ?? { value: defaults[index]! }
  return [factor(0), factor(1), factor(2), factor(3), factor(4), factor(5), factor(6), factor(7)]
}

function mergeLayerTracks(
  target: StandardMaterialLayer,
  source: StandardMaterialLayer,
  sequenceOffset: number,
  bundleSequenceCount: number,
): StandardMaterialLayer {
  const merged = { ...target }
  merged.constantColor = mergeAnimatedTracks(
    target.constantColor,
    source.constantColor,
    sequenceOffset,
    bundleSequenceCount,
  )
  merged.colorMultiply = mergeAnimatedTracks(
    target.colorMultiply,
    source.colorMultiply,
    sequenceOffset,
    bundleSequenceCount,
  )
  merged.colorAdd = mergeAnimatedTracks(
    target.colorAdd,
    source.colorAdd,
    sequenceOffset,
    bundleSequenceCount,
  )
  merged.alphaFactor = mergeAnimatedTracks(
    target.alphaFactor,
    source.alphaFactor,
    sequenceOffset,
    bundleSequenceCount,
    { value: 1 },
  )
  merged.uvOffset = mergeAnimatedTracks(
    target.uvOffset,
    source.uvOffset,
    sequenceOffset,
    bundleSequenceCount,
    { value: [0, 0] },
  )
  merged.uvAngle = mergeAnimatedTracks(
    target.uvAngle,
    source.uvAngle,
    sequenceOffset,
    bundleSequenceCount,
    { value: [0, 0, 0] },
  )
  merged.uvTiling = mergeAnimatedTracks(
    target.uvTiling,
    source.uvTiling,
    sequenceOffset,
    bundleSequenceCount,
    { value: [1, 1] },
  )

  if (
    target.flipbook &&
    source.flipbook &&
    flipbookLayoutsCompatible(target.flipbook, source.flipbook)
  ) {
    const frame = mergeAnimatedTracks(
      target.flipbook.frame,
      source.flipbook.frame,
      sequenceOffset,
      bundleSequenceCount,
    )
    if (frame) {
      merged.flipbook = {
        rows: target.flipbook.rows,
        cols: target.flipbook.cols,
        frame,
      }
    }
  }
  return merged
}

function mergeAnimatedTracks<T extends AnimatedValueTracks>(
  target: T | undefined,
  source: T | undefined,
  sequenceOffset: number,
  bundleSequenceCount: number,
  neutralTarget?: T,
): T | undefined {
  const externalTracks = source?.sequenceTracks?.filter(track =>
    validBundleSequence(track, bundleSequenceCount),
  )
  if (!source || !externalTracks?.length) return target
  const rebased = externalTracks.map(track => ({
    ...track,
    sequenceIndex: sequenceOffset + track.sequenceIndex,
  }))
  return {
    ...(target ?? neutralTarget ?? source),
    sequenceTracks: [...(target?.sequenceTracks ?? []), ...rebased],
  } as T
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase()
}

function normalizedPathStem(
  value: string,
  extension: RegExp,
): { directory: string; stem: string } | null {
  const normalized = normalizePath(value)
    .replace(/^[a-z]:/, '')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
  const slash = normalized.lastIndexOf('/')
  const filename = slash === -1 ? normalized : normalized.slice(slash + 1)
  if (!extension.test(filename)) return null
  const stem = filename.replace(extension, '').normalize('NFKC')
  if (!stem) return null
  return {
    directory: slash === -1 ? '' : normalized.slice(0, slash),
    stem,
  }
}

function hasSiblingStemAssociation(basePath: string, sidecarPath: string): boolean {
  const base = normalizedPathStem(basePath, /\.m3$/i)
  const sidecar = normalizedPathStem(sidecarPath, /\.m3a$/i)
  if (!base || !sidecar || !sidecar.stem.startsWith(base.stem)) return false
  // Resolver listings may return a basename for files already scoped to the
  // model directory. Otherwise both paths must identify the same directory.
  return sidecar.directory === '' || base.directory === sidecar.directory
}

function m3AnimationBundlePattern(basePath: string): string {
  const base = normalizedPathStem(basePath, /\.m3$/i)
  return base ? `${base.stem}*.m3a` : '*.m3a'
}

export { mergeM3MaterialAnimationTracks, countRenderMaterialTracks, hasSiblingStemAssociation, m3AnimationBundlePattern }
