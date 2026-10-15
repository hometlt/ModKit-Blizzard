export const SC2_GAME_ID = 'starcraft-2'
export const SC2_LAYOUT_CODEC_ID = 'sc2-layout'
export const SC2_LAYOUT_CODEC_VERSION = '0.1.0'
export const SC2_LAYOUT_EXTENSION = '.sc2layout'

export function layoutBasename(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}
