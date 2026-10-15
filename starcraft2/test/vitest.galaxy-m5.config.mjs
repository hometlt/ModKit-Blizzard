import base from './vitest.sources.config.mjs'

export default {
  ...base,
  test: {
    ...base.test,
    globalSetup: [],
    setupFiles: [],
    include: [
      'starcraft2/modules/galaxy/test/core/ast-factory.spec.ts',
      'starcraft2/modules/galaxy/test/core/reader.spec.ts',
      'starcraft2/modules/galaxy/test/core/language-service.spec.ts',
      'starcraft2/modules/galaxy/test/core/store.spec.ts',
      'starcraft2/modules/galaxy/test/core/workspace-index.spec.ts',
      'starcraft2/modules/galaxy/test/core/to-engine.spec.ts',
    ],
    exclude: [],
  },
}
