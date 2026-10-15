import base from '../../../test/vitest.sources.config.mjs'

export default {
  ...base,
  test: {
    ...base.test,
    include: [
      'starcraft2/modules/galaxy/test/**/*.{spec,test}.ts',
    ],
    exclude: [],
  },
}
