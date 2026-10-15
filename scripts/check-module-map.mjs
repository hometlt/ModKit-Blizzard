import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const mapRelativePath = 'architecture/module-map.json'
const inventoryRelativePath = 'architecture/module-map.inventory.json'
const mappedContracts = new Set([
  'modkit/codec-contribution',
  'modkit/service-provider-contribution',
])

function globExpression(pattern) {
  let expression = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          expression += '(?:.*/)?'
          index += 2
        } else {
          expression += '.*'
          index += 1
        }
      } else expression += '[^/]*'
    } else if ('\\^$+?.()|{}[]'.includes(character)) expression += `\\${character}`
    else expression += character
  }
  return new RegExp(`^${expression}$`)
}

async function files(root) {
  const found = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory() && !['artifacts', 'dist', 'node_modules'].includes(entry.name)) await visit(path)
      else if (entry.isFile()) found.push(path)
    }
  }
  await visit(root)
  return found
}

async function readJson(path, errors) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    errors.push(`${path}: ${error instanceof SyntaxError ? 'invalid JSON' : error.code === 'ENOENT' ? 'required file is missing' : error.message}`)
    return undefined
  }
}

function validTargetPath(path) {
  return typeof path === 'string'
    && path.length > 0
    && !path.startsWith('/')
    && !path.includes('\\')
    && posix.normalize(path) === path
    && !path.split('/').includes('..')
}

export async function contributionInventory(repositoryRoot) {
  const errors = []
  const repository = await readJson(join(repositoryRoot, 'modkit.repository.json'), errors)
  const contributions = []
  for (const extension of repository?.extensions ?? []) {
    const extensionRoot = resolve(repositoryRoot, extension.path)
    const packageManifest = await readJson(join(extensionRoot, 'package.json'), errors)
    const patterns = packageManifest?.modkit?.contributionManifests
    if (!Array.isArray(patterns)) continue
    let extensionFiles = []
    try { extensionFiles = await files(extensionRoot) } catch (error) {
      errors.push(`${extensionRoot}: extension directory is missing`)
      continue
    }
    for (const pattern of [...patterns].sort()) {
      if (typeof pattern !== 'string') {
        errors.push(`${join(extensionRoot, 'package.json')}: contributionManifests must contain strings`)
        continue
      }
      const match = globExpression(pattern.replace(/^\.\//, ''))
      const selected = extensionFiles
        .filter(path => match.test(relative(extensionRoot, path).replaceAll('\\', '/')))
        .sort()
      for (const path of selected) {
        const manifest = await readJson(path, errors)
        if (!mappedContracts.has(manifest?.contract?.id)) continue
        if (typeof manifest?.id !== 'string' || manifest.id.length === 0) {
          errors.push(`${path}: source manifest has no contribution id`)
          continue
        }
        contributions.push({
          id: manifest.id,
          sourceManifest: relative(repositoryRoot, path).replaceAll('\\', '/'),
        })
      }
    }
  }
  contributions.sort((left, right) => left.id.localeCompare(right.id) || left.sourceManifest.localeCompare(right.sourceManifest))
  const ids = new Map()
  for (const contribution of contributions) {
    const previous = ids.get(contribution.id)
    if (previous !== undefined) errors.push(`${contribution.id}: duplicate contribution id in ${previous} and ${contribution.sourceManifest}`)
    else ids.set(contribution.id, contribution.sourceManifest)
  }
  return { contributions, errors }
}

export async function moduleMapInventory(repositoryRoot) {
  const { contributions, errors } = await contributionInventory(repositoryRoot)
  const map = await readJson(join(repositoryRoot, mapRelativePath), errors)
  const targets = map?.contributions
  if (map?.schemaVersion !== 1) errors.push(`${mapRelativePath}: schemaVersion must be 1`)
  if (targets === null || typeof targets !== 'object' || Array.isArray(targets)) {
    errors.push(`${mapRelativePath}: contributions must be an id-to-target-path object`)
  }
  const sourceIds = new Set(contributions.map(contribution => contribution.id))
  const targetPaths = new Map()
  for (const [id, targetPath] of Object.entries(targets ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
    if (!sourceIds.has(id)) errors.push(`${id}: mapped contribution has no source manifest`)
    if (!validTargetPath(targetPath)) errors.push(`${id}: target path must be a normalized relative POSIX path`)
    const previous = targetPaths.get(targetPath)
    if (previous !== undefined) errors.push(`${id}: target path ${targetPath} is already mapped by ${previous}`)
    else targetPaths.set(targetPath, id)
  }
  for (const contribution of contributions) {
    if (targets?.[contribution.id] === undefined) errors.push(`${contribution.id}: source manifest ${contribution.sourceManifest} has no module-map target`)
  }
  return {
    inventory: {
      schemaVersion: 1,
      contributions: contributions.map(contribution => ({
        ...contribution,
        targetPath: targets?.[contribution.id],
      })),
    },
    errors,
  }
}

export async function checkModuleMap(repositoryRoot, { check = true } = {}) {
  const { inventory, errors } = await moduleMapInventory(repositoryRoot)
  if (errors.length > 0) return errors
  const outputPath = join(repositoryRoot, inventoryRelativePath)
  const output = `${JSON.stringify(inventory, null, 2)}\n`
  if (check) {
    let current = ''
    try { current = await readFile(outputPath, 'utf8') } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (current !== output) errors.push(`${inventoryRelativePath}: generated inventory is stale; run node ./scripts/check-module-map.mjs`)
  } else {
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, output)
  }
  return errors
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repositoryRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))
  const errors = await checkModuleMap(repositoryRoot, { check: process.argv.includes('--check') })
  if (errors.length > 0) {
    for (const error of errors) console.error(error)
    process.exitCode = 1
  } else console.log('module map: valid')
}
