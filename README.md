# ModKit Blizzard

Blizzard game and file-format extensions for **Modkit MK3**: archive access, textures,
models, maps and mods, language services, resolved game data, and conversion through
Modkit's common model and world representations (UVM/UVW).

This is an **extension workspace**, not a standalone game editor or game executable.
Use its libraries from Node.js or load the extension directories in a compatible Modkit
host. Game installations and game assets are supplied separately.

Repository: [hometlt/ModKit-Blizzard](https://github.com/hometlt/ModKit-Blizzard).
The checkout name `modkit-extensions-blizzard` and existing package/extension IDs remain
stable so downstream tooling keeps its existing identities.

## Packages

| Directory | Scope |
| --- | --- |
| [`casc`](casc) | CASC namespaces, installation/CDN readers, cached access and supported writing |
| [`mpq`](mpq) | MPQ reading, recovery and native/preserving writer routes |
| [`models`](models) | SC2 M3/M3A geometry, animation, materials, native encoding and UVM projection |
| [`starcraft2`](starcraft2) | Maps, mods, campaigns, Data, Galaxy, Triggers, Layout, Style, Strings, Banks, Wizard, replays and cutscenes |
| [`blizzard-common-formats`](blizzard-common-formats) | Shared formats, including BLP textures and replay protocol tables |
| [`blizzard-warcraft-3`](blizzard-warcraft-3) | Warcraft III MDX/MDL and supported map/world formats |
| [`blizzard-starcraft-1`](blizzard-starcraft-1) | StarCraft I formats and game integration |
| [`blizzard-world-of-warcraft`](blizzard-world-of-warcraft) | WoW content access and supported M2/SKIN/ANIM/SKEL routes |
| [`blizzard-diablo`](blizzard-diablo) | Diablo III APP/TEX and related supported formats |
| [`blizzard-heroes`](blizzard-heroes) | Heroes of the Storm contributions |
| [`subjects`](subjects) | Vendor and game declarations |
| [`vendor`](vendor) | Pinned Modkit platform dependencies |

The canonical inventory is [`modkit.repository.json`](modkit.repository.json).
Source coverage is not a claim of complete support for every game version, shader,
animation, encryption mode or gameplay behavior. Read individual package documentation,
operation schemas and loss diagnostics for supported profiles.

## Install

Requirements: **Node.js >=22**, **pnpm 10.12.1**, and Git. Windows is the primary development
environment; portable/browser exports exist, but native installation integration varies by platform.

```sh
git clone https://github.com/hometlt/ModKit-Blizzard.git modkit-extensions-blizzard
cd modkit-extensions-blizzard
npx --yes pnpm@10.12.1 install --frozen-lockfile --ignore-scripts
```

The command pins pnpm without changing your global installation. For subsequent commands,
use pnpm 10.12.1 (or prefix them with `npx --yes pnpm@10.12.1`). Dependency lifecycle scripts
are disabled in this tested setup; the focused builds below do not need them.
Pinned platform tarballs are included: their dependencies do not require a sibling
`modkit-core` checkout or private npm registry.

## Build and run a library

Build the archive packages independently:

```sh
pnpm run build:mpq
pnpm run build:casc
```

Inspect public CASC exports from the checkout without opening any game:

```sh
node --input-type=module -e "const m = await import('./casc/src/casc/index.js'); console.log(Object.keys(m))"
```

Other package builds: `build:models`, `build:warcraft-3`, `build:diablo`, `build:starcraft-1`,
`build:heroes`, and `build:world-of-warcraft`. See each package's `package.json` exports and
README for its API. A successful import proves loading, not native game fidelity.

**Read the public-source limitations before running the full `pnpm build` or `pnpm test`.**

## Use with Modkit / MCP

This workspace has no `pnpm start` command. A compatible Modkit application supplies the host,
VFS, lifecycle, renderer and authoring policy. Add the repository through that application's
external-extension mechanism using `modkit.repository.json`, or configure required extension
directories individually. A parent repository is not itself one extension package.

For an already installed compatible **Modkit MCP application**, its public stdio interface is:

```sh
modkit-mcp --root /absolute/path/to/your/maps --extension /absolute/path/to/modkit-extensions-blizzard/starcraft2
```

`modkit-mcp` belongs to the separate Modkit application and is **not shipped here**. Connect an
MCP client to stdio. Discover `modkit.capabilities`, open the selected subject, inspect its
descriptor, then use only advertised operations and their input schemas. Content composed from
installed-game dependencies needs that host's documented content-source configuration.

Start with inspection. Editing follows the host's explicit propose/prepare/commit policy;
previews and successful writes do not prove reopen fidelity. Close subjects and release retained
outputs. Keep one snapshot for related facts, report partial results, and retain conversion losses.
Do not guess operation IDs or bypass the host with private providers.

## Public-source limitations

This initial public repository is a clean source snapshot rather than internal development history.
It omits artifacts with unresolved redistribution provenance: the game-derived Galaxy native API
catalog/adapter, genuine legacy M3A and unreviewed M3 fixtures, and recorded replay fixtures.
Original source and synthetic fixtures remain. Exact paths and consequences are listed in
[`docs/PUBLICATION.md`](docs/PUBLICATION.md).

The full build calls `galaxy-native-api:generate`, which requires an authorized local
`starcraft2/modules/galaxy/data/galaxy-script-api.v1.json` with the expected 3,341-function schema.
**The generator does not extract a catalog from an installed game.** Full builds, prepack,
Galaxy native-API services and catalog-dependent tests require this separately supplied input.
There is no empty-catalog fallback. Corpus tests similarly require their omitted local fixtures.
Do not substitute arbitrary game files or silently skip these failures.

## Tests and development

Small repository checks that do not launch a game:

```sh
pnpm run test:public
```

The initial publication passed these seven checks, both MPQ/CASC builds and the CASC import
on Windows with Node.js 24.16.0 and pnpm 10.12.1. See [verification details](docs/VERIFICATION.md).

[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) lists build/test commands and troubleshooting.
`pnpm test` runs `test:quick`, which starts with the **full build**; it is not a fresh-public-clone
smoke command. `pnpm check` includes the full/corpus suite and distribution checks.

Installed-game tests are opt-in. Select a local installation through the host or set
`MODKITX_SC2_ROOT`. PowerShell example (requires the local catalog/corpus prerequisites):

```powershell
$env:MODKITX_SC2_ROOT = 'F:\GAMES\Blizzard\StarCraft II'
pnpm run test:real
```

`pnpm run bundle:portable` consumes already built extension outputs. Packaging does not compile
the source or prove native rendering/gameplay fidelity. Keep license notices with distributions.

## License and attribution

Original Modkit source and original Modkit platform bundles are available under [MIT](LICENSE),
except for explicitly identified components. The M3 package includes GPL-2.0-only material;
Warcraft III cliff code adapted from Warsmash retains AGPL-3.0 terms. Other vendored code retains
its own notices. A root MIT grant does not relicense these components.

Read [`licenses/README.md`](licenses/README.md),
[`licenses/THIRD-PARTY-NOTICES.md`](licenses/THIRD-PARTY-NOTICES.md), and
[`REFERENCES.md`](REFERENCES.md). Blizzard trademarks and game content are not licensed by this
repository. This independent project is not affiliated with or endorsed by Blizzard Entertainment.
