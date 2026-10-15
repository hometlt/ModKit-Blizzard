/** Stable StarCraft II script format identifiers shared by Galaxy and TriggerData. */
export const SC2_GAME_ID = 'starcraft-2'

export const GALAXY_CODEC_ID = 'galaxy'
export const GALAXY_CODEC_VERSION = '0.1.0'
export const GALAXY_EXTENSION = '.galaxy'

export const SC2_TRIGGERS_CODEC_ID = 'sc2-triggers'
export const SC2_TRIGGERS_CODEC_VERSION = '0.1.0'
export const SC2_TRIGGERS_EXTENSIONS: readonly string[] = ['.xml', '.sc2lib', '.triggers']
export const SC2_TRIGGERS_BARE_NAMES: readonly string[] = ['triggers']

export function scriptHandlerId(codecId: string, operationId: string): string {
  return `${codecId}.${operationId}`
}

export function isTriggerFilePath(relativePath: string): boolean {
  return /(^|[\\/])triggers$/i.test(relativePath) || /\.(sc2lib|triggerlib)$/i.test(relativePath)
}
