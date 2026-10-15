import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspaceRoot = resolve(packageRoot, '../../modkit-core')

export default {
  root: packageRoot,
  resolve: {
    alias: [
      {
        find: '@modkit/blizzard-starcraft2/galaxy/language-core',
        replacement: resolve(packageRoot, 'modules/galaxy/language-core/index.ts'),
      },
      {
        find: '@modkit/blizzard-starcraft2/galaxy/language-service',
        replacement: resolve(packageRoot, 'modules/galaxy/services/analysis/language-service.ts'),
      },
      {
        find: '@modkit/blizzard-mpq/native-preserving',
        replacement: resolve(packageRoot, '../mpq/src/mpq/native-preserving.js'),
      },
      {
        find: '@modkit/blizzard-mpq/fresh-writer',
        replacement: resolve(packageRoot, '../mpq/src/mpq/fresh-writer.js'),
      },
      {
        find: '@modkit/sdk/manifest/validators.generated',
        replacement: resolve(workspaceRoot, 'packages/sdk/src/manifest/validators.generated.ts'),
      },
      {
        find: '@modkit/sdk/model-encoding',
        replacement: resolve(workspaceRoot, 'packages/sdk/src/model-encoding.ts'),
      },
      {
        find: '@modkit/sdk/security',
        replacement: resolve(workspaceRoot, 'packages/sdk/src/security/grant.ts'),
      },
      {
        find: '@modkit/sdk/descriptor',
        replacement: resolve(
          workspaceRoot,
          'packages/sdk/src/asset-capabilities/validate-descriptor.ts',
        ),
      },
      {
        find: '@modkit/sdk/codec',
        replacement: resolve(workspaceRoot, 'packages/sdk/src/codec.ts'),
      },
      ...[
        'data',
        'games',
        'knowledge',
        'language',
        'maps',
        'mods',
        'renderer',
        'runtime',
        'subjects',
        'templates',
      ].map(moduleName => ({
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
        find: '@modkit/codec-kit/crypto/digest',
        replacement: resolve(workspaceRoot, 'packages/codec-kit/src/crypto/digest.ts'),
      },
      {
        find: '@modkit/codec-kit/crypto',
        replacement: resolve(workspaceRoot, 'packages/codec-kit/src/crypto/index.ts'),
      },
      {
        find: '@modkit/codec-kit/json-snapshot',
        replacement: resolve(workspaceRoot, 'packages/codec-kit/src/json-snapshot.ts'),
      },
      {
        find: '@modkit/codec-kit/json-edit',
        replacement: resolve(workspaceRoot, 'packages/codec-kit/src/json-edit.ts'),
      },
      {
        find: '@modkit/codec-kit/projection',
        replacement: resolve(workspaceRoot, 'packages/codec-kit/src/projection.ts'),
      },
      {
        find: '@modkit/codec-kit/tree/json',
        replacement: resolve(workspaceRoot, 'packages/codec-kit/src/tree/json-tree.ts'),
      },
      {
        find: '@modkit/codec-kit/graph/isolation',
        replacement: resolve(workspaceRoot, 'packages/codec-kit/src/graph-isolation.ts'),
      },
      {
        find: /^@modkit\/codec-kit\/model-math\/(.+)$/u,
        replacement: `${resolve(workspaceRoot, 'packages/codec-kit/src/model-math')}/$1.ts`,
      },
      {
        find: /^@modkit\/codec-kit\/model\/(.+)$/u,
        replacement: `${resolve(workspaceRoot, 'packages/codec-kit/src/model')}/$1.ts`,
      },
      {
        find: /^@modkit\/codec-kit\/legacy\/models\/(.+)$/u,
        replacement: `${resolve(workspaceRoot, 'packages/codec-kit/src/legacy/models')}/$1.ts`,
      },
      {
        find: '@modkit/codec-kit/legacy/models',
        replacement: resolve(workspaceRoot, 'packages/codec-kit/src/legacy-model-support.ts'),
      },
      {
        find: '@modkit/codec-kit/compression',
        replacement: resolve(workspaceRoot, 'packages/codec-kit/src/compression/index.ts'),
      },
      {
        find: '@modkit/codec-kit/legacy/assets',
        replacement: resolve(workspaceRoot, 'packages/codec-kit/src/legacy/assets/index.ts'),
      },
      {
        find: '@modkit/codec-kit/legacy/core',
        replacement: resolve(workspaceRoot, 'packages/codec-kit/src/legacy/core/index.ts'),
      },
      {
        find: /^@modkit\/codec-kit\/legacy\/sc2-support$/u,
        replacement: resolve(workspaceRoot, 'packages/codec-kit/src/legacy-sc2-support.ts'),
      },
      {
        find: '@modkit/codec-kit',
        replacement: resolve(workspaceRoot, 'packages/codec-kit/src/index.ts'),
      },
      {
        find: '@rgrove/parse-xml',
        replacement: resolve(packageRoot, 'node_modules/@rgrove/parse-xml/dist/index.js'),
      },
      {
        find: '@modkit/host/node',
        replacement: resolve(workspaceRoot, 'packages/host/src/node/index.ts'),
      },
      {
        find: '@modkit/host/language',
        replacement: resolve(workspaceRoot, 'packages/host/src/language/index.ts'),
      },
      {
        find: '@modkit/host/codec',
        replacement: resolve(workspaceRoot, 'packages/host/src/codec.ts'),
      },
      {
        find: '@modkit/host',
        replacement: resolve(workspaceRoot, 'packages/host/src/index.ts'),
      },
      {
        find: '@modkit/ui/world',
        replacement: resolve(workspaceRoot, 'packages/ui/src/world/index.ts'),
      },
      {
        find: '@modkit/uv/world',
        replacement: resolve(workspaceRoot, 'packages/uv/src/world/index.ts'),
      },
      {
        find: '@modkit/scene/model',
        replacement: resolve(workspaceRoot, 'packages/scene/src/model/index.ts'),
      },
      {
        find: '@modkit/scene/world',
        replacement: resolve(workspaceRoot, 'packages/scene/src/world/index.ts'),
      },
    ],
  },
}
