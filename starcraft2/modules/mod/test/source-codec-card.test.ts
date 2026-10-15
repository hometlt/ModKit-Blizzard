/** Run the portable codec's complete card/edit/export fixture against source too, without rebuilding dist. */
import { vi } from 'vitest'

vi.mock('../../../dist/modules/mod/codecs/mod/portable/directory-codec.mjs', async () =>
  import('../codecs/directory/src/codec.js'))

await import('./sc2-mod-card.test.js')
