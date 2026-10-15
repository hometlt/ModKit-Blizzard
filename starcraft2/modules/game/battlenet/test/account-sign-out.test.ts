import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BattleNetAccountsProvider } from '../accounts/account-provider.js'
import type { BattleNetLoginBackend } from '../accounts/account-provider.js'

/** A backend that keeps a sign-in records what it was told to drop, and never logs anyone in. */
function backend(forgotten: (string | undefined)[]): BattleNetLoginBackend {
  return {
    supportedRegions: ['us', 'eu', 'kr'],
    login: () => Promise.reject(new Error('This test never logs in')),
    forget: async region => { forgotten.push(region) },
  }
}

const provider = (forgotten: (string | undefined)[]) =>
  new BattleNetAccountsProvider({
    authentication: backend(forgotten),
    cacheDirectory: join(tmpdir(), 'modkit-sign-out-test'),
  })

describe('Battle.net sign-out', () => {
  it('drops a kept sign-in for the region signed out of', async () => {
    const forgotten: (string | undefined)[] = []
    const accounts = provider(forgotten)
    await accounts.logout('account-1', 'eu')
    expect(forgotten).toEqual(['eu'])
    await accounts.logout('account-1')
    expect(forgotten).toEqual(['eu', undefined])
  })

  it('forgets every region when all accounts are signed out', async () => {
    const forgotten: (string | undefined)[] = []
    const accounts = provider(forgotten)
    await accounts.logoutAll()
    expect(forgotten).toEqual([undefined])
  })

  /** Closing the application must not sign the account out of Battle.net. */
  it('keeps the sign-in when the provider is disposed', async () => {
    const forgotten: (string | undefined)[] = []
    const accounts = provider(forgotten)
    await accounts.dispose()
    expect(forgotten).toEqual([])
  })
})
