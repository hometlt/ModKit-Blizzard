import {
  analyzeGalaxyLanguage,
  galaxyDefinitionAt,
  galaxyWordAt,
  type GalaxyLanguageIndex,
  type GalaxyLanguageSymbol,
} from './language-service.js';
import { TypeChecker } from '../../language-core/checker.js';
import { forEachChild } from '../../language-core/utils.js';
import { SyntaxKind, type Identifier, type Node } from '../../language-core/types.js';

export interface GalaxyWorkspaceFile {
  fileName: string;
  code: string;
  index: GalaxyLanguageIndex;
}

export interface GalaxyWorkspaceLocation {
  fileName: string;
  start: number;
  end: number;
}

export interface GalaxyWorkspaceDefinition extends GalaxyWorkspaceLocation {
  symbol: GalaxyLanguageSymbol;
}

export interface GalaxyWorkspaceReference extends GalaxyWorkspaceLocation {
  name: string;
}

/**
 * Small workspace index for Galaxy editor features.
 *
 * This is intentionally conservative: it resolves top-level declarations across
 * indexed files and avoids claiming scoped rename/reference precision until the
 * full plaxtony checker/store is wired in.
 */
export class GalaxyWorkspaceIndex {
  private readonly files = new Map<string, GalaxyWorkspaceFile>();
  /** Files handed over pre-analyzed (the bundled native API), which have no source the user can open. */
  private readonly synthetic = new Set<string>();
  /**
   * Top-level symbols by name, built on the first lookup. Completion asks for every candidate's
   * declaration and diagnostics for every call; scanning all files each time took 12 s in a 2 MB
   * MapScript over the Void chain (plan 2.14).
   */
  private byName: Map<string, { file: GalaxyWorkspaceFile; symbol: GalaxyLanguageSymbol }[]> | undefined;

  updateFile(fileName: string, code: string): GalaxyWorkspaceFile {
    const file = { fileName, code, index: analyzeGalaxyLanguage(code, fileName) };
    this.files.set(fileName, file);
    this.byName = undefined;
    return file;
  }

  addAnalyzedFile(file: GalaxyWorkspaceFile): GalaxyWorkspaceFile {
    if (
      typeof file?.fileName !== 'string' ||
      typeof file?.code !== 'string' ||
      typeof file?.index !== 'object' ||
      file.index === null
    ) {
      throw new TypeError('analyzed Galaxy file must contain fileName, code and index');
    }
    this.files.set(file.fileName, file);
    this.synthetic.add(file.fileName);
    this.byName = undefined;
    return file;
  }

  removeFile(fileName: string): void {
    this.files.delete(fileName);
    this.byName = undefined;
  }

  clear(): void {
    this.files.clear();
    this.byName = undefined;
  }

  getFile(fileName: string): GalaxyWorkspaceFile | undefined {
    return this.files.get(fileName);
  }

  listFiles(): GalaxyWorkspaceFile[] {
    return [...this.files.values()];
  }

  definitionsByName(name: string, visibleFromFileName?: string): GalaxyWorkspaceDefinition[] {
    const out: GalaxyWorkspaceDefinition[] = [];
    for (const { file, symbol } of this.symbolsNamed(name)) {
      if (
        visibleFromFileName !== undefined &&
        file.fileName !== visibleFromFileName &&
        isFileLocalSymbol(file, symbol)
      ) continue;
      out.push({
        fileName: file.fileName,
        start: symbol.selection.start,
        end: symbol.selection.end,
        symbol,
      });
    }
    return out;
  }

  private symbolsNamed(name: string): readonly { file: GalaxyWorkspaceFile; symbol: GalaxyLanguageSymbol }[] {
    if (this.byName === undefined) {
      const byName = new Map<string, { file: GalaxyWorkspaceFile; symbol: GalaxyLanguageSymbol }[]>();
      for (const file of this.files.values()) {
        for (const symbol of flattenSymbols(file.index.symbols)) {
          const named = byName.get(symbol.name);
          if (named === undefined) byName.set(symbol.name, [{ file, symbol }]);
          else named.push({ file, symbol });
        }
      }
      this.byName = byName;
    }
    return this.byName.get(name) ?? [];
  }

  definitionAt(fileName: string, offset: number): GalaxyWorkspaceDefinition | undefined {
    const file = this.files.get(fileName);
    if (!file) return undefined;

    const local = galaxyDefinitionAt(file.code, offset, fileName);
    if (local) {
      return {
        fileName,
        start: local.selection.start,
        end: local.selection.end,
        symbol: local,
      };
    }

    const word = galaxyWordAt(file.code, offset);
    if (!word) return undefined;
    const definitions = this.definitionsByName(word.name, fileName).filter((d) => d.symbol.kind !== 'parameter' && d.symbol.kind !== 'property');
    return this.uniqueDefinition(definitions);
  }

  /** The single declaration of `name`, collapsing declarations that repeat one another. */
  uniqueDefinitionByName(
    name: string,
    visibleFromFileName?: string,
  ): GalaxyWorkspaceDefinition | undefined {
    return this.uniqueDefinition(
      this.definitionsByName(name, visibleFromFileName).filter(
        (item) => item.symbol.kind !== 'parameter' && item.symbol.kind !== 'property',
      ),
    );
  }

  /** A `native` declaration carries no body, so repeating it declares nothing new. */
  private isNativeDeclaration(definition: GalaxyWorkspaceDefinition): boolean {
    const file = this.files.get(definition.fileName);
    return (
      file !== undefined &&
      /\bnative\b/u.test(file.code.slice(definition.symbol.start, definition.symbol.selection.start))
    );
  }

  /**
   * One declaration, or several that are the same declaration: a mod ships `TriggerLibs/natives.galaxy`
   * declaring the natives the bundled API also declares, and treating that repetition as an ambiguity
   * loses definition, hover and references for every native as soon as that file is in the snapshot.
   * Genuinely different signatures stay ambiguous, and a file the user can open wins over the bundled one.
   */
  private uniqueDefinition(
    definitions: GalaxyWorkspaceDefinition[],
  ): GalaxyWorkspaceDefinition | undefined {
    if (definitions.length <= 1) return definitions[0];
    if (new Set(definitions.map(signatureOf)).size !== 1) return undefined;
    if (!definitions.every((item) => this.isNativeDeclaration(item))) return undefined;
    const openable = definitions.filter((item) => !this.synthetic.has(item.fileName));
    return [...(openable.length > 0 ? openable : definitions)].sort((left, right) =>
      left.fileName.localeCompare(right.fileName),
    )[0];
  }

  referencesAt(fileName: string, offset: number): GalaxyWorkspaceReference[] {
    const file = this.files.get(fileName);
    if (!file) return [];
    const word = galaxyWordAt(file.code, offset);
    if (!word) return [];

    const definition = this.definitionAt(fileName, offset);
    if (!definition) return [];
    if (this.uniqueDefinition(this.definitionsByName(word.name, fileName)) === undefined) return [];

    const documents = new Map(this.listFiles().map(candidate => [candidate.fileName, candidate.index.sourceFile]));
    const checker = new TypeChecker({
      documents,
      qualifiedDocuments: new Map(),
      resolveGlobalSymbol: name => {
        const declaration = this.uniqueDefinitionByName(name);
        return declaration === undefined ? undefined : documents.get(declaration.fileName)?.symbol?.members?.get(name);
      },
    });
    const target = documents.get(definition.fileName)?.symbol?.members?.get(word.name);
    if (target === undefined) return [];
    const native = this.isNativeDeclaration(definition);
    const out: GalaxyWorkspaceReference[] = [];
    for (const candidate of this.files.values()) {
      const visit = (node: Node): void => {
        if (node.kind === SyntaxKind.Identifier && (node as Identifier).name === word.name) {
          const symbol = checker.getSymbolAtLocation(node);
          if (symbol === target || (native && symbol?.declarations.every(declaration =>
            declaration.kind === SyntaxKind.FunctionDeclaration &&
            declaration.modifiers?.some(modifier => modifier.kind === SyntaxKind.NativeKeyword)))) {
            out.push({ fileName: candidate.fileName, name: word.name, start: node.pos, end: node.end });
          }
        }
        forEachChild(node, visit);
      };
      visit(candidate.index.sourceFile);
    }
    return out;
  }
}

/** Kind plus return and parameter types; parameter names may differ between two declarations of one native. */
function signatureOf(definition: GalaxyWorkspaceDefinition): string {
  const detail = definition.symbol.detail ?? '';
  const open = detail.indexOf('(');
  if (open < 0) return `${definition.symbol.kind} ${detail.trim()}`;
  const types = detail
    .slice(open + 1, detail.lastIndexOf(')'))
    .split(',')
    .map((parameter) => parameter.trim().split(/\s+/u)[0])
    .join(',');
  return `${definition.symbol.kind} ${detail.slice(0, open).trim().split(/\s+/u)[0]}(${types})`;
}

function isFileLocalSymbol(file: GalaxyWorkspaceFile, symbol: GalaxyLanguageSymbol): boolean {
  return /\bstatic\b/u.test(file.code.slice(symbol.start, symbol.selection.start));
}

function flattenSymbols(symbols: GalaxyLanguageSymbol[]): GalaxyLanguageSymbol[] {
  const out: GalaxyLanguageSymbol[] = [];
  const visit = (symbol: GalaxyLanguageSymbol) => {
    out.push(symbol);
    for (const child of symbol.children ?? []) visit(child);
  };
  for (const symbol of symbols) visit(symbol);
  return out;
}
