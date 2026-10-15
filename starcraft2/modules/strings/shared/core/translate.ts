/**
 * Markup-safe machine translation for SC2 strings. See docs/tasks-active/entity-cards-strings/PLAN-strings-cards-views.md (A7).
 *
 * SC2 string values embed structured markup (`<d ref>`, `<img>`, `<c>`, `$Token$`)
 * that must NOT be translated or reordered. `protectMarkup` masks every non-text
 * segment with a sentinel, only the literal text is sent to the translator, and
 * `restoreMarkup` puts the markup back. A round-trip self-test guarantees we never
 * apply a translation that lost or mangled a placeholder.
 *
 * Browser-safe: uses `fetch` (injectable for tests).
 */

import { parseMarkup } from './markup.js'

// Private-use sentinel boundaries (translators pass these through unchanged). Built
// at runtime so no invisible characters live in the source. Sentinel = OPEN<n>CLOSE.
const OPEN = String.fromCharCode(0xe000)
const CLOSE = String.fromCharCode(0xe001)
// Tolerate translators that insert spaces around the sentinel boundary.
const TOKEN_RE = new RegExp(`${OPEN}\\s*(\\d+)\\s*${CLOSE}`, 'g')

export interface ProtectedText {
  /** Translatable text with each markup segment replaced by a sentinel. */
  masked: string
  /** Original verbatim markup, indexed by sentinel number. */
  tokens: string[]
}

/** Replace every non-text markup segment with a sentinel, keeping literal text. */
export function protectMarkup(value: string): ProtectedText {
  const tokens: string[] = []
  let masked = ''
  for (const seg of parseMarkup(value)) {
    if (seg.kind === 'text') masked += seg.text
    else { masked += `${OPEN}${tokens.length}${CLOSE}`; tokens.push(seg.raw) }
  }
  return { masked, tokens }
}

/** Put masked markup tokens back into a (translated) string. */
export function restoreMarkup(masked: string, tokens: string[]): string {
  return masked.replace(TOKEN_RE, (_, i: string) => tokens[Number(i)] ?? '')
}

export interface TranslateOptions {
  /** Source language code, ISO 639-1 (e.g. `en`). */
  sourceLang: string
  /** Target language code (e.g. `ru`, `zh-CN`). */
  targetLang: string
  /** Translation backend. Defaults to Google. */
  provider?: TranslateProvider
  /** Optional Google Cloud Translation API key (uses the official v2 endpoint). */
  apiKey?: string
  /** Model name for AI providers. */
  model?: string
  /** Optional provider endpoint override, or OpenAI-compatible endpoint. */
  endpoint?: string
  /** Optional prompt template for AI providers. */
  prompt?: string
  /** Optional mod/project context for AI providers. */
  context?: string
  /** Optional string key, useful in AI prompts. */
  key?: string
  /** Optional strings file name, useful in AI prompts. */
  file?: string
  /** Injectable fetch (defaults to global `fetch`). */
  fetchImpl?: typeof fetch
}

export type TranslateProvider = 'google' | 'openai' | 'codex' | 'openai-compatible' | 'anthropic' | 'gemini'

const AI_PLACEHOLDER_RE = /\[\[\s*MK\s*(\d+)\s*\]\]/gi

const DEFAULT_AI_PROMPT = [
  'Translate the StarCraft II mod string from {sourceLang} to {targetLang}.',
  'Use the mod context when it helps terminology, faction names, unit names, ability names, and tone.',
  'Preserve placeholders like [[MK0]] exactly and in the correct position.',
  'Output only the translated string value.',
  '',
  'File: {file}',
  'Key: {key}',
  'Context:',
  '{context}',
  '',
  'Text:',
  '{text}',
].join('\n')

function hasLetters(s: string): boolean {
  return /\p{L}/u.test(s.replace(TOKEN_RE, ''))
}

async function callGoogle(text: string, opts: TranslateOptions): Promise<string> {
  const doFetch = opts.fetchImpl ?? fetch
  if (opts.apiKey) {
    const res = await doFetch(`https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(opts.apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, source: opts.sourceLang, target: opts.targetLang, format: 'text' }),
    })
    if (!res.ok) throw new Error(`translate ${res.status}`)
    const json = await res.json() as { data?: { translations?: Array<{ translatedText?: string }> } }
    return json.data?.translations?.[0]?.translatedText ?? text
  }
  // Unofficial endpoint — no key required, best-effort, rate-limited.
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(opts.sourceLang)}&tl=${encodeURIComponent(opts.targetLang)}&dt=t&q=${encodeURIComponent(text)}`
  const res = await doFetch(url)
  if (!res.ok) throw new Error(`translate ${res.status}`)
  const json = await res.json() as unknown
  if (!Array.isArray(json) || !Array.isArray(json[0])) return text
  return (json[0] as Array<Array<unknown>>).map((seg) => (typeof seg[0] === 'string' ? seg[0] : '')).join('')
}

function providerKind(opts: TranslateOptions): TranslateProvider {
  return opts.provider ?? 'google'
}

function isAiProvider(provider: TranslateProvider): boolean {
  return provider === 'openai' || provider === 'codex' || provider === 'openai-compatible' || provider === 'anthropic' || provider === 'gemini'
}

function toAiPlaceholders(masked: string): string {
  return masked.replace(TOKEN_RE, (_, i: string) => `[[MK${Number(i)}]]`)
}

function fromAiPlaceholders(text: string): string {
  return text.replace(AI_PLACEHOLDER_RE, (_, i: string) => `${OPEN}${Number(i)}${CLOSE}`)
}

function stripResponseWrapper(text: string): string {
  const trimmed = text.trim()
  const fenced = /^```(?:\w+)?\s*([\s\S]*?)\s*```$/.exec(trimmed)
  const body = fenced?.[1]?.trim() ?? trimmed
  const quoted = /^"([\s\S]*)"$/.exec(body)
  return quoted ? quoted[1]!.replace(/\\"/g, '"') : body
}

function fillPrompt(template: string, text: string, opts: TranslateOptions): string {
  const values: Record<string, string> = {
    sourceLang: opts.sourceLang,
    targetLang: opts.targetLang,
    key: opts.key ?? '',
    file: opts.file ?? '',
    context: opts.context ?? '',
    text,
  }
  return template.replace(/\{(sourceLang|targetLang|key|file|context|text)\}/g, (_, name: string) => values[name] ?? '')
}

async function readTextResponse(res: Response): Promise<string> {
  try { return await res.text() } catch { return '' }
}

async function callOpenAiChat(text: string, opts: TranslateOptions, compatible: boolean): Promise<string> {
  if (!opts.apiKey) throw new Error(`${compatible ? 'OpenAI-compatible' : 'OpenAI'} API key is not configured`)
  if (!opts.model) throw new Error(`${compatible ? 'OpenAI-compatible' : 'OpenAI'} model is not configured`)
  const endpoint = opts.endpoint || (compatible ? '' : 'https://api.openai.com/v1/chat/completions')
  if (!endpoint) throw new Error('OpenAI-compatible endpoint is not configured')
  const doFetch = opts.fetchImpl ?? fetch
  const prompt = fillPrompt(opts.prompt?.trim() || DEFAULT_AI_PROMPT, text, opts)
  const res = await doFetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify({
      model: opts.model,
      temperature: 0.1,
      messages: [
        { role: 'system', content: 'You are a professional game localization translator.' },
        { role: 'user', content: prompt },
      ],
    }),
  })
  if (!res.ok) throw new Error(`translate ${res.status}: ${(await readTextResponse(res)).slice(0, 300)}`)
  const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
  return json.choices?.[0]?.message?.content ?? text
}

async function callAnthropic(text: string, opts: TranslateOptions): Promise<string> {
  if (!opts.apiKey) throw new Error('Anthropic API key is not configured')
  if (!opts.model) throw new Error('Anthropic model is not configured')
  const doFetch = opts.fetchImpl ?? fetch
  const prompt = fillPrompt(opts.prompt?.trim() || DEFAULT_AI_PROMPT, text, opts)
  const res = await doFetch(opts.endpoint || 'https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': opts.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: 1024,
      temperature: 0.1,
      system: 'You are a professional game localization translator.',
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) throw new Error(`translate ${res.status}: ${(await readTextResponse(res)).slice(0, 300)}`)
  const json = await res.json() as { content?: Array<{ type?: string; text?: string }> }
  return json.content?.map((part) => part.text ?? '').join('') || text
}

async function callGemini(text: string, opts: TranslateOptions): Promise<string> {
  if (!opts.apiKey) throw new Error('Gemini API key is not configured')
  if (!opts.model) throw new Error('Gemini model is not configured')
  const doFetch = opts.fetchImpl ?? fetch
  const prompt = fillPrompt(opts.prompt?.trim() || DEFAULT_AI_PROMPT, text, opts)
  const endpoint = opts.endpoint || `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(opts.model)}:generateContent?key=${encodeURIComponent(opts.apiKey)}`
  const res = await doFetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      generationConfig: { temperature: 0.1 },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    }),
  })
  if (!res.ok) throw new Error(`translate ${res.status}: ${(await readTextResponse(res)).slice(0, 300)}`)
  const json = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
  return json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') || text
}

async function callProvider(text: string, opts: TranslateOptions): Promise<string> {
  const provider = providerKind(opts)
  if (provider === 'google') return callGoogle(text, opts)
  if (provider === 'openai' || provider === 'codex') return callOpenAiChat(text, opts, false)
  if (provider === 'openai-compatible') return callOpenAiChat(text, opts, true)
  if (provider === 'anthropic') return callAnthropic(text, opts)
  if (provider === 'gemini') return callGemini(text, opts)
  return text
}

/**
 * Translate one SC2 string value, preserving its markup. Returns the original value
 * unchanged when there is nothing to translate or when the round-trip self-test fails
 * (a placeholder went missing), so a broken translation is never applied.
 */
export async function translateText(value: string, opts: TranslateOptions): Promise<string> {
  const { masked, tokens } = protectMarkup(value)
  if (!hasLetters(masked)) return value
  const provider = providerKind(opts)
  const providerInput = isAiProvider(provider) ? toAiPlaceholders(masked) : masked
  const providerOutput = await callProvider(providerInput, opts)
  const translated = isAiProvider(provider) ? fromAiPlaceholders(stripResponseWrapper(providerOutput)) : providerOutput
  for (let i = 0; i < tokens.length; i++) {
    if (!new RegExp(`${OPEN}\\s*${i}\\s*${CLOSE}`).test(translated)) return value
  }
  return restoreMarkup(translated, tokens).trim()
}
