import { describe, expect, it } from 'vitest'
import type { M3Reference, M3StructureData, SectionResolver } from '../../dist/m3/native/types.js'
import { buildCameras } from '../../dist/m3/native/builder/metadata.js'

describe('M3 CAM_ metadata', () => {
  it('normalizes v2 static clip planes while retaining its animated camera fields', () => {
    const cameraRef = reference(1)
    const source = structure({ cameras: cameraRef })
    const camera = structure({
      bone: 4,
      field_of_view: anim(0.9),
      use_vertical_fov: 0,
      far_clip_static: 500,
      near_clip_static: 0.25,
      shadow_clip_distance: anim(40),
      focus_distance: anim(12),
      far_focus_range: anim(6),
      near_focus_range: anim(3),
      depth_of_field: anim(0.75),
    })

    expect(buildCameras(source, resolver(new Map([[cameraRef, [camera]]])))[0]).toMatchObject({
      name: 'Camera_0',
      boneIndex: 4,
      fieldOfView: 0.9,
      farClip: 500,
      nearClip: 0.25,
      shadowClipDistance: 40,
      focusDistance: 12,
      farFocusRange: 6,
      nearFocusRange: 3,
      depthOfField: 0.75,
      useVerticalFov: false,
    })
  })
})

function reference(index: number): M3Reference {
  return { entries: 1, index, flags: 0 } as M3Reference
}

function structure(values: Record<string, unknown>): M3StructureData {
  return values as unknown as M3StructureData
}

function anim(value: number): M3StructureData {
  return structure({ default: value })
}

function resolver(contents: Map<M3Reference, unknown[]>): SectionResolver {
  return {
    getSectionByReference: ref => {
      if (!ref) return null
      const content = contents.get(ref)
      return content ? ({ content } as never) : null
    },
  }
}
