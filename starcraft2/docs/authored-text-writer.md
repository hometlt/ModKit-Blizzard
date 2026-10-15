# Adding an SC2 authored-text format

Use the shared authored-text writer when an editor produces one complete UTF-8 source snapshot and
the host can commit that snapshot through the ordinary revision-pinned edit transaction.

Keep parsing and format validation in the domain that owns the format:

All six current rules live in `modules/{galaxy,triggers,data,layout,strings,banks}/services/authored-text-rules.js`.
The shared provider imports and registers them; it contains no domain rules.

```js
import { defineAuthoredTextFormat } from '@modkit/blizzard-starcraft2/authoring/authored-text'

export const exampleAuthoredText = defineAuthoredTextFormat({
  formatId: 'example-text',
  offerId: 'example-text-source',
  evidenceId: 'example-text-writer-v1',
  label: 'Example text',
  validate(text, budget) {
    if (text.length === 0) throw new TypeError('Example text is empty')
    if (text.split('\n').length > budget.maxNodes) throw new RangeError('too many lines')
  },
})
```

Import the rule only from the authored-text provider composition module and add the matching offer
to its provider manifest. `pnpm check:codec-provider-split` compares every registered rule with the
published `formatId`, `offerId`, and `fidelityEvidenceId`, so either half cannot change alone.

The shared engine owns ChangeSet shape, source/target identity, revision guards, payload bounds,
complete-snapshot intent, validation-to-plan flow, fidelity claims, and diagnostics. A domain rule
owns only recognition or syntax checks that are specific to its format. Keep semantic edit creation
in the codec/domain and let the engine commit the resulting complete source.

Use a separate writer when the format needs multiple edits, binary patching, signing, external
resources, or weaker fidelity. Declaring a format here does not add a manifest offer automatically
and does not grant permissions.
