import {
  Parser,
  bindSourceFile,
  Printer,
} from '../../language-core/index.js';

import {
  SyntaxKind,
} from '../../language-core/index.js';

import type {
  SourceFile,
  FunctionDeclaration,
  VariableDeclaration,
  StructDeclaration,
  ParameterDeclaration,
  IncludeStatement,
  CallExpression,
  StringLiteral,
  Node,
  Diagnostic,
} from '../../language-core/index.js';

import type {
  GalaxyAnalysisResult,
  GalaxyFunction,
  GalaxyVariable,
  GalaxyStruct,
  CatalogRef,
  GalaxyDiagnostic,
} from './types.js';

function getTypeText(node: Node): string {
  const printer = new Printer();
  return printer.printNode(node).trim();
}

function getIdentifierName(node: Node): string {
  if ((node as any).name) {
    return (node as any).name.name ?? '';
  }
  return '';
}

function nodeText(node: Node): string {
  const printer = new Printer();
  return printer.printNode(node).trim();
}

function extractCatalogRefs(sourceFile: SourceFile): CatalogRef[] {
  const refs: CatalogRef[] = [];
  const visited = new Set<Node>();

  const catalogFunctions: Record<string, { catalog: string; argIndex: number }> = {
    UnitCreate: { catalog: 'Unit', argIndex: 1 },
    CreateUnit: { catalog: 'Unit', argIndex: 1 },
    UnitTypeFromName: { catalog: 'Unit', argIndex: 0 },
    UnitTypeFromString: { catalog: 'Unit', argIndex: 0 },
    TechTreeAbilityAdd: { catalog: 'Abil', argIndex: 1 },
    TechTreeAbilityRemove: { catalog: 'Abil', argIndex: 1 },
    AbilityCommand: { catalog: 'Abil', argIndex: 0 },
    ActorCreate: { catalog: 'Actor', argIndex: 2 },
    ActorFromName: { catalog: 'Actor', argIndex: 0 },
    TechTreeUpgradeAdd: { catalog: 'Upgrade', argIndex: 1 },
    UpgradeCreate: { catalog: 'Upgrade', argIndex: 0 },
    BehaviorAdd: { catalog: 'Behavior', argIndex: 2 },
    BehaviorRemove: { catalog: 'Behavior', argIndex: 2 },
    EffectCreate: { catalog: 'Effect', argIndex: 0 },
    EffectTypeFromName: { catalog: 'Effect', argIndex: 0 },
    WeaponCreate: { catalog: 'Weapon', argIndex: 0 },
    WeaponTypeFromName: { catalog: 'Weapon', argIndex: 0 },
    PlayerSetRace: { catalog: 'Race', argIndex: 1 },
    RaceGetName: { catalog: 'Race', argIndex: 0 },
  };

  function visit(node: Node) {
    if (!node || visited.has(node)) return;
    visited.add(node);

    if (node.kind === SyntaxKind.CallExpression) {
      const call = node as CallExpression;
      const funcName = nodeText(call.expression);
      const mapping = catalogFunctions[funcName];

      if (mapping && call.arguments && call.arguments.length > mapping.argIndex) {
        const arg = call.arguments[mapping.argIndex];
        if (arg.kind === SyntaxKind.StringLiteral) {
          const lit = arg as StringLiteral;
          refs.push({
            catalog: mapping.catalog,
            entry: lit.text?.replace(/"/g, '') ?? '',
            location: `${funcName}(...)`,
          });
        }
      }
    }

    for (const key of Object.keys(node)) {
      if (key === 'parent' || key === 'symbol' || key === 'resolvedSymbol') continue;
      const child = (node as any)[key];
      if (child && typeof child === 'object') {
        if (Array.isArray(child)) {
          for (const c of child) {
            if (c && typeof c === 'object' && 'kind' in c) {
              visit(c);
            }
          }
        } else if ('kind' in child) {
          visit(child);
        }
      }
    }
  }

  visit(sourceFile);
  return refs;
}

function extractIncludes(sourceFile: SourceFile): string[] {
  const includes: string[] = [];
  if (!sourceFile.statements) return includes;

  for (const stmt of sourceFile.statements) {
    if (stmt.kind === SyntaxKind.IncludeStatement) {
      const inc = stmt as IncludeStatement;
      if (inc.path && inc.path.text) {
        includes.push(inc.path.text.replace(/"/g, ''));
      }
    }
  }
  return includes;
}

function extractDeclarations(sourceFile: SourceFile): {
  functions: GalaxyFunction[];
  variables: GalaxyVariable[];
  structs: GalaxyStruct[];
} {
  const functions: GalaxyFunction[] = [];
  const variables: GalaxyVariable[] = [];
  const structs: GalaxyStruct[] = [];

  if (!sourceFile.statements) return { functions, variables, structs };

  for (const stmt of sourceFile.statements) {
    switch (stmt.kind) {
      case SyntaxKind.FunctionDeclaration: {
        const func = stmt as FunctionDeclaration;
        functions.push({
          name: getIdentifierName(func),
          returnType: func.type ? getTypeText(func.type) : 'void',
          parameters: (func.parameters ?? []).map((p: ParameterDeclaration) => ({
            name: getIdentifierName(p),
            type: p.type ? getTypeText(p.type) : 'unknown',
          })),
          isNative: func.modifiers?.some((m: any) => m.kind === SyntaxKind.NativeKeyword) ?? false,
          isStatic: func.modifiers?.some((m: any) => m.kind === SyntaxKind.StaticKeyword) ?? false,
        });
        break;
      }

      case SyntaxKind.VariableDeclaration: {
        const v = stmt as VariableDeclaration;
        variables.push({
          name: getIdentifierName(v),
          type: v.type ? getTypeText(v.type) : 'unknown',
          isConst: v.modifiers?.some((m: any) => m.kind === SyntaxKind.ConstKeyword) ?? false,
          isStatic: v.modifiers?.some((m: any) => m.kind === SyntaxKind.StaticKeyword) ?? false,
          initializer: v.initializer ? nodeText(v.initializer) : undefined,
        });
        break;
      }

      case SyntaxKind.StructDeclaration: {
        const s = stmt as StructDeclaration;
        structs.push({
          name: getIdentifierName(s),
          members: (s.members ?? []).map((m: any) => ({
            name: getIdentifierName(m),
            type: m.type ? getTypeText(m.type) : 'unknown',
          })),
        });
        break;
      }
    }
  }

  return { functions, variables, structs };
}

function convertDiagnostics(diagnostics: Diagnostic[]): GalaxyDiagnostic[] {
  return diagnostics.map((d) => ({
    message: d.messageText as string,
    line: d.line,
    col: d.col,
  }));
}

export function analyzeGalaxyScript(fileName: string, code: string): GalaxyAnalysisResult {
  const parser = new Parser();
  const sourceFile = parser.parseFile(fileName, code);
  const parseDiagnostics = sourceFile.parseDiagnostics ?? [];

  if (parseDiagnostics.length > 0) {
    return {
      fileName,
      functions: [],
      variables: [],
      structs: [],
      catalogRefs: [],
      includes: [],
      diagnostics: convertDiagnostics(parseDiagnostics),
    };
  }

  const store = {
    symbols: new Map(),
    resolveGlobalSymbol: (_name: string) => undefined,
  };
  bindSourceFile(sourceFile, store);

  const { functions, variables, structs } = extractDeclarations(sourceFile);
  const catalogRefs = extractCatalogRefs(sourceFile);
  const includes = extractIncludes(sourceFile);

  const allDiagnostics = [
    ...parseDiagnostics,
    ...(sourceFile.bindDiagnostics ?? []),
  ];

  return {
    fileName,
    functions,
    variables,
    structs,
    catalogRefs,
    includes,
    diagnostics: convertDiagnostics(allDiagnostics),
  };
}
