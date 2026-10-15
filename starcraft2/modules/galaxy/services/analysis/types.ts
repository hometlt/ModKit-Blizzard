export type GalaxySymbolKind = 'function' | 'variable' | 'struct' | 'property' | 'parameter' | 'typedef' | 'include';

/**
 * JSON-safe resource projection owned by Galaxy analysis. Keep this model free of parser imports
 * so other codecs consume its declarations without compiling the Galaxy parser in their project.
 */
export interface GalaxySymbolTreeNode {
  name: string;
  kind: GalaxySymbolKind;
  detail?: string;
  /** Global variable declaration, including its initializer; this is not a runtime value. */
  declaration?: string;
  /** UTF-16 offset of the symbol's name in source, for jump-to-definition. */
  selectionStart?: number;
  children?: GalaxySymbolTreeNode[];
}

/**
 * Результат анализа Galaxy скрипта
 */
export interface GalaxyAnalysisResult {
  /** Имя файла */
  fileName: string;
  /** Глобальные функции */
  functions: GalaxyFunction[];
  /** Глобальные переменные */
  variables: GalaxyVariable[];
  /** Структуры */
  structs: GalaxyStruct[];
  /** Catalog refs — ссылки на каталоги SC2 */
  catalogRefs: CatalogRef[];
  /** #include директивы */
  includes: string[];
  /** AST диагностики (parse errors) */
  diagnostics: GalaxyDiagnostic[];
}

export interface GalaxyFunction {
  name: string;
  returnType: string;
  parameters: GalaxyParameter[];
  isNative?: boolean;
  isStatic?: boolean;
  body?: string; // galaxy-код тела (опционально)
}

export interface GalaxyVariable {
  name: string;
  type: string;
  isConst?: boolean;
  isStatic?: boolean;
  initializer?: string;
}

export interface GalaxyStruct {
  name: string;
  members: GalaxyVariable[];
}

export interface GalaxyParameter {
  name: string;
  type: string;
}

export interface CatalogRef {
  catalog: string;
  entry: string;
  /** Путь внутри файла (line:col или function name) */
  location: string;
}

export interface GalaxyDiagnostic {
  message: string;
  line?: number;
  col?: number;
}
