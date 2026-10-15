/**
 * StarCraft text: map strings (CHK `STR`/`STRx`), string tables (`.tbl`) and replays share one rule.
 */

const utf8 = new TextDecoder('utf-8', { fatal: true })

/**
 * How a string's bytes become text. Remastered writes UTF-8 and reads a string as UTF-8 when it is
 * valid UTF-8; any other string is in the code page it was authored in, which the file does not
 * record: the user names it (`textEncoding` setting, a WHATWG label such as `windows-1252` or
 * `euc-kr`), it is not guessed.
 */
export function sc1TextDecoder(encoding = 'windows-1252'): (bytes: Uint8Array) => string {
  const legacy = new TextDecoder(encoding)
  return bytes => {
    try {
      return utf8.decode(bytes)
    } catch {
      return legacy.decode(bytes)
    }
  }
}

/** The `textEncoding` setting of a contribution (a WHATWG label), or the default code page. */
export function textDecoderOf(settings: Readonly<Record<string, unknown>>): (bytes: Uint8Array) => string {
  const encoding = settings['textEncoding']
  return sc1TextDecoder(typeof encoding === 'string' && encoding.trim() !== '' ? encoding.trim() : undefined)
}

const TAB = 9
const LINE_FEED = 10
const CARRIAGE_RETURN = 13

/**
 * The text as the editors show it: a control character (colour, alignment — 1 to 31, other than
 * tab and line breaks) as `<N>`, its decimal value.
 */
export function showControlCodes(text: string): string {
  let shown = ''
  for (const character of text) {
    const code = character.charCodeAt(0)
    shown += code > 0 && code < 32 && code !== TAB && code !== LINE_FEED && code !== CARRIAGE_RETURN ? `<${String(code)}>` : character
  }
  return shown
}
