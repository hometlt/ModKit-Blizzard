# Blizzard CASC codec

Product-owned read-only CASC namespace codec. The SC2 contribution opens installed StarCraft II
storage, exposes bounded namespace paging and extracts entries without changing game files. The
portable package reader recognizes MNDX, TVFS, Diablo III and StarCraft: Remastered root formats.
Missing local encoding keys can use a host-injected CDN fetcher; container and decoded output
limits still apply, and cancellation is checked around each fetch. Encrypted BLTE chunks and TVFS
multi-span file reads fail closed.

The main package export includes the encoding/install parsers, path maps, cache policy, size
estimator and install-reader adapter. Node-only `./cache-node` and `./root-cache-node` exports own
filesystem caching. `./writer` creates a portable patch bundle and overlay; it does not mutate an
installed Blizzard CASC tree or add a write operation to the codec contribution.

Live acceptance uses `MODKITX_SC2_ROOT` and reports a visible skip when no installation is
available.

Historical conversion receipts remain in the archived source workspace and are not shipped with
the runtime extension.
