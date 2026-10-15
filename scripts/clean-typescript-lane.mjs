import { rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageRoot = resolve(repositoryRoot, 'starcraft2')

await Promise.all([
  rm(resolve(packageRoot, 'dist'), { recursive: true, force: true }),
  rm(resolve(packageRoot, 'tsconfig.tsbuildinfo'), { force: true }),
])
