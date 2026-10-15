/**
 * Types for the StarCraft II DocumentHeader binary format.
 *
 * The DocumentHeader file appears inside every .SC2Mod, .SC2Campaign,
 * and .SC2Map MPQ archive at the path "DocumentHeader".
 *
 * Format fingerprint: magic bytes "H2CS" at offset 0.
 */

// ---------------------------------------------------------------------------
// Enums / constants
// ---------------------------------------------------------------------------

/**
 * Known flag values observed across 666 real files (661 parsed).
 * Flags live at offset 0x0C (uint16 LE).
 *
 * Bit correlations (derived from mods-analysis-results.json, R3):
 *   bit 0  (0x0001) — "standard/full" profile. Only ever set in 0x0501 and
 *                     0x0401. Present in every CAMPAIGN and the large
 *                     full-featured group (avg ~64 entries, up to 2191).
 *   bit 2  (0x0004) — map-only minimal profile. 0x0004 appears alone on 22
 *                     files, all MAP, all unknown3===0.
 *   bit 3  (0x0008) — "extended/custom" format. Set in 0x0008/0x0108/0x0308/
 *                     0x0408/0x0508. Never appears on a CAMPAIGN.
 *   bit 8  (0x0100) — rich-metadata profile. Set in the standard group plus
 *                     the website and extended-full variants.
 *   bit 9  (0x0200) — website present. Only ever set as part of 0x0308
 *                     (126 mods + 9 maps, avg ~36 entries).
 *   bit 10 (0x0400) — full entries section present. Set in 0x0401/0x0408/
 *                     0x0501/0x0508; always set on CAMPAIGN files.
 *
 * NOTE: file TYPE (MAP vs MOD/CAMPAIGN) is NOT carried by flags — it is the
 * `unknown3` field (0 = MAP, 2 = MOD/CAMPAIGN) that distinguishes them.
 */
export const KNOWN_FLAGS = {
  /** 0x0501 — bits 0+8+10. Most common (301 files); all 15 campaigns, plus
   *  full-featured mods/maps. Largest entry counts. */
  STANDARD: 0x0501,
  /** 0x0401 — bits 0+10. Rare (1 file, a 2-entry mod). Minimal standard. */
  ALT_STANDARD: 0x0401,
  /** 0x0408 — bits 3+10. Extended/custom mods only (98 files, all MOD). */
  EXTENDED: 0x0408,
  /** 0x0508 — bits 3+8+10. Extended + rich metadata (14 files, MOD+MAP). */
  EXTENDED_B: 0x0508,
  /** 0x0308 — bits 3+8+9. Website group (135 files, mostly MOD). bit 9 = website. */
  HAS_WEBSITE: 0x0308,
  /** 0x0008 — bit 3 only. Extended-minimal (89 files, MOD+MAP). */
  EXTENDED_MINIMAL: 0x0008,
  /** 0x0004 — bit 2 only. Map-only minimal profile (22 files, all MAP). */
  MAP_MINIMAL: 0x0004,
  /** 0x0108 — bits 3+8. Old/rare variant (1 file). */
  RARE_B: 0x0108,
} as const

/**
 * Known entry type codes (4-byte ASCII strings).
 * The meaning of these codes is under investigation.
 */
export const ENTRY_TYPES = {
  /** Most common — standard UTF-8 string values */
  SUNE: 'SUne',
  /** Loading screen tips — abab pattern */
  URUR: 'URur',
  /** MapInfo / DocInfo entries */
  RFRF: 'RFrf',
  EDED: 'EDed',
  SESE: 'SEse',
  XMSE: 'XMse',
  RKOK: 'RKok',
  NCHZ: 'NChz',
  WTHZ: 'WThz',
  LPLP: 'LPlp',
  TITI: 'TIti',
  RBTP: 'RBtp',
} as const

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

/** A single key-value entry in the entries section. */
export interface DocumentHeaderEntry {
  /** ASCII key string, e.g. "DocInfo/Name", "MapInfo/Author" */
  key: string
  /** 4-byte ASCII type code, e.g. "SUne", "URur" */
  type: string
  /** UTF-8 value string */
  value: string
}

/**
 * Parsed representation of a DocumentHeader file.
 *
 * Field confidence notes (updated after the R1–R4 verification pass):
 * - `magic`, `unknown2`, `dependencies`, `entries` — 100% understood
 * - `timestamp1/2` — 95% SC2 build numbers (range 0–96592). NOTE: an earlier
 *   research doc mistook this field (offset 0x10) for a "mod-type hash" because
 *   build numbers fall in the 0x0001xxxx range. That doc is wrong; 0x10 is the
 *   build number, the real hash is at 0x1C.
 * - `unknown1` — 95% format version (always 8 in every observed file)
 * - `unknown3` — 95% file-type indicator (0 = MAP, 2 = MOD/CAMPAIGN); this,
 *   not `flags`, is what separates maps from mods/campaigns.
 * - `flags` — 8 unique values; bit correlations documented in KNOWN_FLAGS (R3).
 * - `headerSize` — R1 RESOLVED: it is NOT a byte offset to the entries section.
 *   247/661 files have headerSize > fileSize, which is impossible for an offset.
 *   It correlates strongly with `timestamp` (newer builds → larger values), so
 *   it is a build/version artifact. The parser locates entries by scanning, not
 *   by trusting this field.
 * - `hash1/hash2` — content checksum, algorithm UNIDENTIFIED (R2). 590 unique
 *   values across 661 files spanning the full 32-bit range; byte-identical
 *   files share identical hashes (so it IS content-derived), but it does not
 *   match standard CRC-32 (any common variant), Adler-32, FNV-1a, or the MPQ
 *   hash over the whole file or any contiguous byte range. Treated as an opaque
 *   passthrough — preserved on write, never recomputed.
 * - `reserved` — 8 bytes at 0x24. Zero in mods/campaigns, but the uint32 at
 *   0x24 carries a small nonzero value in some MAP files (purpose unknown), so
 *   it is preserved verbatim to allow byte-exact round-tripping.
 */
export interface DocumentHeaderData {
  /** "H2CS" — "SC2H" reversed */
  magic: string
  /** Format version; always 8 in observed files */
  unknown1: number
  /** SC2 ASCII signature: 0x5332 = "S2" */
  unknown2: number
  /** Feature bitmask; 8 known variants (see KNOWN_FLAGS) */
  flags: number
  /** Build/version-correlated field at 0x0E. NOT an offset to entries (R1). */
  headerSize: number
  /** SC2 build number when file was created/compiled */
  timestamp1: number
  /** Duplicate of timestamp1 in most files */
  timestamp2: number
  /** File-type indicator: 0 = map files, 2 = mods/campaigns */
  unknown3: number
  /** Content checksum (opaque; algorithm unidentified). Preserved, not recomputed. */
  hash1: number
  /** Usually equals hash1; sometimes differs */
  hash2: number
  /** 8 reserved bytes at 0x24. Usually zero; preserved verbatim for round-trip. */
  reserved: Uint8Array
  /** Null-terminated UTF-8 dependency strings */
  dependencies: string[]
  /** Ordered key-value entries */
  entries: DocumentHeaderEntry[]
}

/** Options for the writer. */
export interface DocumentHeaderWriteInput {
  magic?: string
  unknown1?: number
  unknown2?: number
  flags: number
  headerSize: number
  timestamp1: number
  timestamp2: number
  unknown3?: number
  hash1: number
  hash2: number
  /** Optional 8 reserved bytes at 0x24. Defaults to zeros when omitted. */
  reserved?: Uint8Array
  dependencies: string[]
  entries: Array<{ key: string; type: string; value: string }>
}

// ---------------------------------------------------------------------------
// .version sidecar format
// ---------------------------------------------------------------------------

/**
 * Parsed representation of a `.version` sidecar file.
 *
 * Every named file in an SC2 archive has a companion `.version` file at
 * `<path>.version`. It tracks per-file version metadata including the SC2
 * build number, SC2 version tuple, component entry count, and timestamp.
 *
 * Exists in three fixed-size format variants:
 *   - v0: 36 bytes (oldest known layout)
 *   - v1: 40 bytes (adds patch version and entry count)
 *   - v2: 44 bytes (adds duplicate build number)
 *
 * Deprecated aliases are retained for compatibility with older modkitx callers
 * that used the previous, incorrect field names.
 */
export interface VersionFileData {
  /** Raw 4-byte type tag at offset 4, e.g. "girt" = Triggers */
  typeTag: string
  /** Format version: 0 = 36-byte layout, 1 = 40-byte layout, 2 = 44-byte layout */
  formatVersion: 0 | 1 | 2
  /** SC2 build number. */
  buildNumber: number
  /** SC2 major version from the serialized version tuple. */
  majorVersion: number
  /** SC2 minor version from the serialized version tuple. */
  minorVersion: number
  /** SC2 patch version. Zero in v0 because that layout does not store it. */
  patchVersion: number
  /** Duplicate build number in v2. Zero in v0/v1 because those layouts do not store it. */
  buildNumber2: number
  /** Component data entry count. Zero in v0 because that layout does not store it. */
  entryCount: number
  /** Unix timestamp. */
  timestamp: number
  /** Terminal field from the fixed-size record. */
  terminal: number
  /** Number of bytes consumed by the fixed-size record. */
  bytesConsumed: number
  /** @deprecated Use `buildNumber`. */
  buildCreated: number
  /** @deprecated Use `majorVersion`. */
  unknown1: number
  /** @deprecated Use `minorVersion`. */
  unknown2: number
  /** @deprecated Use `patchVersion`. */
  schemaVersion: number
  /** @deprecated Use `buildNumber2`; for v0/v1 this mirrors `buildNumber`. */
  buildLastSaved: number
  /** @deprecated Use `entryCount`. */
  changeCount: number
  /** @deprecated Use `timestamp`. The old parser incorrectly treated this offset as a hash. */
  contentHash: number
}

/** Options for writing a `.version` file. */
export interface VersionFileWriteInput {
  /** Raw 4-char type tag, e.g. "girt". Use `typeTagFor()` to look up by name. */
  typeTag?: string
  /** Human-readable component/file type, e.g. "Triggers" or "GameData". */
  fileType?: string
  /** Archive path or filename, e.g. "MapInfo.version" or "Base.SC2Data/UI/Layout/DescIndex.version". */
  versionPath?: string
  /** Format version. Default: 2 (44-byte layout). */
  formatVersion?: 0 | 1 | 2
  /** SC2 build number. Preferred name. */
  buildNumber?: number
  /** Default: 5. */
  majorVersion?: number
  /** Default: 0. */
  minorVersion?: number
  /** Default: 0. Written only for v1/v2. */
  patchVersion?: number
  /** Default: `buildNumber`. Written only for v2. */
  buildNumber2?: number
  /** Default: 0. Written only for v1/v2. */
  entryCount?: number
  /** Unix timestamp. Default: 0. */
  timestamp?: number
  /** Default: 0 for v0, 1 for v1/v2. */
  terminal?: number
  /** @deprecated Use `buildNumber`. */
  buildCreated?: number
  /** @deprecated Use `majorVersion`. */
  unknown1?: number
  /** @deprecated Use `minorVersion`. */
  unknown2?: number
  /** @deprecated Use `patchVersion`. */
  schemaVersion?: number
  /** @deprecated Use `buildNumber2`. */
  buildLastSaved?: number
  /** @deprecated Use `entryCount`. */
  changeCount?: number
  /** @deprecated Use `timestamp`. The old parser incorrectly treated this offset as a hash. */
  contentHash?: number
}
