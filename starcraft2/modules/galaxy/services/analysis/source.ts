import { Parser } from '../../language-core/parser.js';
import { Printer } from '../../language-core/printer.js';
import type { Node, SourceFile } from '../../language-core/types.js';

export interface ParseGalaxySourceOptions {
  fileName?: string;
  preserveSourceText?: boolean;
}

export function parseGalaxySource(code: string, options: ParseGalaxySourceOptions | string = {}): SourceFile {
  const opts = typeof options === 'string' ? { fileName: options } : options;
  const parser = new Parser();
  const sourceFile = parser.parseFile(opts.fileName ?? 'Lib.galaxy', code);
  if (opts.preserveSourceText ?? true) {
    (sourceFile as any).__sourceText = code;
  }
  return sourceFile;
}

export function printGalaxyNode(node: Node): string {
  return new Printer().printNode(node);
}

export function printGalaxySource(sourceFile: SourceFile): string {
  return printGalaxyNode(sourceFile);
}
