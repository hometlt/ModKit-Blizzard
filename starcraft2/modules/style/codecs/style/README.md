# StarCraft II style sheets

This module opens `*.SC2Style` files, publishes text, tree, table, facts and relation views, and returns revision-pinned `edit.field` plans. Attribute edits replace only the selected XML value bytes so comments, ordering and formatting survive.

The language provider resolves declarations and references against the workspace snapshot supplied by the host. Its vocabulary is based on installed style sheets rather than a published Blizzard schema, so unfamiliar attributes remain warnings. Persistence is performed by the host.

`src/define.ts` is the source of the generated `codec.json`. Run `pnpm contributions:emit` after changing the declaration. `runtime.js` preserves the current compiled implementation path while callers migrate to the module export.
