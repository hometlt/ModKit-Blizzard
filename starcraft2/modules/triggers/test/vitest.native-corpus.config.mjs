import base from './vitest.module.config.mjs'

// Opt-in verification against the user's installed, mutable SC2 corpus.
// A changed source SHA is evidence that the external fixture changed; expected
// values must never be silently refreshed by the ordinary module test run.
export default {
  ...base,
  test: {
    ...base.test,
    include: ['starcraft2/modules/triggers/test/sc2-triggers-native-corpus.test.ts'],
    exclude: [],
  },
}
