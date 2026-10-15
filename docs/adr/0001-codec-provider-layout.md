# ADR 0001: codec and provider module layout

Status: accepted, 2026-09-10.

Each extension may contain `codecs/<format>/` and `providers/<service>/` modules. A codec
opens bytes or a namespace and deterministically publishes representations. Its runtime has
no ambient filesystem, network, credential or process-launch authority. A provider supplies a
service over codecs or host state and may request those permissions explicitly.

Each codec module owns `codec.json`, `src/`, `test/`, optional fixtures and a README. Each
provider module owns `provider.json` and the same local support directories. Extension
`contributionManifests` uses bounded patterns such as `./codecs/*/codec.json` and
`./providers/*/provider.json`. Core permits one complete wildcard directory segment and keeps
realpath confinement.

Format parsers and writers remain pure. Host access stays in adapters and providers. Shared
format-neutral algorithms move to codec-kit or UV/scene packages after at least two consumers
and parity evidence exist. Game or vendor semantics remain in their owning extension.

The repository gate `scripts/check-codec-provider-split.mjs` validates the directory contract,
manifest contract type, and forbidden codec permissions. Existing legacy roots migrate in
bounded groups; the gate applies immediately to every module placed under `codecs/` or
`providers/`.
