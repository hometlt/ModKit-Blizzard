# Development and execution

Use Node.js >=22 and pnpm 10.12.1 (the version in `packageManager`).

```sh
npx --yes pnpm@10.12.1 install --frozen-lockfile --ignore-scripts
```

Workspace packages consume exact `vendor/modkit-*.tgz` inputs pinned by `pnpm-lock.yaml`.
Keep tarballs and lockfile together. For changes, build the affected package and run focused tests.
Use the pinned pnpm for later commands, or invoke it with `npx --yes pnpm@10.12.1`.

## Command reference

| Command | Purpose / prerequisites |
| --- | --- |
| `pnpm run build:mpq` | Compile MPQ TypeScript entrypoints |
| `pnpm run build:casc` | Compile CASC installation/CDN/root entrypoints |
| `pnpm run build:models` | Build the M3 native library and adapter |
| `pnpm run build:warcraft-3` | Compile Warcraft III |
| `pnpm run build:diablo` | Compile Diablo |
| `pnpm run build:starcraft-1` | Compile StarCraft I |
| `pnpm run build:heroes` | Compile Heroes |
| `pnpm run build:world-of-warcraft` | Compile WoW |
| `pnpm run check:licenses` | Central license inventory and references |
| `pnpm run test:module-map` | SC2 module-map checks |
| `pnpm run test:tiers` | Test-tier routing checks |
| `pnpm run build` | Full build; needs the omitted local Galaxy API catalog |
| `pnpm run typecheck` | Full no-emit checks, with generated prerequisites |
| `pnpm run test:quick` | Full build, deterministic checks and quick suite |
| `pnpm run test:owner` | Full build and owner deterministic suites |
| `pnpm run test:real` | Opt-in installed-game/corpus suite |
| `pnpm run test:full` | Owner suite, then real suite |
| `pnpm run bundle:portable` | Package already built runtime outputs |
| `pnpm run check:pack` | Inspect distribution contents |

`pnpm check` is the largest composite check, not a public-clone quick start.
Read [PUBLICATION.md](PUBLICATION.md) for missing catalog/corpus prerequisites.
Current source and pinned platform packages may have compatibility gaps; retain actual diagnostics.

## Execute

There is no GUI, CLI or MCP-server binary in this extension repository. Install a compatible
Modkit application separately and load `modkit.repository.json`, or its individual package roots.
For a library-only smoke run from the installed checkout:

```sh
node --input-type=module -e "const m = await import('./casc/src/casc/index.js'); console.log(Object.keys(m))"
```

Use package export maps and READMEs for concrete operations. Distinguish portable exports from
Node-only entrypoints. Public host operations have schemas, budgets, revisions and loss reports;
discover them before invoking them. Keep one context/snapshot and release handles after use.

## Troubleshooting

- Missing Galaxy catalog/generated adapter: expected; the public generator requires the matching
  authorized JSON and does not extract it from an installed game.
- Missing `.m3`, `.m3a` or `.SC2Replay` fixture: see the omission list. Synthetic tests do not
  replace native-corpus validation, and missing inputs are not passing tests.
- `@modkit/*` type errors: check source/platform compatibility and retain diagnostics. Do not patch
  generated declarations or silently replace the pinned packages with an unrelated Core build.
- Installation not found: use host discovery or `MODKITX_SC2_ROOT`. This repo does not install games.
- Encrypted/unreadable entry: preserve the refusal; enumeration does not prove decode coverage.
- Operation unavailable: use the capabilities actually published by the selected host.

## Contributions

Keep one implementation per capability. Reuse format, archive, language and rendering owners.
Preserve validation, bounds, cancellation and explicit loss diagnostics. Add focused regressions
for behavior changes. Keep caches, credentials, generated outputs and local game assets out of Git.
Record provenance and preserve third-party notices when importing code.
