import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Explicit environment override, then configured workspace source, then adjacent checkout. */
export function resolveCoreRoot(repositoryRoot, environment = process.env) {
  if (environment.MODKIT_CORE_ROOT?.trim()) return resolve(environment.MODKIT_CORE_ROOT)
  const configPath = resolve(environment.MODKIT_WORKSPACE_CONFIG ?? resolve(repositoryRoot, '..', 'modkit.workspace.json'))
  if (existsSync(configPath)) {
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    const source = config.sources?.find(source => source.id === 'core')
    if (source) {
      const override = source.environment && environment[source.environment]
      const uri = override || source.uri
      if (typeof uri !== 'string' || !uri) throw new Error('workspace core source has no local URI')
      if (uri.startsWith('file:')) return fileURLToPath(uri)
      if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(uri)) throw new Error('core link source must be a local checkout')
      return resolve(dirname(configPath), uri)
    }
  }
  return resolve(repositoryRoot, '..', 'modkit-core')
}
