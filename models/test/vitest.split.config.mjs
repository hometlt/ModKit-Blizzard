import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const workspaceRoot = [
  resolve(extensionRoot, '../modkit-core'),
  resolve(extensionRoot, '..', '..'),
].find(candidate => existsSync(resolve(candidate, 'packages', 'host', 'package.json')))
if (workspaceRoot === undefined) throw new Error('cannot locate the shared modkit-core workspace')

export default {
  root: extensionRoot,
  test: {
    hookTimeout: 300_000,
    testTimeout: 300_000,
  },
  resolve: {
    alias: [
      {
        find: '@modkit/sdk/manifest/validators.generated',
        replacement: resolve(workspaceRoot, 'packages/sdk/src/manifest/validators.generated.ts'),
      },
      {
        find: '@modkit/sdk/data',
        replacement: resolve(workspaceRoot, 'packages/sdk/src/data/index.ts'),
      },
      {
        find: '@modkit/sdk/maps',
        replacement: resolve(workspaceRoot, 'packages/sdk/src/maps/index.ts'),
      },
      {
        find: '@modkit/sdk/model-encoding',
        replacement: resolve(workspaceRoot, 'packages/sdk/src/model-encoding.ts'),
      },
      ...['games', 'language', 'mods', 'renderer', 'runtime', 'subjects'].map(moduleName => ({
        find: `@modkit/sdk/${moduleName}`,
        replacement: resolve(workspaceRoot, `packages/sdk/src/${moduleName}/index.ts`),
      })),
      {
        find: '@modkit/sdk',
        replacement: resolve(workspaceRoot, 'packages/sdk/src/index.ts'),
      },
      {
        find: '@modkit/core',
        replacement: resolve(workspaceRoot, 'packages/core/src/index.ts'),
      },
      {
        find: '@modkit/codec-kit/json-edit',
        replacement: resolve(workspaceRoot, 'packages/codec-kit/src/json-edit.ts'),
      },
      {
        find: '@modkit/codec-kit/json-snapshot',
        replacement: resolve(workspaceRoot, 'packages/codec-kit/src/json-snapshot.ts'),
      },
      {
        find: '@modkit/codec-kit/legacy/models/material',
        replacement: resolve(workspaceRoot, 'packages/codec-kit/src/legacy/models/material.ts'),
      },
      {
        find: '@modkit/codec-kit/legacy/core',
        replacement: resolve(workspaceRoot, 'packages/codec-kit/src/legacy/core/index.ts'),
      },
      {
        find: '@modkit/codec-kit/legacy/models/texture-codec',
        replacement: resolve(
          workspaceRoot,
          'packages/codec-kit/src/legacy/models/texture-codec.ts',
        ),
      },
      {
        find: '@modkit/codec-kit/legacy/models',
        replacement: resolve(workspaceRoot, 'packages/codec-kit/src/legacy-model-support.ts'),
      },
      ...['sequence-pose', 'standard-material-glsl', 'effects-sim'].map(moduleName => ({
        find: `@modkit/codec-kit/model-math/${moduleName}`,
        replacement: resolve(workspaceRoot, `packages/codec-kit/src/model-math/${moduleName}.ts`),
      })),
      {
        find: '@modkit/codec-kit/model/sources',
        replacement: resolve(workspaceRoot, 'packages/codec-kit/src/model/sources.ts'),
      },
      {
        find: '@modkit/codec-kit/projection',
        replacement: resolve(workspaceRoot, 'packages/codec-kit/src/projection.ts'),
      },
      {
        find: '@modkit/codec-kit/tree/json',
        replacement: resolve(workspaceRoot, 'packages/codec-kit/src/tree/json-tree.ts'),
      },
      ...[
        'model/animation',
        'model/geometry',
        'model/materials',
        'model/skeleton',
        'model/skinning',
        'crypto/digest',
        'editing',
      ].map(moduleName => ({
        find: `@modkit/codec-kit/${moduleName}`,
        replacement: resolve(workspaceRoot, `packages/codec-kit/src/${moduleName}.ts`),
      })),
      {
        find: '@modkit/codec-kit',
        replacement: resolve(workspaceRoot, 'packages/codec-kit/src/index.ts'),
      },
      {
        find: '@modkit/host/node',
        replacement: resolve(workspaceRoot, 'packages/host/src/node/index.ts'),
      },
      {
        find: '@modkit/host/execution',
        replacement: resolve(workspaceRoot, 'packages/host/src/execution/index.ts'),
      },
      {
        find: '@modkit/host',
        replacement: resolve(workspaceRoot, 'packages/host/src/index.ts'),
      },
      {
        find: '@modkit/testkit',
        replacement: resolve(workspaceRoot, 'packages/testkit/src/index.ts'),
      },
      {
        find: '@modkit/vfs/providers/file',
        replacement: resolve(workspaceRoot, 'packages/vfs/src/providers/file/index.ts'),
      },
      {
        find: '@modkit/vfs/providers/memory',
        replacement: resolve(workspaceRoot, 'packages/vfs/src/providers/memory/index.ts'),
      },
      {
        find: '@modkit/vfs',
        replacement: resolve(workspaceRoot, 'packages/vfs/src/index.ts'),
      },
      {
        find: '@xmldom/xmldom',
        replacement: resolve(extensionRoot, 'models/node_modules/@xmldom/xmldom/lib/index.js'),
      },
    ],
  },
}
