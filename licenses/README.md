# Licensing

Original Modkit code is licensed under the MIT License in `MIT.txt` and the root
`LICENSE`, except where a file, package manifest or `THIRD-PARTY-NOTICES.md` identifies
another license. On 2026-10-15 the project owner authorized MIT distribution of the
original Modkit platform bundles in `vendor/` as well. Their package license metadata
and included MIT grants reflect that decision; runtime payloads were retained.

## Components with other licenses

- The M3 package declares GPL-2.0-only. Its native `structures.xml` derives from
  SC2Mapster/m3addon; see `GPL-2.0-only.txt` and the package's provenance records.
- `blizzard-warcraft-3/src/war3-map-world/cliffs.ts` adapts WarsmashModEngine and retains
  AGPL-3.0 terms; see `WarsmashModEngine-AGPL-3.0.txt`. The Warcraft III extension must
  not be distributed under MIT alone while it contains this code.
- Vendored war3-model, mdx-m3-viewer, Galaxy toolkit and s2protocol code/tables retain
  their upstream MIT notices. The TriggerData sax dependency retains Blue Oak 1.0.0.

Read `THIRD-PARTY-NOTICES.md` for paths, upstream projects and revisions. Original
Modkit licensing does not replace third-party license obligations.

## Public-source exclusions

The public snapshot excludes the game-derived Galaxy native API JSON/generated adapter,
the genuine legacy M3A fixture, unreviewed M3 models and recorded replay fixtures.
Their redistribution provenance has not been established by this publication. The
exact omission list and build/test consequences are in `../docs/PUBLICATION.md`.
Generated compatibility data is not automatically covered by the original-code MIT grant.

Third-party license texts remain centralized in this directory. The root LICENSE
provides the original-code grant and scope notice. Include this directory with
repository-level extension artifacts; individual packages are not blanket MIT releases.
