import type { StringFileModel } from './text-file.js'
import type { StringDiagnostic } from './analysis.js'

export interface HotkeyIssue {
  start: number
  end: number
  message: string
}

const MODIFIERS = new Set(['shift', 'alt', 'control', 'ctrl', 'command', 'cmd'])

const DEFAULT_BASE_KEYS = new Set<string>([
  'none',
  ...'abcdefghijklmnopqrstuvwxyz'.split(''),
  ...'0123456789'.split(''),
  ...Array.from({ length: 24 }, (_, i) => `f${i + 1}`),
  ...Array.from({ length: 10 }, (_, i) => `numpad${i}`),
  'escape', 'esc', 'space', 'tab', 'enter', 'return', 'backspace', 'delete', 'del', 'insert', 'ins',
  'home', 'end', 'pageup', 'pagedown', 'up', 'down', 'left', 'right',
  'equals', 'minus', 'plus', 'slash', 'backslash', 'semicolon', 'apostrophe', 'comma', 'period', 'grave',
  'leftbracket', 'rightbracket', 'bracketleft', 'bracketright',
  'printscreen', 'scrolllock', 'pause', 'capslock',
  'leftmousebutton', 'rightmousebutton', 'middlemousebutton', 'mousebutton4', 'mousebutton5',
  'mousewheelup', 'mousewheeldown',
  'numpadplus', 'numpadminus', 'numpadmultiply', 'numpaddivide', 'numpaddecimal', 'numpadenter', 'numpadequals',
])

export const DEFAULT_HOTKEY_VALUES: string[] = [...DEFAULT_BASE_KEYS]
  .filter(k => k !== 'none')
  .map(displayHotkeyKey)
  .sort((a, b) => a.localeCompare(b))

function displayHotkeyKey(key: string): string {
  if (/^[a-z]$/.test(key)) return key.toUpperCase()
  if (/^f\d+$/.test(key)) return key.toUpperCase()
  if (/^numpad\d$/.test(key)) return `NumPad${key.slice('numpad'.length)}`
  const known: Record<string, string> = {
    esc: 'Escape',
    del: 'Delete',
    ins: 'Insert',
    pageup: 'PageUp',
    pagedown: 'PageDown',
    leftmousebutton: 'LeftMouseButton',
    rightmousebutton: 'RightMouseButton',
    middlemousebutton: 'MiddleMouseButton',
    mousebutton4: 'MouseButton4',
    mousebutton5: 'MouseButton5',
    mousewheelup: 'MouseWheelUp',
    mousewheeldown: 'MouseWheelDown',
    numpadplus: 'NumPadPlus',
    numpadminus: 'NumPadMinus',
    numpadmultiply: 'NumPadMultiply',
    numpaddivide: 'NumPadDivide',
    numpaddecimal: 'NumPadDecimal',
    numpadenter: 'NumPadEnter',
    numpadequals: 'NumPadEquals',
    leftbracket: 'LeftBracket',
    rightbracket: 'RightBracket',
    bracketleft: 'BracketLeft',
    bracketright: 'BracketRight',
    printscreen: 'PrintScreen',
    scrolllock: 'ScrollLock',
    capslock: 'CapsLock',
  }
  return known[key] ?? key.charAt(0).toUpperCase() + key.slice(1)
}

function normalizedSet(extra?: Iterable<string>): Set<string> {
  const out = new Set(DEFAULT_BASE_KEYS)
  for (const value of extra ?? []) {
    const clean = value.trim().toLowerCase()
    if (clean) out.add(clean)
  }
  return out
}

function valueWithoutTranslatorComment(value: string): string {
  return value.replace(/[ \t]+\/\/\/[ \t]*Translator:[^\r\n]*$/i, '')
}

function unknownIssue(part: string, start: number, end: number): HotkeyIssue {
  return { start, end, message: `Unknown hotkey value "${part}"` }
}

export function validateHotkeyValue(value: string, allowed?: Iterable<string>): HotkeyIssue[] {
  const clean = valueWithoutTranslatorComment(value)
  const keys = normalizedSet(allowed)
  const issues: HotkeyIssue[] = []
  if (!clean.trim()) return issues

  const entries = clean.split(',')
  let offset = 0
  const trimmedEntries = entries.map(entry => entry.trim()).filter(Boolean)
  const hasOnlyNone = trimmedEntries.length === 1 && trimmedEntries[0]!.toLowerCase() === 'none'

  for (const entry of entries) {
    const entryStart = offset
    const raw = entry
    const leading = raw.match(/^\s*/)?.[0].length ?? 0
    const trimmed = raw.trim()
    const start = entryStart + leading
    offset += raw.length + 1

    if (!trimmed) {
      issues.push({ start: entryStart, end: Math.max(entryStart + raw.length, entryStart + 1), message: 'Empty hotkey entry' })
      continue
    }
    if (trimmed.toLowerCase() === 'none') {
      if (!hasOnlyNone) issues.push({ start, end: start + trimmed.length, message: 'None must be the only hotkey value' })
      continue
    }

    const parts = trimmed.split('+')
    let partOffset = start
    let sawBase = false
    for (let i = 0; i < parts.length; i++) {
      const partRaw = parts[i]!
      const partLeading = partRaw.match(/^\s*/)?.[0].length ?? 0
      const part = partRaw.trim()
      const partStart = partOffset + partLeading
      const partEnd = partStart + part.length
      partOffset += partRaw.length + 1
      if (!part) {
        issues.push({ start: partStart, end: Math.max(partEnd, partStart + 1), message: 'Empty hotkey chord segment' })
        continue
      }
      const lower = part.toLowerCase()
      const isLast = i === parts.length - 1
      if (!isLast && MODIFIERS.has(lower)) continue
      if (MODIFIERS.has(lower) && isLast) {
        issues.push({ start: partStart, end: partEnd, message: `Hotkey chord "${trimmed}" is missing a key after ${part}` })
        continue
      }
      if (!keys.has(lower)) issues.push(unknownIssue(part, partStart, partEnd))
      sawBase = true
    }
    if (!sawBase) issues.push({ start, end: start + trimmed.length, message: `Hotkey chord "${trimmed}" is missing a key` })
  }
  return issues
}

export function analyzeHotkeyStringFile(model: StringFileModel, allowed?: Iterable<string>): StringDiagnostic[] {
  const out: StringDiagnostic[] = []
  for (const [key, lines] of model.index) {
    if (lines.length < 2) continue
    for (let i = 1; i < lines.length; i++) {
      out.push({
        key,
        line: model.lines.indexOf(lines[i]!),
        severity: 'warning',
        code: 'duplicate-key',
        message: `Duplicate key "${key}" (${lines.length} occurrences); this line overrides the earlier value`,
      })
    }
  }
  for (let i = 0; i < model.lines.length; i++) {
    const line = model.lines[i]!
    if (!line.isEntry) continue
    for (const issue of validateHotkeyValue(line.value, allowed)) {
      out.push({
        key: line.key,
        line: i,
        severity: 'error',
        code: 'invalid-hotkey',
        message: issue.message,
        start: issue.start,
        end: issue.end,
      })
    }
  }
  return out
}

export function collectHotkeyKeyNames(value: string): string[] {
  const out = new Set<string>()
  for (const entry of valueWithoutTranslatorComment(value).split(',')) {
    for (const part of entry.split('+')) {
      const clean = part.trim()
      if (!clean || MODIFIERS.has(clean.toLowerCase()) || clean.toLowerCase() === 'none') continue
      out.add(clean)
    }
  }
  return [...out]
}
