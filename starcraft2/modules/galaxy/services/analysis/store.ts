import type {
  FunctionDeclaration,
  SourceFile,
  StructDeclaration,
  TypedefDeclaration,
  VariableDeclaration,
} from '../../language-core/index.js';
import { Parser, SyntaxKind, getKindName } from '../../language-core/index.js';
import {
  analyzeGalaxyLanguage,
  galaxyReferencesAt,
  galaxyWordAt,
  type GalaxyCompletionItem,
  type GalaxyLanguageSymbol,
  type GalaxyReferenceInfo,
} from './language-service.js';
import type {
  GalaxyWorkspaceDefinition,
  GalaxyWorkspaceFile,
  GalaxyWorkspaceLocation,
  GalaxyWorkspaceReference,
} from './workspace-index.js';

type TopDeclaration = FunctionDeclaration | VariableDeclaration | StructDeclaration | TypedefDeclaration;

interface StoreFile extends GalaxyWorkspaceFile {
  sourceFile: SourceFile;
}

interface PendingFile {
  fileName: string;
  code: string;
  sourceFile: SourceFile;
}

export interface GalaxyRenameEdit {
  fileName: string;
  edits: GalaxyWorkspaceLocation[];
}

/**
 * Workspace-level Galaxy store.
 *
 * It owns parsed source files, unique top-level declaration indexes, and the
 * language indexes that consume those declarations for diagnostics/completions.
 */
export class GalaxyStore {
  private readonly files = new Map<string, StoreFile>();
  private readonly sourceByFile = new Map<string, string>();
  private readonly parser = new Parser();

  updateFile(fileName: string, code: string): StoreFile {
    this.sourceByFile.set(fileName, code);
    this.reindex();
    return this.files.get(fileName)!;
  }

  removeFile(fileName: string): void {
    this.sourceByFile.delete(fileName);
    this.reindex();
  }

  clear(): void {
    this.sourceByFile.clear();
    this.files.clear();
  }

  getFile(fileName: string): StoreFile | undefined {
    return this.files.get(fileName);
  }

  listFiles(): StoreFile[] {
    return [...this.files.values()];
  }

  completions(fileName: string): GalaxyCompletionItem[] {
    return this.files.get(fileName)?.index.completions ?? [];
  }

  definitionsByName(name: string): GalaxyWorkspaceDefinition[] {
    const out: GalaxyWorkspaceDefinition[] = [];
    for (const file of this.files.values()) {
      for (const symbol of flattenSymbols(file.index.symbols)) {
        if (symbol.name !== name) continue;
        out.push({ fileName: file.fileName, start: symbol.selection.start, end: symbol.selection.end, symbol });
      }
    }
    return out;
  }

  definitionAt(fileName: string, offset: number): GalaxyWorkspaceDefinition | undefined {
    const file = this.files.get(fileName);
    if (!file) return undefined;
    const word = galaxyWordAt(file.code, offset);
    if (!word) return undefined;
    const definitions = this.definitionsByName(word.name)
      .filter(def => def.symbol.kind !== 'parameter' && def.symbol.kind !== 'property');
    if (definitions.length !== 1) return undefined;
    return definitions[0];
  }

  referencesAt(fileName: string, offset: number): GalaxyWorkspaceReference[] {
    const file = this.files.get(fileName);
    if (!file) return [];
    const word = galaxyWordAt(file.code, offset);
    if (!word || !this.definitionAt(fileName, offset)) return [];
    if (this.definitionsByName(word.name).length !== 1) return [];

    const out: GalaxyWorkspaceReference[] = [];
    for (const candidate of this.files.values()) {
      for (const ref of referencesByName(candidate, word.name)) out.push(ref);
    }
    return out;
  }

  renameEdits(fileName: string, offset: number): GalaxyRenameEdit[] {
    const refs = this.referencesAt(fileName, offset);
    const byFile = new Map<string, GalaxyWorkspaceLocation[]>();
    for (const ref of refs) {
      const edits = byFile.get(ref.fileName) ?? [];
      edits.push({ fileName: ref.fileName, start: ref.start, end: ref.end });
      byFile.set(ref.fileName, edits);
    }
    return [...byFile.entries()].map(([targetFile, edits]) => ({ fileName: targetFile, edits }));
  }

  private reindex(): void {
    const pending: PendingFile[] = [];
    const declarationsByName = new Map<string, TopDeclaration[]>();

    for (const [fileName, code] of this.sourceByFile) {
      const sourceFile = this.parser.parseFile(fileName, code);
      pending.push({ fileName, code, sourceFile });
      for (const decl of topLevelDeclarations(sourceFile)) {
        const name = decl.name.name;
        const list = declarationsByName.get(name) ?? [];
        list.push(decl);
        declarationsByName.set(name, list);
      }
    }

    const uniqueDeclaration = (name: string): TopDeclaration | undefined => {
      const declarations = declarationsByName.get(name) ?? [];
      return declarations.length === 1 ? declarations[0] : undefined;
    };

    const workspaceCompletions: GalaxyCompletionItem[] = [];
    for (const [name, declarations] of declarationsByName) {
      if (declarations.length !== 1) continue;
      const detail = declarationDetail(declarations[0]!);
      workspaceCompletions.push({
        label: name,
        kind: symbolKind(declarations[0]!),
        detail,
        insertText: declarations[0]!.kind === SyntaxKind.FunctionDeclaration ? `${name}($0)` : name,
      });
    }

    this.files.clear();
    for (const file of pending) {
      const index = analyzeGalaxyLanguage(file.code, file.fileName, {
        extraCompletions: workspaceCompletions,
        resolveGlobalDeclaration: uniqueDeclaration,
      });
      this.files.set(file.fileName, { ...file, index });
    }
  }
}

function topLevelDeclarations(sourceFile: SourceFile): TopDeclaration[] {
  return Array.from(sourceFile.statements ?? []).filter((stmt): stmt is TopDeclaration =>
    stmt.kind === SyntaxKind.FunctionDeclaration ||
    stmt.kind === SyntaxKind.VariableDeclaration ||
    stmt.kind === SyntaxKind.StructDeclaration ||
    stmt.kind === SyntaxKind.TypedefDeclaration,
  );
}

function declarationDetail(decl: TopDeclaration): string {
  if (decl.kind === SyntaxKind.FunctionDeclaration) {
    const fn = decl as FunctionDeclaration;
    return `${typeName(fn.type)} ${fn.name.name}(${Array.from(fn.parameters ?? []).map(param => `${typeName(param.type)} ${param.name.name}`).join(', ')})`;
  }
  if (decl.kind === SyntaxKind.VariableDeclaration) return typeName((decl as VariableDeclaration).type);
  if (decl.kind === SyntaxKind.TypedefDeclaration) return typeName((decl as TypedefDeclaration).type);
  return 'struct';
}

function typeName(node: { kind: SyntaxKind; name?: string } | undefined): string {
  if (!node) return 'unknown';
  if (node.kind === SyntaxKind.Identifier) return node.name ?? 'unknown';
  return (getKindName(node.kind) || 'unknown').replace(/Keyword$/, '').toLowerCase();
}

function symbolKind(decl: TopDeclaration): GalaxyLanguageSymbol['kind'] {
  switch (decl.kind) {
    case SyntaxKind.FunctionDeclaration: return 'function';
    case SyntaxKind.VariableDeclaration: return 'variable';
    case SyntaxKind.StructDeclaration: return 'struct';
    case SyntaxKind.TypedefDeclaration: return 'typedef';
    default: return 'variable';
  }
}

function referencesByName(file: StoreFile, name: string): GalaxyWorkspaceReference[] {
  const probeOffset = file.code.search(new RegExp(`\\b${escapeRegExp(name)}\\b`));
  if (probeOffset < 0) return [];
  return galaxyReferencesAt(file.code, probeOffset).map((ref: GalaxyReferenceInfo) => ({
    fileName: file.fileName,
    name,
    start: ref.start,
    end: ref.end,
  }));
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
