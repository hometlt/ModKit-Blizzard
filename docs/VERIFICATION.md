# Initial publication verification

Date: 2026-10-15. Environment: Windows, Node.js 24.16.0, pnpm 10.12.1.
Checks ran in a fresh source snapshot with its own installed dependencies, without the
shared development checkout's generated outputs or uncommitted changes.

| Check | Result |
| --- | --- |
| Pinned pnpm frozen-lockfile install, lifecycle scripts disabled | Exit 0 |
| `test:public` underlying Node test files | 7 passed, 0 failed, 0 skipped |
| `build:mpq` underlying local TypeScript command | Exit 0, no diagnostics |
| `build:casc` underlying local TypeScript command | Exit 0, no diagnostics |
| README CASC public-module import | Exit 0, exports printed |
| Publication operation/contribution manifests | 124 compared, unchanged |
| Package export maps | Semantically unchanged |
| Original platform archive runtime files | Byte-identical; license metadata/notices changed |

The install reports expected missing-bin warnings for SC2 bank/Galaxy CLI entrypoints
because the checkout has no compiled SC2 `dist` yet. Those CLIs are not an advertised
working quick start for this limited source snapshot.

This confirms installation, selected compilation and module loading only. The full
build, full test suite, omitted native model/replay corpus, installed-game behavior,
editor rendering, and gameplay fidelity were not validated for this publication.
See [PUBLICATION.md](PUBLICATION.md) for catalog/corpus prerequisites.

The inherited source contains pre-existing whitespace differences, including intentional
CRLF fixtures and vendored sources. They were not mass-formatted during publication.
