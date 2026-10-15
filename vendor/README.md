# Pinned Modkit platform packages

These exact platform tarballs allow installing the Blizzard workspace without a
neighboring Core checkout or private registry. The project owner authorized the
original Modkit payloads under MIT for this public source publication (2026-10-15).
Each archive includes an MIT grant; third-party components retain their own licenses.

Publication changed license metadata/notices, not runtime payloads. Tarball integrity
values were refreshed in the lockfile. Keep these tarballs and `pnpm-lock.yaml` together.
For an ABI upgrade, regenerate them from the matching platform source and verify the
extension consumers. They contain build dependencies, not Blizzard game assets.
