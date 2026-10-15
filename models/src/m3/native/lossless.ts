import type { M3Model } from './model.js'
import type { M3SectionList } from './binary/sections.js'

export interface M3SectionInventoryEntry {
  index: number
  tag: string
  version: number
  repetitions: number
  offset: number
  byteLength: number
}

export interface M3MetadataOracle {
  mdVersion?: number
  sectionCount?: number
  meshCount?: number
  materialCount?: number
  boneCount?: number
  animationCount?: number
}

export interface M3OracleMismatch {
  field: keyof M3MetadataOracle
  expected: number
  actual: number
}

export function serializeM3SectionList(sections: M3SectionList): Uint8Array {
  if (!sections.fileBuffer)
    throw new Error('M3SectionList has no original file buffer to serialize losslessly')
  return new Uint8Array(sections.fileBuffer.slice(0))
}

export function serializeM3Model(model: M3Model): Uint8Array {
  return serializeM3SectionList(model.sections)
}

export function getM3SectionInventory(sections: M3SectionList): M3SectionInventoryEntry[] {
  return sections.map((section, index) => {
    const repetitions = Number(section.indexEntry.repetitions ?? 0)
    const offset = Number(section.indexEntry.offset ?? 0)
    return {
      index,
      tag: section.desc.history.name,
      version: Number(section.indexEntry.version ?? 0),
      repetitions,
      offset,
      byteLength: section.rawBytes?.byteLength ?? 0,
    }
  })
}

export function m3MetadataOracle(model: M3Model): Required<M3MetadataOracle> {
  const render = model.toRenderModel()
  return {
    mdVersion: model.sections.mdVersion,
    sectionCount: model.sections.length,
    meshCount: render.meshes.length,
    materialCount: model.materials.length,
    boneCount: model.bones.length,
    animationCount: render.animations.length,
  }
}

export function compareM3MetadataOracle(
  model: M3Model,
  oracle: M3MetadataOracle,
): M3OracleMismatch[] {
  const actual = m3MetadataOracle(model)
  const mismatches: M3OracleMismatch[] = []
  for (const key of Object.keys(oracle) as Array<keyof M3MetadataOracle>) {
    const expected = oracle[key]
    if (expected === undefined) continue
    if (actual[key] !== expected) mismatches.push({ field: key, expected, actual: actual[key] })
  }
  return mismatches
}
