/**
 * Строго типизированное JSON-представление библиотеки триггеров SC2.
 */

export interface TriggerLibraryJson {
  id: string;
  name?: string;
  items: ElementJson[];
  /** Root references exactly as the document wrote them, including any whose
   *  element is defined in another document. `items` holds only the ones this
   *  document could resolve, so a layered resolver needs both. */
  rootRefs?: ElementRefJson[];
  /** Whether the document declared a Root section; an empty Root is not the
   *  same as no Root when layers are combined. */
  hasRoot?: boolean;
  /** Set when the document declared no <Library> at all, i.e. it is a map: the
   *  library is synthesized to give the model something to hang content on.
   *  A map writes its references without a Library attribute and its generated
   *  Galaxy without the `lib<Id>_` namespace prefix. */
  implicit?: boolean;
  /** TriggerStrings for this document were supplied, including an explicitly
   *  empty file. This lets text parameters distinguish an absent localized
   *  value from an unresolved strings layer. */
  triggerStringsLoaded?: boolean;
  /** A localized string table containing Param/Value keys was supplied. */
  paramValuesLoaded?: boolean;
  /** Both editor string tables were supplied for the selected locale. */
  completeLocalizedValues?: boolean;
  /** Set when the library comes from another package: the Galaxy file a
   *  dependent script includes whole, before its own header — for a shipped
   *  library its path under Base.SC2Data (`TriggerLibs/SwarmCampaignLib`),
   *  otherwise `Lib<Id>`. A library of the same document has none. */
  includePath?: string;
  /** Flat element map keyed by "type:id" (e.g. "FunctionDef:00000136") */
  elements: Record<string, ElementJson>;
  /** SubFuncType role names from NativeLib TriggerStrings.
   *  Key: "{libId}_{elementId}" (e.g. "Ntve_00000003"), value: role name ("If", "Then", "Else", "Actions", "Conditions")
   *  Only populated for the NativeLib; used by script-bridge for control flow generation. */
  subFuncTypeNames?: Record<string, string>;
  /** Type-specific element maps. Same ID can exist in multiple maps
   * (e.g. 00000136 is both FunctionDef "SetVariable" and ParamDef "u").
   * Consumers should query the appropriate map for their use case. */
  elementsByType: {
    FunctionDef: Record<string, FunctionDefJson>;
    ParamDef: Record<string, ParamDefJson>;
    FunctionCall: Record<string, FunctionCallJson>;
    Param: Record<string, ParamJson>;
    Variable: Record<string, VariableJson>;
    Trigger: Record<string, TriggerJson>;
    Preset: Record<string, PresetJson>;
    PresetValue: Record<string, PresetValueJson>;
    Category: Record<string, CategoryJson>;
    Label: Record<string, LabelJson>;
    Structure: Record<string, StructureJson>;
    SubFuncType?: Record<string, SubFuncTypeJson>;
    Comment?: Record<string, CategoryRefJson>;
    CustomScript?: Record<string, CustomScriptJson>;
  };
}

export type ElementJson =
  | CategoryJson
  | TriggerJson
  | FunctionDefJson
  | FunctionCallJson
  | VariableJson
  | ParamJson
  | ParamDefJson
  | PresetJson
  | PresetValueJson
  | StructureJson
  | CategoryRefJson
  | LabelJson
  | CustomScriptJson
  | SubFuncTypeJson;
export interface SubFuncTypeJson extends BaseElementJson {
  isEvent?: boolean;
  type: 'SubFuncType';
  isAction?: boolean;
  /** A constrained child definition declared by the editor. */
  functionDef?: ElementRefJson;
}

export interface BaseElementJson {
  id: string;
  type: ElementType;
  library?: string;
  name?: string;
  /** XML element flags such as Internal/Hidden/Restricted. FunctionDef also
   *  consumes these flags for code generation, but the editor may attach them
   *  to variables and other declarations as well. */
  flags?: string[];
  /** Authored code identifier, independent of localized display text. */
  identifier?: string;
  displayName?: string;
  grammar?: string;
  grammarSource?: 'xml' | 'strings';
  disabled?: boolean;
  /** Catalog refs найденные в этом элементе */
  catalogRefs?: CatalogRef[];
}

export type ElementType =
  | 'Category'
  | 'Trigger'
  | 'FunctionDef'
  | 'FunctionCall'
  | 'Variable'
  | 'Param'
  | 'ParamDef'
  | 'Preset'
  | 'PresetValue'
  | 'Structure'
  | 'Label'
  | 'SubFuncType'
  | 'CustomScript'
  | 'Comment';

export interface CategoryJson extends BaseElementJson {
  type: 'Category';
  items: ElementRefJson[];
}

export interface TriggerJson extends BaseElementJson {
  type: 'Trigger';
  /** The editor's "Initially Off": the trigger is created but not enabled. */
  initOff?: boolean;
  events: ElementRefJson[];
  conditions: ElementRefJson[];
  actions: ElementRefJson[];
  localVariables: ElementRefJson[];
}

export interface FunctionDefJson extends BaseElementJson {
  type: 'FunctionDef';
  scriptCode?: string;
  parameters: ElementRefJson[];
  returnType?: ParameterTypeJson;
  flags?: string[];
  isSubFunction?: boolean;
  isFuncAction?: boolean;
  isFuncCall?: boolean;
  /** SubFunctionType declarations from NativeLib — lists all sub-block roles this function accepts */
  subFunctionTypes?: Array<{ library: string; id: string; type?: string }>;
  /** Body action FunctionCall refs (user-defined function bodies from SC2 Editor XML) */
  actions?: ElementRefJson[];
  /** Local variable refs declared in the user function body */
  localVariables?: ElementRefJson[];
}

export interface FunctionCallJson extends BaseElementJson {
  type: 'FunctionCall';
  functionDef?: ElementRefJson;
  /** Параметры вызова — ссылки на Param элементы */
  parameters?: ElementRefJson[];
  /** Inline sub-function blocks (for IfThenElse, WhileDo, PickEachInteger, etc.) */
  subFunctions?: ElementRefJson[];
  /** SubFunctionType identifies the role of this sub-block (e.g. "If", "Then", "Else", "Actions") */
  subFunctionType?: { library: string; id: string; type?: string };
  /** Raw Galaxy code for customscriptaction (FlagCustomScript) calls */
  scriptCode?: string;
}

export interface VariableJson extends BaseElementJson {
  type: 'Variable';
  variableType?: ParameterTypeJson;
  initialValue?: ElementRefJson;
  isArray?: boolean;
  isConstant?: boolean;
  arraySizes?: VariableArraySizeJson[];
}

export interface VariableArraySizeJson {
  dim: number;
  value?: string;
  variable?: ElementRefJson;
}

export interface ParamJson extends BaseElementJson {
  type: 'Param';
  /** Authored Galaxy expression, distinct from a literal Value. */
  scriptCode?: string;
  customType?: string;
  parameterDef?: ElementRefJson;
  value?: string;
  /** Localized Param/Value text when that exact TriggerStrings key exists. */
  localizedValue?: string;
  valueType?: ParameterTypeJson;
  /** Additional literal components, preserved verbatim from editor XML. */
  valueId?: string;
  valueTypeInfo?: string;
  /** Editor expression template type and text. Placeholders such as `~A~`
   * are bound to the referenced expressionParams by each child's
   * expressionCode. These fields are distinct from ScriptCode: they are the
   * editor's structured expression representation and must survive XML
   * round-trips. */
  expressionType?: string;
  expressionText?: string;
  expressionParams?: ElementRefJson[];
  expressionCode?: string;
  /** Dynamic components of an editor value template. For example,
   * `InfoArray[0].Unit[1]` binds component 0 and 1 through ValueParam refs. */
  valueParams?: ElementRefJson[];
  functionCall?: ElementRefJson;
  preset?: ElementRefJson;
  valueElement?: ElementRefJson;
  /** Selected values of a PresetAsBits parameter, in editor XML order. */
  valuePresets?: ElementRefJson[];
  /** Array index or indices. Single-element array = 1D access; two elements = 2D access. */
  array?: ElementRefJson | ElementRefJson[];
  variable?: ElementRefJson;
  structMember?: ElementRefJson;
  /** References the enclosing FunctionDef's own ParamDef — encodes "use function parameter lp_xxx" */
  paramRef?: ElementRefJson;
}

export interface ParamDefJson extends BaseElementJson {
  type: 'ParamDef';
  paramType: ParameterTypeJson;
  default?: ElementRefJson;
  isReference?: boolean;
  /** ParamFlagMultiple: one formal consumes each matching Param in XML order. */
  isMultiple?: boolean;
  /** ParamFlagPreload: the value is consumed by the editor's preload pass and
   * does not necessarily have a runtime Galaxy call. */
  isPreload?: boolean;
  /** A scalar-typed parameter may still offer a Preset of named choices; the
   *  editor stores the choice rather than the raw number it stands for. */
  preset?: ElementRefJson;
}

export interface PresetJson extends BaseElementJson {
  type: 'Preset';
  baseType?: string;
  generateConstants?: boolean;
  generateIdentifier?: boolean;
  integer?: boolean;
  asBits?: boolean;
  /** PresetExtends: the preset (often of another library) whose value space this one extends. */
  extends?: ElementRefJson;
  values: ElementRefJson[];
}

export interface PresetValueJson extends BaseElementJson {
  type: 'PresetValue';
  value?: string;
  /** The editor's wildcard/default choice (for example "Any ..."). */
  definesDefault?: boolean;
}

export interface StructureJson extends BaseElementJson {
  type: 'Structure';
  variables: ElementRefJson[];
}

export interface LabelJson extends BaseElementJson {
  type: 'Label';
}

export interface CategoryRefJson extends BaseElementJson {
  type: 'Comment';
  comment?: string;
  subFunctionType?: { library: string; id: string; type?: string };
}

export interface CustomScriptJson extends BaseElementJson {
  type: 'CustomScript';
  scriptCode?: string;
  initFunc?: string;
}

export interface ElementRefJson {
  id: string;
  library?: string;
  type?: string;
}

export interface ParameterTypeJson {
  type: string;
  /** Runtime constraint of an abstract editor operand (VariableType). */
  variableType?: string;
  gameType?: string;
  typeElement?: ElementRefJson;
}

/** Ссылка на запись в каталоге SC2 */
export interface CatalogRef {
  /** Каталог: Unit, Abil, Actor, Upgrade, Behavior, Effect, Weapon и т.д. */
  catalog: string;
  /** ID записи в каталоге */
  entry: string;
  /** Путь внутри элемента, где найдена ссылка */
  path: string;
}

/** Результат анализа библиотеки */
export interface TriggerAnalysisResult {
  library: TriggerLibraryJson;
  /** Все catalog refs по элементам */
  refsByElement: Map<string, CatalogRef[]>;
  /** Все уникальные catalog refs */
  allRefs: CatalogRef[];
}
