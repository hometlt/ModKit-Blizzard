import { assert, describe, it } from 'vitest';
import { fuzzysearch } from '../../../../../shared/layout-engine/sc2-layout-core/common.js';

describe('common', function () {
    it('fuzzysearch', function () {
        assert.isTrue(fuzzysearch('gameui', 'GameUI'));
        assert.isTrue(fuzzysearch('gameui', 'GameUI/Ab'));
        assert.isFalse(fuzzysearch('gameUi', 'GameU'));
        assert.isFalse(fuzzysearch('gAmeui', 'GameIU'));
    });
});


