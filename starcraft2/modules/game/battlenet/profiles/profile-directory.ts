/**
 * Names and portraits of StarCraft II profiles seen in lobbies, from Blizzard's official Web API
 * (`GET /sc2/metadata/profile/{region}/{realm}/{id}` → `name`, `profileUrl`, `avatarUrl`). The lobby
 * protocol carries only the profile handle; the portrait lives in the profile. The API needs an API
 * client of the user's own (https://develop.battle.net/access/clients): its id and secret come from
 * the host's settings, never from this code, and appear in no error or log text.
 */
import type { BattleNetProfileHandle } from '../content-sources/vfs-provider.js'

export interface ProfileApiCredentials {
  readonly clientId: string
  readonly clientSecret: string
}

export interface BattleNetProfileSummary {
  readonly name?: string
  /** https URL of the profile's portrait image. */
  readonly avatarUrl?: string
  readonly profileUrl?: string
}

export interface ProfileDirectoryOptions {
  readonly fetch?: typeof fetch
  readonly now?: () => number
}

const API_HOST: Readonly<Record<number, string>> = { 1: 'us.api.blizzard.com', 2: 'eu.api.blizzard.com', 3: 'kr.api.blizzard.com' }
const FOUND_SECONDS = 6 * 3600
const MISSING_SECONDS = 3600
const PARALLEL = 4

export const profileKey = (profile: BattleNetProfileHandle): string => `${profile.region}-${profile.realm}-${profile.id}`

const httpsUrl = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.length > 512) return undefined
  try { return new URL(value).protocol === 'https:' ? value : undefined } catch { return undefined }
}

export class ProfileApiError extends Error {}

export function createProfileDirectory(credentials: ProfileApiCredentials, options: ProfileDirectoryOptions = {}) {
  if (!credentials.clientId || !credentials.clientSecret) throw new ProfileApiError('Blizzard API client id and secret are required')
  const request = options.fetch ?? fetch
  const now = options.now ?? (() => Date.now() / 1000)
  let token: { value: string; expires: number } | undefined
  let tokenPending: Promise<string> | undefined
  const cache = new Map<string, { at: number; summary: BattleNetProfileSummary | null }>()
  const pending = new Map<string, Promise<BattleNetProfileSummary | null>>()
  let running = 0
  const waiting: (() => void)[] = []

  async function accessToken(signal: AbortSignal): Promise<string> {
    if (token && token.expires - 60 > now()) return token.value
    tokenPending ??= (async () => {
      try {
        const response = await request('https://oauth.battle.net/token', {
          method: 'POST', signal,
          headers: { authorization: `Basic ${btoa(`${credentials.clientId}:${credentials.clientSecret}`)}`,
            'content-type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=client_credentials',
        })
        if (!response.ok) throw new ProfileApiError(`Blizzard API refused the client (${response.status})`)
        const answer = await response.json() as { access_token?: unknown; expires_in?: unknown }
        if (typeof answer.access_token !== 'string' || typeof answer.expires_in !== 'number') throw new ProfileApiError('Unexpected Blizzard API token answer')
        token = { value: answer.access_token, expires: now() + answer.expires_in }
        return token.value
      } finally { tokenPending = undefined }
    })()
    return tokenPending
  }

  async function slot<T>(work: () => Promise<T>): Promise<T> {
    if (running >= PARALLEL) await new Promise<void>(done => waiting.push(done))
    running++
    try { return await work() } finally { running--; waiting.shift()?.() }
  }

  async function lookup(profile: BattleNetProfileHandle, signal: AbortSignal, retried = false): Promise<BattleNetProfileSummary | null> {
    const host = API_HOST[profile.region]
    if (!host || !Number.isSafeInteger(profile.realm) || !/^\d{1,20}$/.test(profile.id)) return null
    const response = await request(`https://${host}/sc2/metadata/profile/${profile.region}/${profile.realm}/${profile.id}?locale=en_US`,
      { signal, headers: { authorization: `Bearer ${await accessToken(signal)}` } })
    if (response.status === 401 && !retried) { token = undefined; return lookup(profile, signal, true) }
    if (response.status === 404) return null
    if (!response.ok) throw new ProfileApiError(`Blizzard API answered ${response.status}`)
    const answer = await response.json() as Record<string, unknown>
    const name = typeof answer['name'] === 'string' && answer['name'].length <= 64 ? answer['name'] : undefined
    const avatarUrl = httpsUrl(answer['avatarUrl']), profileUrl = httpsUrl(answer['profileUrl'])
    return { ...(name === undefined ? {} : { name }), ...(avatarUrl === undefined ? {} : { avatarUrl }),
      ...(profileUrl === undefined ? {} : { profileUrl }) }
  }

  return {
    /**
     * Summaries of the given profiles, keyed by `profileKey`; null for a profile the API does not
     * know. Answers are kept for hours; a failing API rejects and nothing is kept.
     */
    async describe(profiles: readonly BattleNetProfileHandle[], signal: AbortSignal): Promise<Map<string, BattleNetProfileSummary | null>> {
      const result = new Map<string, BattleNetProfileSummary | null>()
      await Promise.all(profiles.map(async profile => {
        const key = profileKey(profile)
        const kept = cache.get(key)
        if (kept && now() - kept.at < (kept.summary ? FOUND_SECONDS : MISSING_SECONDS)) { result.set(key, kept.summary); return }
        let promise = pending.get(key)
        if (!promise) {
          promise = slot(() => lookup(profile, signal)).then(summary => {
            cache.set(key, { at: now(), summary })
            return summary
          }).finally(() => pending.delete(key))
          pending.set(key, promise)
        }
        result.set(key, await promise)
      }))
      return result
    },
  }
}

export type ProfileDirectory = ReturnType<typeof createProfileDirectory>
