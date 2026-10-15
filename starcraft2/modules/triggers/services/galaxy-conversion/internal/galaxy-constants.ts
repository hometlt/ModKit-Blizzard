import { SyntaxKind } from '@modkit/blizzard-starcraft2/galaxy/language-core';
import { conversionError } from './conversion-model.js';
import { printNode } from './script-template.js';

export interface ConstantFold { expression: string; value: number; declarations: Array<{ name: string; file: string }> }
type Declaration = { initializer?: any; file: string; ambiguous?: boolean };

/** Integer constant expressions only: never execute user Galaxy or guess symbol names. */
export class GalaxyConstantIndex {
  private declarations = new Map<string, Declaration>();
  constructor(sources: Array<{ statements: readonly any[]; fileName?: string }>, readonly folds: ConstantFold[] = []) {
    for (const source of sources) this.add(source.statements, source.fileName ?? '', false);
  }

  private add(statements: readonly any[], file: string, shadow: boolean): void {
    for (const node of statements) {
      if (![SyntaxKind.VariableDeclaration, SyntaxKind.ParameterDeclaration].includes(node.kind)) continue;
      const name = node.name?.name;
      if (!name) continue;
      const initializer = node.modifiers?.some((m: any) => m.kind === SyntaxKind.ConstKeyword) && node.type?.kind === SyntaxKind.IntKeyword ? node.initializer : undefined;
      const old = this.declarations.get(name);
      if (!shadow && old) {
        if (old.ambiguous || !initializer || !old.initializer || printNode(old.initializer) !== printNode(initializer)) this.declarations.set(name, { file, ambiguous: true });
      } else this.declarations.set(name, { file, initializer });
    }
  }

  scope(statements: readonly any[]): GalaxyConstantIndex {
    const index = new GalaxyConstantIndex([], this.folds);
    index.declarations = new Map(this.declarations);
    index.add(statements, '<local>', true);
    return index;
  }

  evaluate(expression: any): number | undefined {
    const visiting = new Set<string>(), used = new Map<string, string>();
    const checked = (value: number): number | undefined => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 ? value : undefined;
    const evaluate = (node: any, depth = 0): number | undefined => {
      if (!node || depth > 128) return undefined;
      if (node.kind === SyntaxKind.ParenthesizedExpression) return evaluate(node.expression, depth + 1);
      if (node.kind === SyntaxKind.NumericLiteral) return checked(Number(node.text ?? node.value));
      if (node.kind === SyntaxKind.Identifier) {
        const declaration = this.declarations.get(node.name);
        if (!declaration?.initializer || declaration.ambiguous) return undefined;
        if (visiting.has(node.name)) conversionError('CONSTANT_CYCLE', 'Cyclic Galaxy constant expression', { symbol: node.name, file: declaration.file });
        visiting.add(node.name);
        const value = evaluate(declaration.initializer, depth + 1);
        visiting.delete(node.name);
        if (value !== undefined) used.set(node.name, declaration.file);
        return value;
      }
      if (node.kind === SyntaxKind.PrefixUnaryExpression) {
        // Permit -2147483648, whose positive operand is outside signed int.
        const value = node.operand?.kind === SyntaxKind.NumericLiteral ? Number(node.operand.text ?? node.operand.value) : evaluate(node.operand, depth + 1);
        if (value === undefined) return undefined;
        switch (node.operator?.kind) {
          case SyntaxKind.MinusToken: return checked(-value);
          case SyntaxKind.PlusToken: return checked(value);
          case SyntaxKind.TildeToken: return checked(value) === undefined ? undefined : ~value;
        }
      }
      if (node.kind !== SyntaxKind.BinaryExpression) return undefined;
      const left = evaluate(node.left, depth + 1), right = evaluate(node.right, depth + 1);
      if (left === undefined || right === undefined) return undefined;
      switch (node.operatorToken?.kind) {
        case SyntaxKind.PlusToken: return checked(left + right);
        case SyntaxKind.MinusToken: return checked(left - right);
        case SyntaxKind.AsteriskToken: return checked(left * right);
        case SyntaxKind.SlashToken: return right ? checked(Math.trunc(left / right)) : undefined;
        case SyntaxKind.PercentToken: return right ? checked(left % right) : undefined;
        case SyntaxKind.AmpersandToken: return left & right;
        case SyntaxKind.BarToken: return left | right;
        case SyntaxKind.CaretToken: return left ^ right;
      }
      return undefined;
    };
    const value = evaluate(expression);
    if (value !== undefined && used.size) this.folds.push({ expression: printNode(expression), value, declarations: [...used].map(([name, file]) => ({ name, file })) });
    return value;
  }
}
