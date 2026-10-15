/** The process-local view of the pinned SC2Layout schema. */
import schemaData from './generated/sc2layout-schema-data.json' with { type: 'json' }
import { createRegistry } from './layout-engine/sc2-layout-core/schema/registry.js'
import type { SchemaData } from './layout-engine/sc2-layout-core/schema/registry.js'

/** SHA-256 of the single generated schema artifact imported above. */
export const SC2_LAYOUT_SCHEMA_REVISION =
  'sha256:b2fb2c1302c9338a66a1d6787b19206eaf4bc38676ccd59de83ceb37275dba1f'

let cached: ReturnType<typeof createRegistry> | undefined

export function layoutSchemaRegistry() {
  cached ??= createRegistry(schemaData as unknown as SchemaData)
  return cached
}
