import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { contributionInventory } from './check-module-map.mjs'

const forbiddenCodecPermissions = new Set(['filesystem-read', 'network', 'credentials', 'process-launch'])

async function directories(path) {
  try { return (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort() } catch (error) { if (error?.code === 'ENOENT') return []; throw error }
}

async function manifest(path, errors) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) { errors.push(`${path}: ${error?.code === 'ENOENT' ? 'required manifest is missing' : `invalid JSON (${error})`}`); return undefined }
}

function checkCodec(path, value, errors) {
  if (value.contract?.id !== 'modkit/codec-contribution') errors.push(`${path}: codecs must use modkit/codec-contribution`)
  for (const variant of value.runtimeVariants ?? []) for (const permission of variant.requestedPermissionClasses ?? []) if (forbiddenCodecPermissions.has(permission)) errors.push(`${path}: codec requests forbidden permission ${permission}`)
}

function checkProvider(path, value, errors) {
  if (value.contract?.id !== 'modkit/service-provider-contribution') errors.push(`${path}: providers must use modkit/service-provider-contribution`)
}

export async function checkCodecProviderSplit(repositoryRoot) {
  const errors = []
  const checked = new Set()
  const repository = JSON.parse(await readFile(join(repositoryRoot, 'modkit.repository.json'), 'utf8'))
  for (const extension of repository.extensions ?? []) {
    const root = resolve(repositoryRoot, extension.path)
    for (const name of await directories(join(root, 'codecs'))) {
      const path = join(root, 'codecs', name, 'codec.json')
      const value = await manifest(path, errors)
      if (value === undefined) continue
      checked.add(path)
      checkCodec(path, value, errors)
    }
    for (const name of await directories(join(root, 'providers'))) {
      const path = join(root, 'providers', name, 'provider.json')
      const value = await manifest(path, errors)
      if (value !== undefined) {
        checked.add(path)
        checkProvider(path, value, errors)
      }
    }
  }
  const nested = await contributionInventory(repositoryRoot)
  errors.push(...nested.errors)
  for (const contribution of nested.contributions) {
    const source = contribution.sourceManifest.split('/')
    const leaf = source.at(-1)
    const isCodec = leaf === 'codec.json' && source.includes('codecs')
    const isProvider = leaf === 'provider.json' && source.includes('providers')
    if (!isCodec && !isProvider) continue
    const path = resolve(repositoryRoot, contribution.sourceManifest)
    if (checked.has(path)) continue
    const value = await manifest(path, errors)
    if (value === undefined) continue
    if (isCodec) checkCodec(path, value, errors)
    else checkProvider(path, value, errors)
  }
  return errors
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
  const errors = await checkCodecProviderSplit(root)
  if (errors.length > 0) { for (const error of errors) console.error(error); process.exitCode = 1 } else console.log('codec/provider split: valid')
}
