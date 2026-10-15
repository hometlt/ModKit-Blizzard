import { bindSourceFile } from '../../language-core/binder.js';
import { Parser } from '../../language-core/parser.js';
import { Printer } from '../../language-core/printer.js';
import { SyntaxKind } from '../../language-core/types.js';
import { checkSourceFile } from './galaxy-checker.js';
import type { GalaxySymbolKind, GalaxySymbolTreeNode } from './types.js';
export type { GalaxySymbolKind, GalaxySymbolTreeNode } from './types.js';
import type {
  Diagnostic,
  FunctionDeclaration,
  Node,
  ParameterDeclaration,
  PropertyDeclaration,
  SourceFile,
  StructDeclaration,
  TypedefDeclaration,
  VariableDeclaration,
} from '../../language-core/types.js';

// Contract-shaped Trigger metadata keeps the Galaxy semantic core independent from
// the sc2-triggers codec implementation. The Trigger provider may supply this data.
interface TriggerElementRef { id: string }
interface FunctionDefJson {
  id: string;
  name?: string;
  scriptCode?: string;
  parameters?: readonly TriggerElementRef[];
  returnType?: { type?: string };
}
interface ParamDefJson { id: string; name?: string; paramType?: { type?: string } }
interface TriggerLibraryJson {
  elementsByType: {
    FunctionDef?: Readonly<Record<string, FunctionDefJson>>;
    ParamDef?: Readonly<Record<string, ParamDefJson>>;
  };
}

export interface GalaxyRange {
  start: number;
  end: number;
}

export interface GalaxyLanguageDiagnostic extends GalaxyRange {
  message: string;
  severity: 'error' | 'warning' | 'info' | 'hint';
}

export interface GalaxyLanguageSymbol extends GalaxyRange {
  name: string;
  kind: GalaxySymbolKind;
  detail?: string;
  selection: GalaxyRange;
  parameters?: GalaxyParameterInfo[];
  children?: GalaxyLanguageSymbol[];
  /** A global variable's declaration as written, without `;` (e.g. `const int c_limit = 3`). */
  declaration?: string;
  /** The struct a property belongs to. */
  container?: string;
}

export interface GalaxyParameterInfo {
  name: string;
  type: string;
}

/**
 * Flatten {@link GalaxyLanguageSymbol}s (as produced by {@link analyzeGalaxyLanguage}) into the
 * JSON-safe {@link GalaxySymbolTreeNode} tree the MOD-tree / `modResource` views render. Kept here so
 * the mapping lives in one place, shared by the extension host and the LSP server (G8) instead of
 * being duplicated on each side of the wire.
 */
export function toGalaxySymbolTree(
  symbols: readonly GalaxyLanguageSymbol[],
): GalaxySymbolTreeNode[] {
  return symbols.map(toGalaxySymbolTreeNode);
}

/** Retain display declarations and navigation while excluding the parser's mutable AST. */
function toGalaxySymbolTreeNode(s: GalaxyLanguageSymbol): GalaxySymbolTreeNode {
  return {
    name: s.name,
    kind: s.kind,
    ...(s.detail ? { detail: s.detail } : {}),
    ...(s.declaration === undefined ? {} : { declaration: s.declaration }),
    ...(s.selection ? { selectionStart: s.selection.start } : {}),
    ...(s.children?.length ? { children: s.children.map(toGalaxySymbolTreeNode) } : {}),
  };
}

export interface GalaxyCompletionItem {
  label: string;
  kind: GalaxySymbolKind | 'keyword' | 'type' | 'constant' | 'snippet';
  detail?: string;
  insertText?: string;
  sortText?: string;
}

export interface GalaxySignatureInfo {
  name: string;
  label: string;
  activeParameter: number;
  parameters: GalaxyParameterInfo[];
}

export interface GalaxyHoverInfo {
  range: GalaxyRange;
  markdown: string;
}

export interface GalaxyCompletionContext {
  activeFunction: string;
  activeParameter: number;
  expectedType?: string;
}

export interface GalaxyReferenceInfo extends GalaxyRange {
  name: string;
}

export interface GalaxyLanguageIndex {
  fileName: string;
  sourceFile: SourceFile;
  diagnostics: GalaxyLanguageDiagnostic[];
  symbols: GalaxyLanguageSymbol[];
  completions: GalaxyCompletionItem[];
}

export interface GalaxyLanguageOptions {
  extraCompletions?: readonly GalaxyCompletionItem[];
  triggerLibrary?: TriggerLibraryJson;
  resolveGlobalDeclaration?: (name: string) => FunctionDeclaration | VariableDeclaration | StructDeclaration | TypedefDeclaration | undefined;
}

export interface GalaxyFormatOptions {
  insertSpaces?: boolean;
  tabSize?: number;
  finalNewline?: boolean;
}

const KEYWORDS = [
  'include', 'struct', 'typedef', 'native', 'static', 'const',
  'if', 'else', 'for', 'while', 'do', 'return', 'break', 'continue', 'breakpoint',
  'true', 'false', 'null',
];

const TYPES = [
  'void', 'bool', 'byte', 'char', 'int', 'fixed', 'string', 'text',
  'abilcmd', 'actor', 'actorscope', 'aifilter', 'bank', 'bitmask',
  'camerainfo', 'color', 'datetime', 'doodad', 'effecthistory',
  'handle', 'generichandle', 'marker', 'order', 'playergroup', 'point',
  'region', 'revealer', 'sound', 'soundlink', 'timer',
  'transmissionsource', 'trigger', 'unit', 'unitfilter', 'unitgroup',
  'unitref', 'wave', 'waveinfo', 'wavetarget',
  'arrayref', 'structref', 'funcref',
];

const SNIPPETS: GalaxyCompletionItem[] = [
  { label: 'include', kind: 'snippet', detail: 'include file', insertText: 'include "$1"' },
  { label: 'for', kind: 'snippet', detail: 'for iterator', insertText: 'for (${1:i} = ${2:0}; ${1:i} < ${3:1}; ${1:i} += 1) {\n\t$0\n}' },
  { label: 'forp', kind: 'snippet', detail: 'for players', insertText: 'for (${1:i} = 1; ${1:i} <= PlayerGroupCount(${2:PlayerGroupActive()}); ${1:i} += 1) {\n\t${3:tmp_player} = PlayerGroupPlayer(${2:PlayerGroupActive()}, ${1:i});\n}' },
  { label: 'foru', kind: 'snippet', detail: 'for units', insertText: 'for (${1:i} = 1; ${1:i} <= UnitGroupCount(${2:group}, c_unitCountAll); ${1:i} += 1) {\n\t${3:tmp_unit} = UnitGroupUnit(${2:group}, ${1:i});\n}' },
  { label: 'tgc', kind: 'snippet', detail: 'trigger complete declaration', insertText: 'bool ${1:name}(bool test_conds, bool run_actions)\n{\n\tif (test_conds) {\n\t}\n\n\tif (!run_actions) {\n\t\treturn true;\n\t}\n\n\t${0}return true;\n}' },
  { label: 'tgs', kind: 'snippet', detail: 'trigger simple declaration', insertText: 'bool ${1:name}(bool test_conds, bool run_actions)\n{\n\t${0}return true;\n}' },
  { label: 'its', kind: 'snippet', insertText: 'IntToString($1)' },
  { label: 'itf', kind: 'snippet', insertText: 'IntToFixed($1)' },
  { label: 'fts', kind: 'snippet', insertText: 'FixedToString($1, ${2:-1})' },
  { label: 'fti', kind: 'snippet', insertText: 'FixedToInt($1)' },
  { label: 'stt', kind: 'snippet', insertText: 'StringToText($1)' },
];

const printer = new Printer();

/*
 * Analyses kept across requests, by file and text. An editor request hands over the whole snapshot
 * again — the Void chain is 247 files, 7 MB, ~1 s to parse — and the hover, completion and
 * signature helpers re-analyse the open document on every call (plan 2.14). Only option-free
 * analyses are kept: options change the completions and diagnostics. The result is shared, so
 * callers must not mutate it. ponytail: bounded by text size, ~32 bytes of heap per character.
 */
const MAX_KEPT_CHARS = 12 * 1024 * 1024;
const kept = new Map<string, { code: string; index: GalaxyLanguageIndex }>();
let keptChars = 0;

export function analyzeGalaxyLanguage(code: string, fileName = 'Lib.galaxy', options: GalaxyLanguageOptions = {}): GalaxyLanguageIndex {
  if (Object.values(options).some((value) => value !== undefined)) return analyzeUncached(code, fileName, options);
  const entry = kept.get(fileName);
  if (entry !== undefined) {
    kept.delete(fileName);
    if (entry.code === code) {
      kept.set(fileName, entry);
      return entry.index;
    }
    keptChars -= entry.code.length;
  }
  const index = analyzeUncached(code, fileName, options);
  if (code.length > MAX_KEPT_CHARS) return index;
  kept.set(fileName, { code, index });
  keptChars += code.length;
  for (const [name, old] of kept) {
    if (keptChars <= MAX_KEPT_CHARS) break;
    kept.delete(name);
    keptChars -= old.code.length;
  }
  return index;
}

function analyzeUncached(code: string, fileName: string, options: GalaxyLanguageOptions): GalaxyLanguageIndex {
  const sourceFile = new Parser().parseFile(fileName, code);
  bindSafe(sourceFile);
  const symbols = collectSymbols(sourceFile);
  const triggerCompletions = options.triggerLibrary ? triggerLibraryCompletions(options.triggerLibrary) : [];
  return {
    fileName,
    sourceFile,
    diagnostics: diagnosticsFor(sourceFile, options),
    symbols,
    completions: buildCompletions(symbols, [...(options.extraCompletions ?? []), ...triggerCompletions]),
  };
}

export function formatGalaxySource(code: string, options: GalaxyFormatOptions = {}): string {
  const insertSpaces = options.insertSpaces ?? false;
  const tabSize = Math.max(1, Math.min(8, options.tabSize ?? 2));
  const indentUnit = insertSpaces ? ' '.repeat(tabSize) : '\t';
  const normalized = code.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const hadFinalNewline = normalized.endsWith('\n');
  const out: string[] = [];
  let indent = 0;

  for (const rawLine of lines) {
    if (rawLine === '' && out.length === lines.length - 1 && hadFinalNewline) continue;

    const trimmed = rawLine.trim();
    if (!trimmed) {
      out.push('');
      continue;
    }

    const lineIndent = Math.max(0, indent - leadingCloseBraceDedent(trimmed));
    out.push(`${indentUnit.repeat(lineIndent)}${trimmed}`);
    indent = Math.max(0, indent + braceDelta(trimmed));
  }

  const finalNewline = options.finalNewline ?? hadFinalNewline;
  return `${out.join('\n')}${finalNewline ? '\n' : ''}`;
}

export function galaxyWordAt(code: string, offset: number): GalaxyReferenceInfo | undefined {
  // Read backwards: a `…$` pattern over everything before the offset costs the whole file per call.
  let start = offset;
  while (start > 0 && /[A-Za-z0-9_]/.test(code[start - 1]!)) start--;
  while (start < offset && /[0-9]/.test(code[start]!)) start++;
  const left = code.slice(start, offset);
  const right = code.slice(offset).match(/^[A-Za-z0-9_]*/)?.[0] ?? '';
  const name = left + right;
  if (!name) return undefined;
  return { name, start: offset - left.length, end: offset + right.length };
}

export function galaxyDefinitionAt(code: string, offset: number, fileName = 'Lib.galaxy'): GalaxyLanguageSymbol | undefined {
  const word = galaxyWordAt(code, offset);
  if (!word) return undefined;
  return flattenSymbols(analyzeGalaxyLanguage(code, fileName).symbols).find((s) => s.name === word.name);
}

export function galaxyCompletionContextAt(code: string, offset: number, fileName = 'Lib.galaxy', options: GalaxyLanguageOptions = {}): GalaxyCompletionContext | undefined {
  const call = callContext(code, offset);
  if (!call) return undefined;
  const sig = galaxySignatureAt(code, offset, fileName, options);
  return {
    activeFunction: call.name,
    activeParameter: call.argIndex,
    ...(sig?.parameters[call.argIndex]?.type ? { expectedType: sig.parameters[call.argIndex]!.type } : {}),
  };
}

export function galaxyCompletionsAt(code: string, offset: number, fileName = 'Lib.galaxy', options: GalaxyLanguageOptions = {}): GalaxyCompletionItem[] {
  const index = analyzeGalaxyLanguage(code, fileName, options);
  const context = galaxyCompletionContextAt(code, offset, fileName, options);
  if (!context?.expectedType) return index.completions;

  return rankGalaxyCompletions(index.completions.map((item) => {
    if (!completionMatchesExpectedType(item, context.expectedType!)) return item;
    return {
      ...item,
      sortText: `05:${item.label.toLowerCase()}`,
    };
  }));
}

export function galaxyReferencesAt(code: string, offset: number): GalaxyReferenceInfo[] {
  const word = galaxyWordAt(code, offset);
  if (!word) return [];
  const re = new RegExp(`\\b${escapeRegExp(word.name)}\\b`, 'g');
  return [...code.matchAll(re)].map((m) => ({ name: word.name, start: m.index ?? 0, end: (m.index ?? 0) + word.name.length }));
}

export function galaxyRenameRangeAt(code: string, offset: number): GalaxyRange | undefined {
  const word = galaxyWordAt(code, offset);
  return word ? { start: word.start, end: word.end } : undefined;
}

export function galaxyHoverAt(code: string, offset: number, fileName = 'Lib.galaxy', options: GalaxyLanguageOptions = {}): GalaxyHoverInfo | undefined {
  const word = galaxyWordAt(code, offset);
  if (!word) return undefined;
  const symbol = galaxyDefinitionAt(code, offset, fileName);
  if (symbol) {
    return {
      range: { start: word.start, end: word.end },
      markdown: symbolMarkdown(symbol),
    };
  }
  const triggerFunction = options.triggerLibrary ? triggerFunctionByName(options.triggerLibrary, word.name) : undefined;
  if (triggerFunction && options.triggerLibrary) {
    return {
      range: word,
      markdown: `\`\`\`galaxy\n${triggerSignatureLabel(options.triggerLibrary, triggerFunction)}\n\`\`\``,
    };
  }
  if (TYPES.includes(word.name)) {
    return { range: word, markdown: `\`${word.name}\` Galaxy type` };
  }
  if (KEYWORDS.includes(word.name)) {
    return { range: word, markdown: `\`${word.name}\` Galaxy keyword` };
  }
  return undefined;
}

export function galaxySignatureAt(code: string, offset: number, fileName = 'Lib.galaxy', options: GalaxyLanguageOptions = {}): GalaxySignatureInfo | undefined {
  const call = callContext(code, offset);
  if (!call) return undefined;
  const fn = flattenSymbols(analyzeGalaxyLanguage(code, fileName).symbols)
    .find((s) => s.kind === 'function' && s.name === call.name);
  if (fn?.parameters) {
    return {
      name: fn.name,
      label: signatureLabel(fn),
      activeParameter: Math.min(call.argIndex, Math.max(0, fn.parameters.length - 1)),
      parameters: fn.parameters,
    };
  }

  const triggerFunction = options.triggerLibrary ? triggerFunctionByName(options.triggerLibrary, call.name) : undefined;
  if (!triggerFunction || !options.triggerLibrary) return undefined;
  const parameters = triggerParameterInfos(options.triggerLibrary, triggerFunction);
  return {
    name: triggerFunctionName(triggerFunction),
    label: triggerSignatureLabel(options.triggerLibrary, triggerFunction),
    activeParameter: Math.min(call.argIndex, Math.max(0, parameters.length - 1)),
    parameters,
  };
}

function bindSafe(sourceFile: SourceFile): void {
  try {
    bindSourceFile(sourceFile, { resolveGlobalSymbol: () => undefined });
  } catch {
    // Binding is best-effort for language-service metadata; parse diagnostics still apply.
  }
}

function diagnosticsFor(sourceFile: SourceFile, options: GalaxyLanguageOptions): GalaxyLanguageDiagnostic[] {
  return [
    ...(sourceFile.parseDiagnostics ?? []),
    ...(sourceFile.bindDiagnostics ?? []),
    ...(sourceFile.additionalSyntacticDiagnostics ?? []),
    ...checkSourceFile(sourceFile, { resolveGlobalDeclaration: options.resolveGlobalDeclaration }),
  ].map(convertDiagnostic);
}

function convertDiagnostic(d: Diagnostic): GalaxyLanguageDiagnostic {
  const start = d.start ?? 0;
  return {
    start,
    end: start + (d.length ?? 1),
    message: String(d.messageText),
    severity: d.category === 2 ? 'warning' : d.category === 3 ? 'info' : d.category === 4 ? 'hint' : 'error',
  };
}

function collectSymbols(sourceFile: SourceFile): GalaxyLanguageSymbol[] {
  const out: GalaxyLanguageSymbol[] = [];
  for (const stmt of sourceFile.statements ?? []) {
    const sym = symbolForNode(stmt, sourceFile.text ?? '');
    if (sym) out.push(sym);
  }
  return out;
}

/**
 * A statement's source up to its terminating `;` (outside string literals). A statement's `end`
 * also covers trailing comments, so the text is cut at the terminator rather than at `end`.
 */
function declarationText(text: string, start: number, end: number): string | undefined {
  let quote: string | undefined;
  for (let i = start; i < end; i++) {
    const ch = text[i];
    if (quote !== undefined) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ';') return text.slice(start, i).replace(/\s+/g, ' ').trim() || undefined;
  }
  return undefined;
}

function symbolForNode(node: Node, text: string): GalaxyLanguageSymbol | undefined {
  switch (node.kind) {
    case SyntaxKind.FunctionDeclaration: {
      const fn = node as FunctionDeclaration;
      const name = fn.name?.name ?? '(anonymous)';
      const parameters = (fn.parameters ?? []).map(paramInfo);
      return {
        name,
        kind: 'function',
        detail: `${typeText(fn.type)} ${name}(${parameters.map((p) => `${p.type} ${p.name}`).join(', ')})`,
        start: fn.pos,
        end: fn.end,
        selection: nodeRange(fn.name ?? fn),
        parameters,
      };
    }
    case SyntaxKind.VariableDeclaration: {
      const v = node as VariableDeclaration;
      const declaration = declarationText(text, v.pos, v.end);
      return {
        name: v.name?.name ?? '(anonymous)',
        kind: 'variable',
        detail: typeText(v.type),
        start: v.pos,
        end: v.end,
        selection: nodeRange(v.name ?? v),
        ...(declaration === undefined ? {} : { declaration }),
      };
    }
    case SyntaxKind.StructDeclaration: {
      const s = node as StructDeclaration;
      const name = s.name?.name ?? '(anonymous)';
      return {
        name,
        kind: 'struct',
        detail: 'struct',
        start: s.pos,
        end: s.end,
        selection: nodeRange(s.name ?? s),
        children: (s.members ?? []).map((member) => ({ ...propertySymbol(member), container: name })),
      };
    }
    case SyntaxKind.TypedefDeclaration: {
      const t = node as TypedefDeclaration;
      return {
        name: t.name?.name ?? '(anonymous)',
        kind: 'typedef',
        detail: typeText(t.type),
        start: t.pos,
        end: t.end,
        selection: nodeRange(t.name ?? t),
      };
    }
    case SyntaxKind.IncludeStatement: {
      const path = (node as any).path?.text?.replace(/"/g, '') ?? 'include';
      return {
        name: path,
        kind: 'include',
        detail: 'include',
        start: node.pos,
        end: node.end,
        selection: { start: node.pos, end: node.end },
      };
    }
    default:
      return undefined;
  }
}

function propertySymbol(p: PropertyDeclaration): GalaxyLanguageSymbol {
  return {
    name: p.name?.name ?? '(anonymous)',
    kind: 'property',
    detail: typeText(p.type),
    start: p.pos,
    end: p.end,
    selection: nodeRange(p.name ?? p),
  };
}

function paramInfo(p: ParameterDeclaration): GalaxyParameterInfo {
  return { name: p.name?.name ?? '', type: typeText(p.type) };
}

function buildCompletions(symbols: GalaxyLanguageSymbol[], extra: readonly GalaxyCompletionItem[] = []): GalaxyCompletionItem[] {
  const out: GalaxyCompletionItem[] = [
    ...KEYWORDS.map((label) => ({ label, kind: 'keyword' as const })),
    ...TYPES.map((label) => ({ label, kind: 'type' as const })),
    ...['true', 'false', 'null'].map((label) => ({ label, kind: 'constant' as const })),
    ...SNIPPETS,
    ...extra,
  ];
  for (const s of flattenSymbols(symbols)) {
    out.push({
      label: s.name,
      kind: s.kind,
      detail: s.detail,
      insertText: s.kind === 'function' ? `${s.name}($0)` : s.name,
    });
  }
  return rankGalaxyCompletions(dedupe(out));
}

export function rankGalaxyCompletions(items: readonly GalaxyCompletionItem[]): GalaxyCompletionItem[] {
  return [...items]
    .map((item) => ({
      ...item,
      sortText: item.sortText ?? galaxyCompletionSortText(item),
    }))
    .sort((a, b) => (a.sortText ?? '').localeCompare(b.sortText ?? '') || a.label.localeCompare(b.label));
}

export function galaxyCompletionSortText(item: Pick<GalaxyCompletionItem, 'kind' | 'label'>): string {
  const order = item.kind === 'function' ? '10'
    : item.kind === 'variable' || item.kind === 'parameter' || item.kind === 'constant' ? '20'
      : item.kind === 'struct' || item.kind === 'typedef' || item.kind === 'type' ? '30'
        : item.kind === 'keyword' ? '40'
          : item.kind === 'snippet' ? '80'
            : '90';
  return `${order}:${item.label.toLowerCase()}`;
}

function triggerLibraryCompletions(library: TriggerLibraryJson): GalaxyCompletionItem[] {
  const out: GalaxyCompletionItem[] = [];
  for (const el of Object.values(library.elementsByType?.FunctionDef ?? {})) {
    const fn = el as FunctionDefJson;
    const name = triggerFunctionName(fn);
    const params = triggerParameterInfos(library, fn).map(param => `${param.type} ${param.name}`);
    out.push({
      label: name,
      kind: 'function',
      detail: `${fn.returnType?.type ?? 'void'} ${name}(${params.join(', ')})`,
      insertText: `${name}($0)`,
    });
  }
  return out;
}

function triggerFunctionName(fn: FunctionDefJson): string {
  return fn.scriptCode || fn.name || fn.id;
}

function triggerFunctionByName(library: TriggerLibraryJson, name: string): FunctionDefJson | undefined {
  return Object.values(library.elementsByType?.FunctionDef ?? {})
    .find(fn => triggerFunctionName(fn) === name || fn.name === name || fn.id === name);
}

function triggerParameterInfos(library: TriggerLibraryJson, fn: FunctionDefJson): GalaxyParameterInfo[] {
  return (fn.parameters ?? [])
    .map(ref => library.elementsByType.ParamDef?.[ref.id] as ParamDefJson | undefined)
    .filter((param): param is ParamDefJson => Boolean(param))
    .map(param => ({ name: param.name ?? param.id, type: param.paramType?.type ?? 'unknown' }));
}

function triggerSignatureLabel(library: TriggerLibraryJson, fn: FunctionDefJson): string {
  const name = triggerFunctionName(fn);
  const params = triggerParameterInfos(library, fn).map(param => `${param.type} ${param.name}`).join(', ');
  return `${fn.returnType?.type ?? 'void'} ${name}(${params})`;
}

function completionMatchesExpectedType(item: GalaxyCompletionItem, expectedType: string): boolean {
  const normalized = expectedType.toLowerCase();
  if (item.kind === 'constant' && ['bool', 'boolean'].includes(normalized)) return item.label === 'true' || item.label === 'false';
  if (!item.detail) return false;
  const detail = item.detail.toLowerCase();
  return detail === normalized || detail.startsWith(`${normalized} `) || detail.includes(`: ${normalized}`);
}

function flattenSymbols(symbols: GalaxyLanguageSymbol[]): GalaxyLanguageSymbol[] {
  const out: GalaxyLanguageSymbol[] = [];
  const visit = (s: GalaxyLanguageSymbol) => {
    out.push(s);
    for (const c of s.children ?? []) visit(c);
  };
  for (const s of symbols) visit(s);
  return out;
}

function typeText(node: Node | undefined): string {
  return node ? printer.printNode(node).trim() : 'unknown';
}

function nodeRange(node: Node): GalaxyRange {
  return { start: node.pos, end: node.end };
}

/**
 * Hover text for a declared symbol, as MK2 showed it: a variable's declaration as written (so a
 * constant shows `const` and its value) and, for a struct member, the struct it belongs to.
 */
export function galaxySymbolHoverMarkdown(symbol: GalaxyLanguageSymbol): string {
  if (symbol.kind === 'function') return `\`\`\`galaxy\n${signatureLabel(symbol)}\n\`\`\``;
  const code = symbol.declaration ?? `${symbol.detail ? `${symbol.detail} ` : ''}${symbol.name}`;
  const owner = symbol.container === undefined ? '' : `\n\nproperty of \`${symbol.container}\``;
  return `\`\`\`galaxy\n${code}\n\`\`\`${owner}`;
}

const symbolMarkdown = galaxySymbolHoverMarkdown;

function signatureLabel(symbol: GalaxyLanguageSymbol): string {
  const params = symbol.parameters?.map((p) => `${p.type} ${p.name}`).join(', ') ?? '';
  const prefix = symbol.detail?.split(symbol.name)[0]?.trim() || 'void';
  return `${prefix} ${symbol.name}(${params})`;
}

function callContext(code: string, offset: number): { name: string; argIndex: number } | undefined {
  let depth = 0;
  for (let i = offset - 1; i >= 0; i--) {
    const ch = code[i];
    if (ch === ')') depth++;
    else if (ch === '(') {
      if (depth > 0) {
        depth--;
        continue;
      }
      const before = code.slice(0, i).match(/[A-Za-z_][A-Za-z0-9_]*\s*$/)?.[0]?.trim();
      if (!before) return undefined;
      const argText = code.slice(i + 1, offset);
      return { name: before, argIndex: argText.trim() ? splitArgs(argText).length - 1 : 0 };
    }
  }
  return undefined;
}

function splitArgs(text: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      args.push(text.slice(start, i));
      start = i + 1;
    }
  }
  args.push(text.slice(start));
  return args;
}

function dedupe(items: GalaxyCompletionItem[]): GalaxyCompletionItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.kind}:${item.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function leadingCloseBraceDedent(line: string): number {
  return line.startsWith('}') ? 1 : 0;
}

function braceDelta(line: string): number {
  let delta = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === '/' && next === '/') break;
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '{') delta += 1;
    else if (ch === '}') delta -= 1;
  }

  return delta;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
