# Heroes of the Storm

Heroes of the Storm for Modkit.

- `providers/heroes-installation` — installation discovery (`common.game/installation-discovery`):
  the CASC build record (`hero`, or a `hero-*` CDN path), candidates from the host's probes and
  folder search.
- `src/game/content-sources.ts` — the installed storage as one tree (`local:heroes`), over the
  shared CASC installation reader.

Heroes runs on the StarCraft II engine: M3/M3A models are read by `blizzard/m3` (`../models`), maps
and mods (`.StormMap`, `.StormMod`) by the StarCraft II modules once they take Storm's names as game
data. Owner: the role the owner assigns (`../../AGENTS.md` §1).
