import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Host acceptance may use a frozen artifact while source work continues elsewhere. */
export const sc2TestExtensionRoot = resolve(
  process.env.MODKIT_SC2_TEST_EXTENSION_ROOT ?? fileURLToPath(new URL('../../', import.meta.url)),
)
