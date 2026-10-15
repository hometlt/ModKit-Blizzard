import { DOMParser } from '@xmldom/xmldom'
import { installM3PlatformAdapters } from '../../../dist/m3/native/platform.js'
import { M3_STRUCTURES_XML } from '../../../dist/m3/structures.generated.js'

installM3PlatformAdapters({ DOMParser })

/** The build embeds the exact frozen schema bytes for every execution environment. */
export function schemaText() {
  return M3_STRUCTURES_XML
}
