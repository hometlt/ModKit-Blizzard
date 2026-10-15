import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { mapToJson, type SC2MapData } from '../format/index.js'
import {
  cliffLevelToPng,
  composeOverlayToPng,
  heightToPng,
  overlayToPng,
  pathingToPng,
  textureToPng,
  vertexColorToPng,
} from './index.js'

export interface RenderMapPngOptions {
  json?: boolean
  overlay?: boolean
  overlayScale?: number
  vertexColor?: boolean
}

export interface RenderMapPngResult {
  name: string
  parsedFields: string[]
  files: string[]
  dimensions?: { width: number; height: number }
  pathingDimensions?: { width: number; height: number }
  textureDimensions?: { width: number; height: number; layers: number }
}

/** Render the package-owned SC2 map projections used by the CLI and extracted-package tests. */
export function renderMapPngData(
  map: SC2MapData,
  inputName: string,
  outDir = 'map-png-out',
  options: RenderMapPngOptions = {},
): RenderMapPngResult {
  const baseName = basename(inputName)
  const strippedName = baseName.replace(/\.[^.]+$/, '')
  const name = strippedName === '' ? baseName : strippedName

  mkdirSync(outDir, { recursive: true })

  const wrote: string[] = []
  const emit = (suffix: string, bytes: Uint8Array) => {
    const file = join(outDir, `${name}-${suffix}`)
    writeFileSync(file, bytes)
    wrote.push(file)
  }

  if (map.height) emit('height.png', heightToPng(map.height, 'sum'))
  if (map.cliffLevel) emit('cliff.png', cliffLevelToPng(map.cliffLevel))
  const hasOverlay = Boolean(map.objects || map.regions || map.water)
  let pathingPng: Uint8Array | undefined
  let texturePng: Uint8Array | undefined
  if (map.pathing) {
    pathingPng = pathingToPng(map.pathing)
    emit('pathing.png', pathingPng)
  }
  if (map.textureMasks) {
    texturePng = textureToPng(map.textureMasks)
    emit('texture.png', texturePng)
  }
  if (options.vertexColor !== false && map.vertexColor) {
    emit(
      'vertex-color.png',
      vertexColorToPng(map.vertexColor, {
        mapWidth: map.height?.sizeX ?? map.info?.width,
        mapHeight: map.height?.sizeY ?? map.info?.height,
      }),
    )
  }
  const overlayOptions =
    options.overlayScale !== undefined ? { cellScale: options.overlayScale } : undefined
  if (options.overlay !== false && hasOverlay) {
    emit('overlay.png', overlayToPng(map, overlayOptions))
    if (pathingPng)
      emit('pathing-overlay.png', composeOverlayToPng(pathingPng, map, overlayOptions))
    if (texturePng)
      emit('texture-overlay.png', composeOverlayToPng(texturePng, map, overlayOptions))
  }
  if (options.json) emit('map.json', new TextEncoder().encode(mapToJson(map)))

  const parsedFields = Object.keys(map).filter(
    key => key !== 'rawFiles' && (map as unknown as Record<string, unknown>)[key],
  )
  const result: RenderMapPngResult = { name, parsedFields, files: wrote }
  if (map.height) result.dimensions = { width: map.height.sizeX, height: map.height.sizeY }
  if (map.pathing)
    result.pathingDimensions = { width: map.pathing.sizeX, height: map.pathing.sizeY }
  if (map.textureMasks) {
    result.textureDimensions = {
      width: map.textureMasks.sizeX,
      height: map.textureMasks.sizeY,
      layers: map.textureMasks.layers,
    }
  }
  return result
}
