import base from '../../../test/vitest.sources.config.mjs'

export default {
  ...base,
  test: {
    ...base.test,
    include: [
      'starcraft2/modules/triggers/test/*.test.ts',
      'starcraft2/modules/triggers/test/conversion/*.test.ts',
      'starcraft2/modules/triggers/test/core/**/*.{spec,test}.ts',
    ],
    // This suite pins files from a mutable local SC2 installation. Keep it as
    // an explicit host-corpus check; the default module suite must be
    // reproducible from repository-owned fixtures alone.
    exclude: [
      ...(base.test.exclude ?? []),
      'starcraft2/modules/triggers/test/sc2-triggers-native-corpus.test.ts',
    ],
  },
}
