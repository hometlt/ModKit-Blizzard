import type { M3StructureData, M3Reference, SectionResolver } from '../types.js'
import { getSectionString } from './texture.js'

/**
 * Shared bone name resolver for all metadata builders.
 *
 * M3 metadata builders (lights, turrets, cameras, ribbons, particles, etc.)
 * all need to resolve a bone index to its human-readable name.  This class
 * centralises that lookup so the logic is not copy-pasted 15+ times across
 * builder/metadata.ts.
 */
export class BoneResolver {
  private readonly _boneData: M3StructureData[]
  private readonly _sections: SectionResolver

  constructor(sections: SectionResolver, model: M3StructureData) {
    const boneSection = sections.getSectionByReference(model.bones as M3Reference | undefined)
    this._boneData = (boneSection?.content ?? []) as M3StructureData[]
    this._sections = sections
  }

  /** Return the bone name for the given index, or a fallback like "Bone_5". */
  getName(index: number): string {
    if (index < 0 || index >= this._boneData.length) {
      return `Bone_${index}`
    }
    const bone = this._boneData[index]
    if (!bone) return `Bone_${index}`
    return getSectionString(this._sections, bone.name as M3Reference | null) || `Bone_${index}`
  }

  /** Return bone name, or a custom fallback if the index is out of range. */
  getNameOrFallback(index: number, fallback: string): string {
    if (index < 0 || index >= this._boneData.length || !this._boneData[index]) {
      return fallback
    }
    const name = getSectionString(this._sections, this._boneData[index].name as M3Reference | null)
    return name || fallback
  }

  /** Convenience: resolve bone index from a raw M3 structure field. */
  resolve(boneField: unknown): string {
    const index = typeof boneField === 'number' ? boneField : -1
    return this.getName(index)
  }
}
