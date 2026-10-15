# StarCraft II localization codec

`sc2-strings` is the semantic localization codec over the raw-preserving StarCraft II string-file
model. It opens one locale file or a layered locale set and exposes browsing, diagnostics,
references, in-memory editing, export, and markup-safe translation.

## Routing

Generated routing requires a `.txt` file under
`<locale>.SC2Data/LocalizedData/` inside an SC2 mod, map, or campaign artifact. The bounded
detector remains responsible for verifying the key/value structure and SC2-style namespaced keys.

## Runtime and operations

Detection is portable across browser and Node hosts. The current semantic runtime is
conservatively Node-only because its localization dependency graph reaches Node code. Fallback
and comparison additionally require multiple locale layers, while markup resolution and
reference-existence diagnostics require an injected catalog resolver.

Edits preserve the in-memory line model and export returns serialized text; persisting it into
the source is host-owned. Translation requires operation-level network permission. These
conditional dependencies and the missing source-save path keep support partial.
