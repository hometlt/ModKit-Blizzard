import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspaceRoot = resolve(packageRoot, '../../../../modkit-core')

export default {
  root: packageRoot,
  resolve: {
    alias: [
      {
        find: '@modkit/sdk/language',
        replacement: resolve(workspaceRoot, 'packages/sdk/src/language/index.ts'),
      },
      {
        find: '@modkit/sdk',
        replacement: resolve(workspaceRoot, 'packages/sdk/src/index.ts'),
      },
      {
        find: '@modkit/core',
        replacement: resolve(workspaceRoot, 'packages/core/src/index.ts'),
      },
    ],
  },
}
