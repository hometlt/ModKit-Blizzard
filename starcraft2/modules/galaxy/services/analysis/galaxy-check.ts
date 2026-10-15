/**
 * galaxy-check — syntax + symbol-resolution validation for Galaxy scripts.
 *
 * Two layers:
 *   1. Syntax: every file must parse with zero plaxtony parseDiagnostics.
 *   2. Symbols: every identifier must resolve to a local, parameter, global,
 *      dependency-library symbol, or a native — undeclared identifiers are
 *      reported (the class of error the game reports as
 *      "Unknown identifier" in ScriptError.txt).
 *
 * Used by scripts/validate-galaxy.ts (CLI) and the roundtrip test driver.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser, SyntaxKind } from '../../language-core/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');

export interface GalaxyFinding { file: string; line: number; message: string; kind: 'syntax' | 'symbol' }

export function listGalaxyFiles(p: string): string[] {
  const st = statSync(p);
  if (st.isFile()) return /\.galaxy$/i.test(p) ? [p] : [];
  const out: string[] = [];
  for (const name of readdirSync(p)) {
    const full = join(p, name);
    const st2 = statSync(full);
    if (st2.isDirectory()) out.push(...listGalaxyFiles(full));
    else if (/\.galaxy$/i.test(name)) out.push(full);
  }
  return out;
}

export function findDependencyFiles(): string[] {
  const candidates = [
    join(REPO_ROOT, 'testdata/core.sc2mod/base.sc2data/triggerlibs'),
    join(REPO_ROOT, 'assets/sc2-data-triggers/mods/core.sc2mod/base.sc2data/TriggerLibs'),
  ];
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    const wanted = ['natives.galaxy', 'nativelib.galaxy', 'nativelib_h.galaxy'];
    const found: string[] = [];
    for (const name of readdirSync(dir)) {
      if (wanted.includes(name.toLowerCase())) found.push(join(dir, name));
      // GameData constant libraries (c_gameCatalog*, etc.)
      const sub = join(dir, name);
      if (name.toLowerCase() === 'gamedata' && statSync(sub).isDirectory()) {
        for (const g of readdirSync(sub)) {
          if (/\.galaxy$/i.test(g)) found.push(join(sub, g));
        }
      }
    }
    if (found.length > 0) return found;
  }
  return [];
}

function lineOfPos(text: string, pos: number): number {
  let line = 1;
  for (let i = 0; i < pos && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

/** Collects top-level declared names (functions, vars, consts, structs, typedefs). */
function collectGlobals(sourceFile: any, into: Set<string>): void {
  for (const stmt of sourceFile.statements ?? []) {
    const kind = stmt.kind as SyntaxKind;
    const name = (stmt as any).name?.name;
    if (!name) continue;
    if (
      kind === SyntaxKind.FunctionDeclaration ||
      kind === SyntaxKind.VariableDeclaration ||
      kind === SyntaxKind.StructDeclaration ||
      kind === SyntaxKind.TypedefDeclaration
    ) {
      into.add(name);
    }
  }
}

/** Walks an AST subtree yielding identifier usage nodes (skips declaration names & member names). */
function* iterUsedIdentifiers(node: any, depth = 0): Generator<any> {
  if (!node || typeof node !== 'object' || depth > 200) return;
  const kind = node.kind as SyntaxKind;
  if (kind === SyntaxKind.Identifier) {
    yield node;
    return;
  }
  for (const key of Object.keys(node)) {
    if (key === 'parent' || key === 'pos' || key === 'end' || key === 'kind'
      || key === 'syntaxTokens' || key === 'name' && kind !== undefined && (
        kind === SyntaxKind.FunctionDeclaration ||
        kind === SyntaxKind.VariableDeclaration ||
        kind === SyntaxKind.ParameterDeclaration ||
        kind === SyntaxKind.StructDeclaration ||
        kind === SyntaxKind.TypedefDeclaration ||
        kind === SyntaxKind.PropertyDeclaration
      )) continue;
    // Property access member names are not free identifiers
    if (kind === SyntaxKind.PropertyAccessExpression && key === 'name') continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) yield* iterUsedIdentifiers(c, depth + 1);
    } else if (v && typeof v === 'object') {
      yield* iterUsedIdentifiers(v, depth + 1);
    }
  }
}


export interface GalaxyCheckResult {
  files: number;
  findings: GalaxyFinding[];
}

/**
 * Validates a set of galaxy files. `depFiles` provide extra global symbols
 * (natives.galaxy, nativelib.galaxy, GameData constants, ...) and are not
 * themselves checked.
 */
export function checkGalaxyScripts(targetFiles: string[], depFiles: string[]): GalaxyCheckResult {
  const findings: GalaxyFinding[] = [];
  const globals = new Set<string>();
  const parsed: Array<{ file: string; text: string; sf: any }> = [];

  for (const file of depFiles) {
    const text = readFileSync(file, 'utf8');
    const sf = new Parser().parseFile(basename(file), text);
    collectGlobals(sf, globals);
  }
  for (const file of targetFiles) {
    const text = readFileSync(file, 'utf8');
    const sf = new Parser().parseFile(basename(file), text);
    for (const diag of sf.parseDiagnostics ?? []) {
      findings.push({
        file, kind: 'syntax',
        line: lineOfPos(text, diag.start ?? 0),
        message: diag.messageText ?? String(diag),
      });
    }
    collectGlobals(sf, globals);
    parsed.push({ file, text, sf });
  }

  const BUILTIN = new Set(['true', 'false', 'null']);

  for (const { file, text, sf } of parsed) {
    for (const stmt of sf.statements ?? []) {
      if ((stmt.kind as SyntaxKind) !== SyntaxKind.FunctionDeclaration) continue;
      const fd: any = stmt;
      if (!fd.body) continue;
      const scope = new Set<string>();
      for (const p of fd.parameters ?? []) {
        const pn = p?.name?.name;
        if (pn) scope.add(pn);
      }
      const collectLocals = (n: any, depth = 0) => {
        if (!n || typeof n !== 'object' || depth > 200) return;
        if ((n.kind as SyntaxKind) === SyntaxKind.VariableDeclaration && n.name?.name) scope.add(n.name.name);
        for (const k of Object.keys(n)) {
          if (k === 'parent' || k === 'pos' || k === 'end') continue;
          const v = n[k];
          if (Array.isArray(v)) v.forEach(c => collectLocals(c, depth + 1));
          else if (v && typeof v === 'object') collectLocals(v, depth + 1);
        }
      };
      collectLocals(fd.body);

      const reported = new Set<string>();
      for (const id of iterUsedIdentifiers(fd.body)) {
        const n: string = id.name;
        if (!n || scope.has(n) || globals.has(n) || BUILTIN.has(n) || reported.has(n)) continue;
        reported.add(n);
        findings.push({
          file, kind: 'symbol',
          line: lineOfPos(text, id.pos ?? 0),
          message: `undeclared identifier '${n}' in function ${fd.name?.name ?? '?'}`,
        });
      }
    }
  }

  return { files: targetFiles.length, findings };
}

export function formatGalaxyFindings(result: GalaxyCheckResult): string {
  if (result.findings.length === 0) return `galaxy OK — ${result.files} file(s), 0 findings`;
  const syntax = result.findings.filter(f => f.kind === 'syntax').length;
  const symbol = result.findings.filter(f => f.kind === 'symbol').length;
  const lines = result.findings.slice(0, 100).map(f => `  [${f.kind}] ${basename(f.file)}:${f.line}: ${f.message}`);
  let out = `galaxy FAILED — ${result.findings.length} finding(s) (syntax=${syntax} symbol=${symbol})\n${lines.join('\n')}`;
  if (result.findings.length > 100) out += `\n  ... and ${result.findings.length - 100} more`;
  return out;
}
