import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveCoreRoot } from './core-link-config.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const coreRoot = resolveCoreRoot(repositoryRoot)
const packageNames = ['codec-kit', 'core', 'host', 'scene', 'sdk', 'testkit', 'ui', 'uv', 'vfs']

function targetFor(packageName, subpath) {
  const packageRoot = resolve(coreRoot, 'packages', packageName)
  const manifestPath = resolve(packageRoot, 'package.json')
  if (!existsSync(manifestPath)) return undefined
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const exportKey = subpath === '' ? '.' : `.${subpath}`
  let exported = manifest.exports?.[exportKey]
  let wildcard
  if (exported === undefined) {
    const key = Object.keys(manifest.exports ?? {}).find(key => {
      if (!key.includes('*')) return false
      const [start, end] = key.split('*')
      return exportKey.startsWith(start) && exportKey.endsWith(end)
    })
    if (key !== undefined) {
      const [start, end] = key.split('*')
      wildcard = exportKey.slice(start.length, end.length ? -end.length : undefined)
      exported = manifest.exports[key]
    }
  }
  const value = typeof exported === 'string' ? exported : exported?.default
  if (typeof value !== 'string') return undefined
  const target = resolve(packageRoot, wildcard === undefined ? value : value.replaceAll('*', wildcard))
  return existsSync(target) ? pathToFileURL(target).href : undefined
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (process.env.MODKIT_LINK_MODE !== 'core' || !specifier.startsWith('@modkit/')) {
      return nextResolve(specifier, context)
    }
    const match = /^@modkit\/([^/]+)(\/.*)?$/u.exec(specifier)
    if (match === null || !packageNames.includes(match[1])) return nextResolve(specifier, context)
    const target = targetFor(match[1], match[2] ?? '')
    if (target === undefined) throw new Error(`core link export is missing or unbuilt: ${specifier} (${coreRoot})`)
    return { url: target, shortCircuit: true }
  },
})
