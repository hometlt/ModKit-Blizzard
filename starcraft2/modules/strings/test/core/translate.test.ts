import { describe, it, expect } from 'vitest'
import { protectMarkup, restoreMarkup, translateText } from '../../shared/core/translate.js'

const OPEN = String.fromCharCode(0xe000)
const CLOSE = String.fromCharCode(0xe001)

/** Fake fetch for the unofficial gtx endpoint that applies `transform` to the query text. */
function fakeFetch(transform: (q: string) => string): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    const q = decodeURIComponent(new URL(url).searchParams.get('q') ?? '')
    const out = transform(q)
    return { ok: true, json: async () => [[[out, q]]] } as unknown as Response
  }) as unknown as typeof fetch
}

describe('protect/restore markup', () => {
  it('masks non-text segments and restores them', () => {
    const v = 'Deals <d ref="Effect,X,Amount"/> damage to <c val="ff0000">enemies</c>.'
    const { masked, tokens } = protectMarkup(v)
    expect(tokens).toHaveLength(2) // the <d ref/> and the whole <c>…</c>
    expect(masked).toContain('Deals ')
    expect(masked).toContain(' damage to ')
    expect(restoreMarkup(masked, tokens)).toBe(v)
  })
})

describe('translateText — markup-safe', () => {
  it('translates only literal text, preserving markup tokens', async () => {
    const v = 'Deals <d ref="Effect,X,Amount"/> damage'
    const out = await translateText(v, { sourceLang: 'en', targetLang: 'xx', fetchImpl: fakeFetch((q) => q.toUpperCase()) })
    expect(out).toBe('DEALS <d ref="Effect,X,Amount"/> DAMAGE')
  })

  it('returns the original value when a placeholder is dropped (self-test)', async () => {
    const v = 'Deals <d ref="Effect,X,Amount"/> damage'
    // transform strips the sentinel chars → self-test must fail → original returned
    const out = await translateText(v, { sourceLang: 'en', targetLang: 'xx', fetchImpl: fakeFetch((q) => q.replace(new RegExp(`[${OPEN}${CLOSE}]`, 'g'), '')) })
    expect(out).toBe(v)
  })

  it('skips strings with no translatable letters (no fetch call)', async () => {
    let called = false
    const out = await translateText('<n/><d ref="A,B,C"/>', {
      sourceLang: 'en', targetLang: 'xx',
      fetchImpl: (async () => { called = true; return { ok: true, json: async () => [[['x', 'x']]] } as unknown as Response }) as unknown as typeof fetch,
    })
    expect(called).toBe(false)
    expect(out).toBe('<n/><d ref="A,B,C"/>')
  })

  it('uses readable placeholders for AI providers and restores markup', async () => {
    let prompt = ''
    const out = await translateText('Deals <d ref="Effect,X,Amount"/> damage', {
      provider: 'openai-compatible',
      sourceLang: 'en',
      targetLang: 'xx',
      apiKey: 'test',
      model: 'test-model',
      endpoint: 'https://example.test/chat',
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ content?: string }> }
        prompt = body.messages?.at(-1)?.content ?? ''
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'HACE [[MK0]] DANO' } }] }) } as unknown as Response
      }) as unknown as typeof fetch,
    })
    expect(prompt).toContain('[[MK0]]')
    expect(out).toBe('HACE <d ref="Effect,X,Amount"/> DANO')
  })

  it('returns the original value when an AI provider drops a placeholder', async () => {
    const v = 'Deals <d ref="Effect,X,Amount"/> damage'
    const out = await translateText(v, {
      provider: 'openai-compatible',
      sourceLang: 'en',
      targetLang: 'xx',
      apiKey: 'test',
      model: 'test-model',
      endpoint: 'https://example.test/chat',
      fetchImpl: (async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'HACE DANO' } }] }) }) as unknown as Response) as unknown as typeof fetch,
    })
    expect(out).toBe(v)
  })
})
