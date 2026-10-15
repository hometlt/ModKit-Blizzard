// Wraps the gitignored compiled schema JSON so consumers import a plain ESM module
// (no `with { type: 'json' }` needed at each call site). Exposed via the package's
// "./bundled-schema" exports subpath. The artifact is produced by scripts/compile-schema.ts.
import schemaData from './generated/sc2layout-schema-data.json' with { type: 'json' };
export default schemaData;
