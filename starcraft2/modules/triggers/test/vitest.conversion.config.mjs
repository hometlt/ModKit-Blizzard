import base from '../../../test/vitest.sources.config.mjs';

// Conversion tests use in-memory libraries; archive/corpus setup is unnecessary.
export default {
  ...base,
  test: {
    ...base.test,
    globalSetup: [],
    setupFiles: [],
    include: [
      'starcraft2/modules/triggers/test/conversion/triggers-galaxy-structured.test.ts',
      'starcraft2/modules/triggers/test/conversion/triggers-galaxy-templates.test.ts',
      'starcraft2/modules/triggers/test/conversion/triggers-galaxy-corpus-regressions.test.ts',
      'starcraft2/modules/triggers/test/conversion/triggers-galaxy-startup-validation.test.ts',
      'starcraft2/modules/triggers/test/conversion/semantic-conversion.test.ts',
      'starcraft2/modules/triggers/test/conversion/codec-conversion-operations.test.ts',
      'starcraft2/modules/triggers/test/conversion/custom-ai-conversion.test.ts',
      'starcraft2/modules/galaxy/test/core/ttg-*.spec.ts',
      'starcraft2/modules/triggers/test/core/g2t-*.spec.ts',
      'starcraft2/modules/triggers/test/core/galaxy-comparison.spec.ts',
      'starcraft2/modules/triggers/test/core/ttg-naming.spec.ts',
    ],
  },
};
