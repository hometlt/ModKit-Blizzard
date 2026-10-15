# Replay fixture

The four top-level representative user replays verify MPQ opening, header build discovery,
tracker-event decoding, timeline construction and scene sampling across recent replay builds.
Builds 95299 and 97425 have bundled exact protocols; builds 95841 and 96883 exercise the
protocol-independent tracker route. Exact protocol and unsupported-build behavior is covered by
the s2protocol/Replay composition tests.

| Fixture | Base build | SHA-256 | Original workspace source |
|---|---:|---|---|
| `Tokamak-LE.SC2Replay` | 95299 | `0ef6ac92c5d70bde0b19f801bcaf718110c9510fae3f7f170b2769c516d54afd` | `references/replays/Tokamak LE (9).SC2Replay` |
| `Taito-Citadel-LE.SC2Replay` | 95841 | `f4ab97e8cf287eaeda9623e882e6193a58141fb18e79116387b8409d34938204` | `references/replays/Taito Citadel LE (28).SC2Replay` |
| `Lost-on-the-Horizon-FFA.SC2Replay` | 96883 | `2e24ce803a317e7da12acab142e242df9b708c0bbc41a7060470ce26ccb1b1dd` | `references/replays/[HypONE] [FFA] Lost on the Horizon (2).SC2Replay` |
| `Gresvan-LE.SC2Replay` | 97425 | `9d7f14100595fd8f62aa1a3948f8593a9abd44407954c83d87ae1cd2087a796c` | `references/replays/Gresvan LE (478).SC2Replay` |

The tests consume checked-in copies so execution does not depend on an installed game or a
mutable external directory.

`early/Wings-of-Liberty-1.1.0.SC2Replay` is the 9,725-byte build-16561 fixture
`test_replays/1.1.0.16561/Froadac_vs_Shields_5952.SC2Replay` from
`ggtracker/sc2reader@e10fc9344417d0aa9649e4ed8d6423e38f6af4c9`. SHA-256:
`bb51ac860acafa7605c47d49fd5d3faa5a6c1021e4eeb866ebdfef046d0d2881`. It verifies early Wings of
Liberty exact protocol composition; tracker timeline assertions do not apply because tracker events
were introduced after this replay family.
