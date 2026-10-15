import { describe, expect, it } from 'vitest'

import { composePublicationHeader } from '../publishing/header-composer.js'

/**
 * A real publication header, as Battle.net serves it for a published mod with one dependency and
 * no lobby of its own. It is the smallest shape the StarCraft II Editor produces, and the shape a
 * first publication from Modkit has to match exactly.
 */
const PUBLISHED_HEADER = Buffer.from(
  'BQQABSgABQQACfCMIAIJiIAIAgIcVEVTVExJQi5TQzJNb2QEAlBzMm1hAABFVV+GxCKL6qL8DHs+xhjUhJT4ZwbC59IZ' +
  'dPdkt2R0EzK2BgnelykIBRgABQYABAACCQAECQICBQYABAACCQAECQQEBAAGBAEFCgAJAAIJAAQJAAYJMAgJMAgJIAoJ' +
  'LAwAAA4AAgJQczJtdgAARVWd8GGndXXjX7AV+99DziAdO6MT4dRzjhQQqYMrdzpfjxAAAgUEAAdlblVTAgACAlBzMm1s' +
  'AABFVRb+rXWYAtyPVFSIp3ed6IL6t/EVRfFWS9Dwd2/9MwW8EgAAFAAAFgAACgAADgAAEAACBQQAB2VuVVMCAAICUHMy' +
  'bWwAAEVVFv6tdZgC3I9UVIind53ogvq38RVF8VZL0PB3b/0zBbwSBAAUBAAYCQAaAAIFIAAFBAAJAgIJAgIFBgAEAAIJ' +
  'AAQJAAQFBgAEAAIJAAQJAAYEAAgEAAoFBgAEAAIEAAQEAAwAAA4AABAJAhIAABQAABYAABgEABoEABwEAB4AABwAAgUE' +
  'AAkCAgkAHgYBIAAAIgAAJAAAJgQALAYALgAAAgUCAAYA',
  'base64',
)

describe('composing a publication header', () => {
  it('produces exactly what the editor produced for a published mod', () => {
    const composed = composePublicationHeader({
      identity: { id: 262968, version: 65540 },
      fileName: 'TESTLIB.SC2Mod',
      region: 'eu',
      archiveSha256: '5f86c4228beaa2fc0c7b3ec618d48494f86706c2e7d21974f764b764741332b6',
      namespace: 337391,
      locales: [{ locale: 'enUS', sha256: '16fead759802dc8f545488a7779de882fab7f11545f1564bd0f0776ffd3305bc' }],
      previews: [{ sha256: '9df061a77575e35fb015fbdf43ce201d3ba313e1d4738e1410a9832b773a5f8f' }],
      // m_extraDependencies: the one published document this mod depends on.
      dependencies: [{ id: 1, version: 0 }],
      // m_variants is left at the single default a document without a lobby carries.
    })

    // Byte for byte: a header Battle.net has already accepted, rebuilt from what a publisher knows.
    expect(Buffer.from(composed).toString('base64')).toBe(PUBLISHED_HEADER.toString('base64'))
  })

  it('refuses a header with no locale, because the publication would have no name', () => {
    expect(() =>
      composePublicationHeader({
        identity: { id: 0, version: 0 },
        fileName: 'Example.SC2Mod',
        region: 'eu',
        archiveSha256: '0'.repeat(64),
        namespace: 1,
        locales: [],
      }),
    ).toThrow(/at least one locale/u)
  })
})
