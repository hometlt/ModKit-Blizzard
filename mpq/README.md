# Blizzard MPQ codec

Product-owned MPQ namespace codec with bounded listing and entry extraction. The live StarCraft II
acceptance opens an `.s2ma` extracted from CASC, lists its archive namespace and decodes an embedded
DDS image without modifying the installation.

Ordinary codec open also has a bounded recovery path for archives whose valid classic MPQ header
points to truncated or structurally invalid hash/block tables. Recovery accepts only a complete
chain of independently validated zlib or bzip2 single-unit payloads, publishes every payload under
a stable `recovered/block/NNNN` ID, and reports `recovery: true` with `complete: false`. A
listfile-looking payload may supply unverified path hints for inspection, but those hints never
assign a filename to a block. Scan bytes, candidates, blocks, boundary probes, decode attempts,
per-entry output, total output, and cancellation are all bounded. Zero-block results, incomplete
chains, stored or sectorized data, encrypted/implode/patch payloads, high-offset tables, and limit
exhaustion fail closed. `./recovery` exports the same public recovery function name as MK2 while
replacing MK2's unbounded scans, synthetic hashes, positional owner guesses, and empty success with
validated read-only behavior.

The standalone utility defaults to a 64 MiB scan, 131,072 candidates, 16,384 recovered blocks, 64
boundary probes per block, 262,144 decode attempts, 16 MiB per decoded entry, and 64 MiB of total
decode work. Byte limits have a 1 GiB hard ceiling; candidates, blocks, and decode attempts have a
1,000,000 hard ceiling; boundary probes have a 4,096 hard ceiling. It recognizes at most 32 classic
16-byte digest gaps per block and checks cancellation during scanning, zlib output/checksums, and
bzip2 output. Ordinary codec open further clamps these bounds to the host byte and node budgets.
Recovery refusal uses `blizzard/mpq-recovery-failed`, limit exhaustion uses
`blizzard/mpq-recovery-limit`, and recovered writes use
`blizzard/mpq-recovered-write-unsupported`.

The export-only writer can Save As one complete bounded loose namespace into a fresh, deterministic
MPQ v0. Every enumerated entry payload is stored byte-for-byte as an uncompressed, unencrypted
single unit and the writer generates a listfile plus classic encrypted hash/block tables. A second
bounded path accepts an existing MPQ v0–v3 (v3 is what StarCraft II saves maps and mods as) and
replaces uniquely named entries in their original slots while preserving every untouched byte. An
entry that outgrows its slot moves to where the tables began and the tables follow it. In v3 the
BET records of changed entries, the raw-chunk MD5s and the header's MD5s of the block table, BET
table and header are rewritten; HET and hash tables stay byte-identical. Stored and zlib layouts
are written as they were; a bzip2 entry is written with zlib (no bzip2 encoder), named in the
receipt. Changed encrypted, implode, patch, non-empty sector-checksum, compressed-table or
high-offset data fail before a destination write. Opaque attributes and signatures
are copied but explicitly reported as invalidated when content changes, and signing and in-place
mutation are not claimed. Both paths reopen their output through the product codec, use the host's
atomic Save As workflow, and support undo.

The codec's published `container.pack` handler also closes the legacy `archive.write` creation
surface. An application creates a zero-byte path with the exact `.mpq` extension, opens it through
normal inventory with read/write permission, and invokes the descriptor's standard operation. The
creation session exposes only `container.pack`; inspect, validate, extract, and raw export remain
disabled until the returned outer edit plan is committed and reopened. Nonempty malformed `.mpq`
files and empty aliases such as `.SC2Map` remain detection failures.

`{schemaVersion: 1, mode: "create", expectedContainerRevision, files}` treats `files` as the complete
new archive: each item is exactly `{name, bytesBase64}`, names use portable ASCII relative paths,
payloads use canonical standard base64, and `(listfile)` is reserved and generated. The list may be
empty. File count, hash-table nodes, each decoded payload, total input, output, and cancellation are
bounded by the open codec budget, with a 1 GiB output ceiling. One shared encoder state machine
produces synchronous and cooperative output; the write route yields after bounded byte/operation
work so cancellation delivered after encoding starts is observed. Paths are sorted so input order
does not affect bytes. The edit plan replaces the revision-pinned opened source and reports
`preservesUnknownData: false` because entries omitted from the explicit list are discarded.
Omitting `mode` retains the existing revision-pinned replacement flow. Compression controls,
`listfile: false`, raw/precompressed flags, unnamed blocks, encryption, sector layouts, patches,
high offsets, and signing options are refused with `blizzard/mpq-fresh-pack-unsupported`.

Recovered sessions cannot use `container.pack`: without intact native tables there is no safe proof
of filename ownership, aliases, opaque records, or fixed slots. Raw export still returns the exact
damaged source bytes, and recovered synthetic entries can be extracted byte-for-byte.

`./native-preserving` additionally exports a bounded read-only named snapshot helper used by
semantic archive editors. It applies the same table parsing, decompression, path validation,
cancellation and byte ceilings as the writer; reports the exact source SHA-256 digest and namespace
coverage; and distinguishes a complete uniquely named snapshot from filtered, unnamed, aliased or
opaque internal data. Callers can therefore edit only the documents they understand without
pretending that unknown archive content was decoded.

The named Blizzard signature policy is deliberately narrow: internal and external signature bytes
are preserved as opaque data byte-for-byte, while every modified archive receipt reports
`invalidated-by-modification`. Modkit never creates, repairs, or recomputes a Blizzard signature;
only an official Blizzard tool may produce a signature the product may describe as valid.

The snapshot helper accepts only portable ASCII relative paths (1,024 characters maximum), reserves
its generated `(listfile)`, enforces explicit entry and byte budgets, and requires the loose source
to expose a pinned revision plus `currentRevision`. The revision is checked before listing, after
every page, after listing, after every entry read, and again after all reads; a missing or changing
source fails closed with `blizzard/mpq-source-snapshot-unstable` before any destination
change is planned.

Historical conversion receipts remain in the archived source workspace and are not shipped with
the runtime extension.
