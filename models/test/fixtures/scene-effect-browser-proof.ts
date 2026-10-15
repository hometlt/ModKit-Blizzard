import { renderBrowser } from '../../../../modkit-core/packages/scene/src/render/browser.js'
import { renderHeadless } from '../../../../modkit-core/packages/scene/src/render/headless.js'
import type { SceneRenderRequest } from '@modkit/sdk/renderer'

/** Actual WebGL and CPU providers: no native shader or operation-output reconstruction. */
export async function proveSceneEffectBrowserPixels() {
  const identity = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)
  const cases = [
    {
      angle: 0,
      threshold: 0,
      expected: [0, 0, 255, 255, 255, 255, 255, 255, 255, 0, 0, 255, 0, 255, 0, 255],
    },
    {
      angle: Math.PI / 2,
      threshold: 2,
      expected: [255, 255, 255, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 0, 0, 255],
    },
    {
      angle: 0,
      threshold: 3,
      expected: [255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255],
    },
  ]
  const frames: number[][] = []
  for (const item of cases) {
    const request: SceneRenderRequest = {
      outputKind: 'rgba8',
      viewport: { width: 2, height: 2 },
      camera: { viewProjection: identity },
      scene: {
        materials: [
          {
            id: 'effect',
            baseColor: [1, 1, 1, 1],
            baseColorTexture: 'grid',
            simpleEffect: {
              blend: 'opaque',
              depthTest: true,
              depthWrite: true,
              doubleSided: true,
              alphaCutoff: 0,
              wrapU: 'clamp',
              wrapV: 'clamp',
              screenUv: {
                angle: item.angle,
                threshold: item.threshold,
                offset: [0, 0],
                tiling: [1, 1],
              },
            },
          },
        ],
        textures: [
          {
            id: 'grid',
            width: 2,
            height: 2,
            rgba: Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255),
          },
        ],
        primitives: [
          {
            id: 'quad',
            materialId: 'effect',
            topology: 'triangles',
            positions: Float32Array.of(-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0),
            indices: Uint32Array.of(0, 1, 2, 0, 2, 3),
          },
        ],
      },
    }
    const gpu = await renderBrowser(request),
      cpu = await renderHeadless(request)
    if (
      gpu.rgba.length !== item.expected.length ||
      cpu.rgba.length !== item.expected.length ||
      !item.expected.every((value, index) => gpu.rgba[index] === value && cpu.rgba[index] === value)
    )
      throw new Error(
        `effect screen UV provider pixels differ: ${JSON.stringify({ angle: item.angle, threshold: item.threshold, expected: item.expected, gpu: [...gpu.rgba], cpu: [...cpu.rgba] })}`,
      )
    frames.push([...gpu.rgba])
  }
  const lightCases = [
    {
      light: { type: 'directional', direction: [0, 0, 1], color: [1, 0.5, 0.25] },
      expected: [255, 128, 64, 255],
    },
    {
      light: {
        type: 'point',
        direction: [0, 0, 1],
        color: [1, 0.5, 0.25],
        position: [0, 0, 2],
        attenuationStart: 0,
        attenuationEnd: 4,
        decayExponent: 2,
      },
      expected: [64, 32, 16, 255],
    },
    {
      light: {
        type: 'spot',
        direction: [0, 0, 1],
        color: [1, 0.5, 0.25],
        position: [0, 0, 2],
        innerConeAngle: 0.5,
        outerConeAngle: 1,
      },
      expected: [0, 0, 0, 255],
    },
  ] as const
  for (const item of lightCases) {
    const request: SceneRenderRequest = {
      outputKind: 'rgba8',
      viewport: { width: 1, height: 1 },
      camera: { viewProjection: identity },
      scene: {
        lights: [item.light],
        materials: [{ id: 'light', baseColor: [1, 1, 1, 1], shading: 'lambert' }],
        primitives: [
          {
            id: 'quad',
            materialId: 'light',
            topology: 'triangles',
            positions: Float32Array.of(-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0),
            normals: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1),
            indices: Uint32Array.of(0, 1, 2, 0, 2, 3),
          },
        ],
      },
    }
    const gpu = await renderBrowser(request),
      cpu = await renderHeadless(request)
    if (
      !item.expected.every((value, index) => gpu.rgba[index] === value && cpu.rgba[index] === value)
    )
      throw new Error(
        `preview light pixels differ: ${JSON.stringify({ type: item.light.type, expected: item.expected, gpu: [...gpu.rgba], cpu: [...cpu.rgba] })}`,
      )
    const tint = [0.5, 0.25, 1, 1] as const
    const tinted: SceneRenderRequest = {
      ...request,
      scene: {
        ...request.scene,
        primitives: request.scene.primitives.map(primitive => ({ ...primitive, tint })),
      },
    }
    const tintedGpu = await renderBrowser(tinted),
      tintedCpu = await renderHeadless(tinted)
    const expectedTint = item.expected.map((component, axis) =>
      Math.round(component * (tint[axis] ?? 1)),
    )
    if (
      !expectedTint.every(
        (value, index) => tintedGpu.rgba[index] === value && tintedCpu.rgba[index] === value,
      )
    )
      throw new Error(
        `instance tint CPU/GPU mismatch: ${JSON.stringify({ expectedTint, gpu: [...tintedGpu.rgba], cpu: [...tintedCpu.rgba] })}`,
      )
  }
  const vertexColorRequest: SceneRenderRequest = {
    outputKind: 'rgba8',
    viewport: { width: 1, height: 1 },
    camera: { viewProjection: identity },
    scene: {
      materials: [{ id: 'color', baseColor: [0.5, 0.5, 0.5, 0.5], alphaMode: 'blend' }],
      primitives: [
        {
          id: 'quad',
          materialId: 'color',
          topology: 'triangles',
          positions: Float32Array.of(-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0),
          colors: Float32Array.of(
            1,
            0.5,
            0.25,
            0.5,
            1,
            0.5,
            0.25,
            0.5,
            1,
            0.5,
            0.25,
            0.5,
            1,
            0.5,
            0.25,
            0.5,
          ),
          indices: Uint32Array.of(0, 1, 2, 0, 2, 3),
        },
      ],
    },
  }
  const vertexColorExpected = [128, 64, 32, 64]
  const vertexColorGpu = await renderBrowser(vertexColorRequest)
  const vertexColorCpu = await renderHeadless(vertexColorRequest)
  if (
    !vertexColorExpected.every(
      (value, index) =>
        vertexColorGpu.rgba[index] === value && vertexColorCpu.rgba[index] === value,
    )
  )
    throw new Error(
      `base-color vertex RGBA provider pixels differ: ${JSON.stringify({ expected: vertexColorExpected, gpu: [...vertexColorGpu.rgba], cpu: [...vertexColorCpu.rgba] })}`,
    )
  const materialLayer = (slot: string, texturePath: string, channels: number) => ({
    slot,
    texturePath,
    uvSource: 0,
    channels,
    op: 6,
    teamColorMode: 0,
    invert: false,
    clampResult: true,
    wrapX: true,
    wrapY: true,
  })
  const standardMaterialRequest: SceneRenderRequest = {
    outputKind: 'rgba8',
    viewport: { width: 1, height: 1 },
    camera: { viewProjection: identity },
    scene: {
      materialContext: { teamColor: [1, 0.5, 0] },
      materials: [
        {
          id: 'm3-standard',
          baseColor: [1, 0, 1, 1],
          shader: {
            id: 'modkit.render-material.v1',
            parameters: {
              renderModel: {
                version: 1,
                standard: {
                  layers: {
                    diffuse: materialLayer('diffuse', 'diffuse.dds', 1),
                    teamColorMask: materialLayer('teamColorMask', 'team.dds', 3),
                  },
                  blendMode: 0,
                  priority: 0,
                  specularity: 0,
                  specMult: 1,
                  emisMult: 1,
                  specMode: 0,
                  alphaTestThreshold: 0,
                  twoSided: true,
                  unshaded: true,
                  doubleLambert: false,
                  clampOutput: true,
                  usesVertexColor: false,
                  usesVertexAlpha: false,
                },
              },
            },
          },
          textureBindings: [
            { resourceId: 'diffuse.dds', textureId: 'diffuse' },
            { resourceId: 'team.dds', textureId: 'team' },
          ],
        },
      ],
      textures: [
        {
          id: 'diffuse',
          width: 1,
          height: 1,
          rgba: Uint8Array.of(64, 128, 191, 255),
          filter: 'nearest',
        },
        {
          id: 'team',
          width: 1,
          height: 1,
          rgba: Uint8Array.of(128, 255, 255, 255),
          filter: 'nearest',
        },
      ],
      primitives: [
        {
          id: 'quad',
          materialId: 'm3-standard',
          topology: 'triangles',
          positions: Float32Array.of(-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0),
          normals: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1),
          tangents: Float32Array.of(1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1),
          textureCoordinates: Float32Array.of(0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5),
          indices: Uint32Array.of(0, 1, 2, 0, 2, 3),
        },
      ],
    },
  }
  const standardMaterialGpu = await renderBrowser(standardMaterialRequest)
  const standardMaterialCpu = await renderHeadless(standardMaterialRequest)
  if (
    standardMaterialGpu.rgba.length !== standardMaterialCpu.rgba.length ||
    !standardMaterialCpu.rgba.every((value, index) => standardMaterialGpu.rgba[index] === value) ||
    standardMaterialGpu.rgba[1] === 0
  )
    throw new Error(
      `M3 standard-material CPU/GPU pixels differ or fell back: ${JSON.stringify({ gpu: [...standardMaterialGpu.rgba], cpu: [...standardMaterialCpu.rgba], gpuDiagnostics: standardMaterialGpu.diagnostics, cpuDiagnostics: standardMaterialCpu.diagnostics })}`,
    )
  return {
    provider: 'modkit.browser-webgl',
    cases: frames.length,
    exactFrames: frames,
    lightCases: lightCases.length,
    tintCases: lightCases.length,
    vertexColor: {
      expected: vertexColorExpected,
      gpu: [...vertexColorGpu.rgba],
      cpu: [...vertexColorCpu.rgba],
    },
    standardMaterial: {
      gpu: [...standardMaterialGpu.rgba],
      cpu: [...standardMaterialCpu.rgba],
      gpuDiagnostics: standardMaterialGpu.diagnostics.map(item => item.code),
      cpuDiagnostics: standardMaterialCpu.diagnostics.map(item => item.code),
    },
  }
}
