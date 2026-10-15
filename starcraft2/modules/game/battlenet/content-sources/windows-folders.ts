/**
 * Player folders StarCraft II and its editor actually use on Windows.
 *
 * `Documents` is a Windows known folder and may be redirected (OneDrive, another drive), so
 * `homedir()/Documents` is only the fallback. The editor loads `.BlizWiz` from
 * `Documents/StarCraft II/EditorWizards` and from the extra folders listed in its preferences.
 * Both come from the host's installation probes (`ContributionContext.installationProbes`, handed to
 * `createContentSources` beside its options); a host without them (a browser) gets the defaults,
 * and every other runtime receives these folders as explicit configuration instead.
 */
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import type { InstallationProbes } from '@modkit/sdk'

/**
 * The probes this module asks. `knownFolder` is optional: a host from before core 174a97c5 lacks it
 * and the folders fall back to their defaults.
 */
export type FolderProbes = Pick<InstallationProbes, 'registryValues'> & {
  knownFolder?(folder: 'documents' | 'program-data', signal?: AbortSignal): Promise<string | undefined>
}

export const SC2_EDITOR_PREFERENCES_KEY =
  'Software\\Blizzard Entertainment\\StarCraft II Editor\\Preferences'

/**
 * `WizardExtraDirsEnabled` is a `REG_BINARY` holding one NUL-terminated ASCII string of absolute
 * folders separated by `;` (observed with one and with two folders in SC2Editor 5.0.16).
 */
export function parseWizardExtraDirectories(hex: string): readonly string[] {
  if (!/^(?:[0-9a-fA-F]{2})*$/u.test(hex)) return []
  const text = Buffer.from(hex, 'hex').toString('latin1')
  const terminated = text.indexOf('\0')
  return (terminated === -1 ? text : text.slice(0, terminated))
    .split(';')
    .map(item => item.trim())
    .filter(item => item !== '' && isAbsolute(item))
    .map(item => resolve(item))
}

const isDirectory = (path: string): boolean => {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** A known folder the probes name, if it is an existing absolute directory; a failing probe is none. */
export async function knownFolder(
  probes: FolderProbes | undefined,
  folder: 'documents' | 'program-data',
  signal?: AbortSignal,
): Promise<string | undefined> {
  const path = await probes?.knownFolder?.(folder, signal).catch(() => undefined)
  return path !== undefined && isAbsolute(path) && isDirectory(path) ? resolve(path) : undefined
}

/** The player's `Documents` folder: the known folder when the host names one, else `~/Documents`. */
export async function documentsDirectory(
  probes?: FolderProbes,
  signal?: AbortSignal,
): Promise<string> {
  return (await knownFolder(probes, 'documents', signal)) ?? join(homedir(), 'Documents')
}

/** Every folder the editor loads wizards from that exists now: `EditorWizards`, then extra folders. */
export async function editorWizardDirectories(
  sc2DocumentsDirectory: string,
  probes?: FolderProbes,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  const values = await probes
    ?.registryValues('HKCU', SC2_EDITOR_PREFERENCES_KEY, ['WizardExtraDirsEnabled'], signal)
    // An absent key or value is normal and contributes nothing.
    .catch(() => undefined)
  const extra = values?.['WizardExtraDirsEnabled']
  const candidates = [
    join(sc2DocumentsDirectory, 'EditorWizards'),
    ...(extra === undefined ? [] : parseWizardExtraDirectories(extra)),
  ]
  const seen = new Set<string>()
  return candidates.filter(path => {
    const key = resolve(path).toLowerCase()
    if (seen.has(key) || !isDirectory(path)) return false
    seen.add(key)
    return true
  })
}
