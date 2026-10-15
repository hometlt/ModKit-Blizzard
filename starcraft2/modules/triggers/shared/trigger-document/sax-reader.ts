/**
 * sax-reader — Direct XML → TriggerLibraryJson parser using SAX streaming.
 *
 * Replaces the xml2js + plaxtony 3-step pipeline with a single SAX pass.
 * Memory usage is proportional to the output (TriggerLibraryJson) only —
 * no intermediate xml2js object tree, no plaxtony Library/Element objects.
 */

import sax from 'sax';
import type {
  TriggerLibraryJson,
  TriggerAnalysisResult,
  ElementJson,
  ElementRefJson,
  ParameterTypeJson,
  CatalogRef,
  FunctionDefJson,
  FunctionCallJson,
  ParamJson,
  ParamDefJson,
  VariableJson,
  VariableArraySizeJson,
  TriggerJson,
  PresetJson,
  PresetValueJson,
  StructureJson,
  CategoryJson,
  LabelJson,
} from './types.js';
import { parseTriggerStrings, applyTriggerStringsByType } from './trigger-strings.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Attrs = Record<string, string> & {
  Id: string;
  id: string;
  Library: string;
  library: string;
  Type: string;
  type: string;
  Value: string;
  value: string;
  Dim: string;
  dim: string;
};

function mkRef(a: Attrs): ElementRefJson {
  return { id: a.Id ?? a.id, library: a.Library ?? a.library ?? undefined, type: a.Type ?? a.type ?? undefined };
}

function extractScriptCodeCatalogRefs(code: string, path: string): CatalogRef[] {
  const refs: CatalogRef[] = [];
  const patterns: Array<{ re: RegExp; catalog: string }> = [
    { re: /(?:CreateUnit|UnitCreate|UnitTypeFromName|UnitTypeFromString)\s*\([^)]*"([^"]+)"/g, catalog: 'Unit' },
    { re: /(?:TechTreeAbilityAdd|TechTreeAbilityRemove|AbilityCommand|AbilCreate)\s*\([^)]*"([^"]+)"/g, catalog: 'Abil' },
    { re: /(?:ActorCreate|ActorFromName|ActorTypeFromName)\s*\([^)]*"([^"]+)"/g, catalog: 'Actor' },
    { re: /(?:TechTreeUpgradeAdd|UpgradeCreate)\s*\([^)]*"([^"]+)"/g, catalog: 'Upgrade' },
    { re: /(?:BehaviorAdd|BehaviorRemove)\s*\([^)]*"([^"]+)"/g, catalog: 'Behavior' },
    { re: /(?:EffectCreate|EffectTypeFromName)\s*\([^)]*"([^"]+)"/g, catalog: 'Effect' },
    { re: /(?:WeaponCreate|WeaponTypeFromName)\s*\([^)]*"([^"]+)"/g, catalog: 'Weapon' },
  ];
  for (const { re, catalog } of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) refs.push({ catalog, entry: m[1], path });
  }
  return refs;
}

function makeElementsByType() {
  return {
    FunctionDef: {} as Record<string, FunctionDefJson>,
    ParamDef: {} as Record<string, ParamDefJson>,
    FunctionCall: {} as Record<string, FunctionCallJson>,
    Param: {} as Record<string, ParamJson>,
    Variable: {} as Record<string, VariableJson>,
    Trigger: {} as Record<string, TriggerJson>,
    Preset: {} as Record<string, PresetJson>,
    PresetValue: {} as Record<string, PresetValueJson>,
    Category: {} as Record<string, CategoryJson>,
    Label: {} as Record<string, LabelJson>,
    Structure: {} as Record<string, StructureJson>,
    SubFuncType: {} as Record<string, import('./types.js').SubFuncTypeJson>,
    Comment: {} as Record<string, import('./types.js').CategoryRefJson>,
    CustomScript: {} as Record<string, import('./types.js').CustomScriptJson>,
  };
}

/**
 * The code held by an editor ScriptCode block (see `scriptCodeTag` in trigger-xml.js):
 * the lines between the tag lines without the closing tag's indentation plus four
 * spaces. Text that is not exactly such a block is returned unchanged.
 */
export function scriptCodeFromBlock(raw: string): string {
  const lines = raw.replace(/\r\n?/gu, '\n').split('\n');
  const indent = `${lines[lines.length - 1]}    `;
  const body = lines.slice(1, -1);
  if (lines.length < 3 || lines[0].trim() !== '' || indent.trim() !== '' ||
      !body.every(line => line.startsWith(indent) || line.trim() === '')) return raw;
  return body.map(line => line.startsWith(indent) ? line.slice(indent.length) : '').join('\n');
}

// Normalize NativeLib's <Standard Id="Ntve"/> → <Library Id="Ntve">...</Library>
function normalizeXml(xml: string): string {
  if (!xml.includes('<Standard Id=')) return xml;
  return xml
    .replace(/<Standard Id="([^"]+)"\s*\/>/, '<Library Id="$1">')
    .replace(/<\/TriggerData>/, '</Library></TriggerData>');
}

// ---------------------------------------------------------------------------
// In-progress element state
// ---------------------------------------------------------------------------

interface BuildingParamType {
  variableType?: string;
  type?: string;
  gameType?: string;
  typeElement?: ElementRefJson;
}

interface BuildEl {
  type: string;
  id: string;
  library?: string;
  name?: string;
  grammar?: string;

  initOff?: boolean;

  // FunctionDef flags
  flags: string[];

  // Ref arrays — what they hold depends on element type
  parameters: ElementRefJson[];    // FunctionDef params / FunctionCall params
  subFunctions: ElementRefJson[];  // FunctionCall sub-blocks
  subFunctionTypes: Array<{ library: string; id: string; type?: string }>;
  actions: ElementRefJson[];       // FunctionDef body / Trigger actions
  localVariables: ElementRefJson[];
  events: ElementRefJson[];
  conditions: ElementRefJson[];
  structVars: ElementRefJson[];    // Structure member variables
  values: ElementRefJson[];        // Preset values
  valuePresets: ElementRefJson[];  // Param selections for PresetAsBits
  expressionParams: ElementRefJson[]; // Param substitutions used by ExpressionText
  valueParams: ElementRefJson[];   // Dynamic slots used by typed Value templates
  items: ElementRefJson[];         // Category items
  arrayRefs: ElementRefJson[];     // Param array index refs

  // Single refs
  functionDef?: ElementRefJson;
  parameterDef?: ElementRefJson;
  functionCall?: ElementRefJson;
  preset?: ElementRefJson;
  valueElement?: ElementRefJson;
  variable?: ElementRefJson;
  structMember?: ElementRefJson;
  paramRef?: ElementRefJson;
  initialValue?: ElementRefJson;
  defaultRef?: ElementRefJson;
  subFunctionType?: { library: string; id: string };

  // Scalars
  scriptCode?: string;
  comment?: string;
  initFunc?: string;
  paramValue?: string;
  paramValueId?: string;
  paramValueTypeInfo?: string;
  paramValueType?: string;
  paramCustomType?: string;
  paramValueGameType?: string;
  expressionType?: string;
  expressionText?: string;
  expressionCode?: string;
  presetValue?: string;
  definesDefault?: boolean;
  baseType?: string;
  generateConstants?: boolean;
  generateIdentifier?: boolean;
  integer?: boolean;
  asBits?: boolean;
  presetExtends?: ElementRefJson;
  isArray: boolean;
  isConstant: boolean;
  isReference: boolean;
  isMultiple: boolean;
  isPreload: boolean;
  disabled: boolean;

  // ParameterType containers
  returnType?: BuildingParamType;
  variableType?: BuildingParamType;
  paramType?: BuildingParamType;   // ParamDef

  // Variable array sizes
  arraySizes: VariableArraySizeJson[];
}

function freshEl(type: string, id: string, lib?: string): BuildEl {
  return {
    type, id, library: lib,
    flags: [], parameters: [], subFunctions: [], subFunctionTypes: [],
    actions: [], localVariables: [], events: [], conditions: [],
    structVars: [], values: [], valuePresets: [], expressionParams: [], valueParams: [], items: [], arrayRefs: [],
    isArray: false, isConstant: false, isReference: false, isMultiple: false, isPreload: false, disabled: false, arraySizes: [],
  };
}

// ---------------------------------------------------------------------------
// Finalize BuildEl → typed ElementJson
// ---------------------------------------------------------------------------

function finalize(b: BuildEl): ElementJson | undefined {
  // SubFuncType's <Action/> and <Event/> are typed properties, not the
  // FunctionDef FlagAction/FlagEvent tags. Keeping both would serialize two
  // different tags and duplicate the role on the next parse.
  const retainedFlags = b.type === 'SubFuncType'
    ? b.flags.filter(flag => flag !== 'Action' && flag !== 'Event')
    : b.flags;
  const base = { id: b.id, type: b.type as any, library: b.library, name: b.name, identifier: b.name, grammar: b.grammar, grammarSource: b.grammar === undefined ? undefined : 'xml' as const, disabled: b.disabled || undefined, flags: retainedFlags.length ? retainedFlags : undefined };

  const finPT = (pt: BuildingParamType | undefined): ParameterTypeJson | undefined =>
    pt?.type ? { type: pt.type, gameType: pt.gameType, typeElement: pt.typeElement, ...(pt.variableType ? { variableType: pt.variableType } : {}) } : undefined;

  switch (b.type) {
    case 'FunctionDef': {
      const flags = b.flags.length ? b.flags : undefined;
      const json: FunctionDefJson = {
        ...base, type: 'FunctionDef',
        scriptCode: b.scriptCode,
        parameters: b.parameters,
        returnType: finPT(b.returnType),
        flags,
        isSubFunction: b.flags.includes('SubFunctions'),
        isFuncAction: b.flags.includes('Action'),
        isFuncCall: b.flags.includes('Call'),
        subFunctionTypes: b.subFunctionTypes.length ? b.subFunctionTypes : undefined,
          actions: b.actions.length || !b.scriptCode && (b.flags.includes('Action') || b.flags.includes('Call')) && !b.flags.includes('Native') && !b.flags.includes('CustomScript') ? b.actions : undefined,
        localVariables: b.localVariables.length ? b.localVariables : undefined,
      };
      if (b.scriptCode) {
        const refs = extractScriptCodeCatalogRefs(b.scriptCode, 'scriptCode');
        if (refs.length) (json as any).catalogRefs = refs;
      }
      return json;
    }

    case 'SubFuncType':
      return { ...base, type: 'SubFuncType', isAction: b.flags.includes('Action') || undefined, isEvent: b.flags.includes('Event') || undefined, functionDef: b.functionDef };

    case 'FunctionCall':
      return {
        ...base, type: 'FunctionCall',
        functionDef: b.functionDef,
        parameters: b.parameters.length ? b.parameters : undefined,
        subFunctions: b.subFunctions.length ? b.subFunctions : undefined,
        subFunctionType: b.subFunctionType,
        scriptCode: b.scriptCode,
      } as FunctionCallJson;

    case 'Param': {
      const json: ParamJson = {
        ...base, type: 'Param',
        scriptCode: b.scriptCode,
        customType: b.paramCustomType,
        parameterDef: b.parameterDef,
        value: b.paramValue,
        valueId: b.paramValueId,
        valueTypeInfo: b.paramValueTypeInfo,
        expressionType: b.expressionType,
        expressionText: b.expressionText,
        expressionParams: b.expressionParams.length ? b.expressionParams : undefined,
        expressionCode: b.expressionCode,
        valueParams: b.valueParams.length ? b.valueParams : undefined,
        valueType: b.paramValueType ? { type: b.paramValueType, ...(b.paramValueGameType ? { gameType: b.paramValueGameType } : {}) } : undefined,
        functionCall: b.functionCall,
        preset: b.preset,
        valueElement: b.valueElement,
        valuePresets: b.valuePresets.length ? b.valuePresets : undefined,
        variable: b.variable,
        structMember: b.structMember,
        paramRef: b.paramRef,
        array: b.arrayRefs.length === 0 ? undefined
          : b.arrayRefs.length === 1 ? b.arrayRefs[0]
          : b.arrayRefs,
      };
      if (b.paramValueType && b.paramValue) {
        const vt = b.paramValueType.toLowerCase();
        if (vt === 'gamelink' || vt === 'anygamelink') {
          (json as any).catalogRefs = [{ catalog: b.paramValueGameType ?? 'unknown', entry: b.paramValue, path: '' }];
        }
      }
      return json;
    }

    case 'ParamDef':
      return {
        ...base, type: 'ParamDef',
        paramType: finPT(b.paramType) ?? { type: 'unknown' },
        default: b.defaultRef,
        isReference: b.isReference || undefined,
        isMultiple: b.isMultiple || undefined,
        isPreload: b.isPreload || undefined,
        preset: b.preset,
      } as ParamDefJson;

    case 'Preset':
      return { ...base, type: 'Preset', baseType: b.baseType, values: b.values, generateConstants: b.generateConstants,
        generateIdentifier: b.generateIdentifier, integer: b.integer, asBits: b.asBits,
        ...(b.presetExtends ? { extends: b.presetExtends } : {}) } as PresetJson;

    case 'PresetValue':
      return { ...base, type: 'PresetValue', value: b.presetValue,
        definesDefault: b.definesDefault || undefined } as PresetValueJson;

    case 'Variable':
      return {
        ...base, type: 'Variable',
        variableType: finPT(b.variableType),
        initialValue: b.initialValue,
        isArray: b.isArray || undefined,
        isConstant: b.isConstant || undefined,
        arraySizes: b.arraySizes.length ? b.arraySizes : undefined,
      } as VariableJson;

    case 'Trigger':
      return {
        ...base, type: 'Trigger',
        initOff: b.initOff || undefined,
        events: b.events, conditions: b.conditions,
        actions: b.actions, localVariables: b.localVariables,
      } as TriggerJson;

    case 'Structure':
      return { ...base, type: 'Structure', variables: b.structVars } as StructureJson;

    case 'Category':
      return { ...base, type: 'Category', items: b.items } as CategoryJson;

    case 'Label':
      return { ...base, type: 'Label' } as LabelJson;

    case 'Comment':
      return { ...base, type: 'Comment', comment: b.comment, subFunctionType: b.subFunctionType };

    case 'CustomScript':
      return { ...base, type: 'CustomScript', scriptCode: b.scriptCode, initFunc: b.initFunc };

    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Core SAX parse
// ---------------------------------------------------------------------------

export function parseTriggerXmlSync(xmlContent: string): Map<string, TriggerLibraryJson> {
  const xml = normalizeXml(xmlContent);
  const parser = sax.parser(true, { trim: false, normalize: false });

  // Per-library accumulators
  const libraryMap = new Map<string, TriggerLibraryJson>();
  let libId: string | null = null;
  let libElements: Record<string, ElementJson> = {};
  let libElementsByType = makeElementsByType();
  let libRootRefs: ElementRefJson[] = [];

  // Element-level state
  let el: BuildEl | null = null;

  // Relative depth tracking
  let depth = 0;
  let libDepth = -1;      // depth when Library opened
  let elDepth = -1;       // depth when Element opened
  let rootDepth = -1;     // depth when Root opened
  let libHasRoot = false; // whether this library declared a Root section at all

  // Child context (direct child of Element, relDepth=1)
  let childTag: string | null = null;
  let childIsRef = false;  // true when child opentag had an Id attribute

  // Grandchild context (relDepth=2, inside ParameterType containers)
  let inPTContainer = false;   // inside ReturnType / VariableType / ParameterType

  // Text accumulation
  let textBuf = '';

  // ── Helpers ───────────────────────────────────────────────────────────────

  function activePT(): BuildingParamType {
    if (!el) return {};
    if (childTag === 'ReturnType') return el.returnType ?? (el.returnType = {});
    if (childTag === 'VariableType') return el.variableType ?? (el.variableType = {});
    return el.paramType ?? (el.paramType = {});
  }

  function emitLibrary() {
    if (!libId) return;
    const items: ElementJson[] = [];
    for (const ref of libRootRefs) {
      if (!ref.type) continue;
      const typeMap = (libElementsByType as any)[ref.type] as Record<string, ElementJson> | undefined;
      const found = typeMap?.[ref.id];
      if (found) items.push(found);
    }
    // `items` only holds roots this document defines. Keep the references as
    // written, and whether the section existed at all, so a layered resolver
    // can tell an empty Root from an absent one and can see a root whose
    // element lives in another document.
    libraryMap.set(libId, {
      id: libId, items, elements: libElements, elementsByType: libElementsByType as any,
      rootRefs: libRootRefs.slice(), hasRoot: libHasRoot,
    });
  }

  function startLibrary(id: string) {
    if (libId) emitLibrary();
    libId = id;
    libElements = {};
    libElementsByType = makeElementsByType();
    libRootRefs = [];
    libHasRoot = false;
  }

  function registerEl(json: ElementJson) {
    const key = `${json.type}:${json.id}`;
    if (!libElements[key]) libElements[key] = json;
    const tmap = (libElementsByType as any)[json.type] as Record<string, ElementJson> | undefined;
    if (tmap && !tmap[json.id]) tmap[json.id] = json;
  }

  // ── SAX handlers ─────────────────────────────────────────────────────────

  parser.onopentag = (node) => {
    depth++;
    const name = (node as any).name as string;
    const attrs = (node as any).attributes as Attrs;
    textBuf = '';

    // Library boundary (depth 2 in normalised XML)
    if (name === 'Library' && (libDepth < 0 ? depth === 2 : depth === libDepth)) {
      startLibrary(attrs.Id ?? attrs.id);
      libDepth = depth;
      return;
    }

    if (!libId) return;

    // Root section
    if (name === 'Root' && depth === libDepth + 1) { rootDepth = depth; libHasRoot = true; return; }
    if (rootDepth >= 0 && name === 'Item' && depth === rootDepth + 1) {
      libRootRefs.push(mkRef(attrs)); return;
    }

    // Element opening
    if (name === 'Element' && depth === libDepth + 1) {
      el = freshEl(attrs.Type ?? attrs.type, attrs.Id ?? attrs.id, libId);
      elDepth = depth;
      childTag = null; childIsRef = false; inPTContainer = false;
      return;
    }

    if (!el) return;
    const rel = depth - elDepth;

    // ── Direct children of Element (rel === 1) ────────────────────────────
    if (rel === 1) {
      childTag = name;
      childIsRef = !!(attrs.Id ?? attrs.id);
      inPTContainer = (name === 'ReturnType' || name === 'VariableType' || name === 'ParameterType');

      // Flag tags (all self-closing)
      const FLAG: Record<string, string> = {
        FlagNative: 'Native', FlagAction: 'Action', FlagCall: 'Call',
        FlagEvent: 'Event', Template: 'Template', FlagCustomScript: 'CustomScript',
        FlagOperator: 'Operator', FlagInline: 'Inline', FlagCustomAI: 'CustomAI', FlagSubFunctions: 'SubFunctions',
        FlagAllowBreak: 'AllowBreak', FlagHidden: 'Hidden', FlagNoScriptPrefix: 'NoScriptPrefix',
        Deprecated: 'Deprecated', Internal: 'Internal', FlagRestricted: 'Restricted',
        FlagCreateThread: 'CreateThread',
      };
      if (FLAG[name]) { el.flags.push(FLAG[name]); return; }
      if (name === 'Disabled') { el.disabled = true; return; }
      if (name === 'InitOff') { el.initOff = true; return; }
      if (el.type === 'SubFuncType' && name === 'Action') { el.flags.push('Action'); return; }
      if (el.type === 'SubFuncType' && name === 'Event') { el.flags.push('Event'); return; }
      if (el.type === 'Preset' && name === 'PresetGenConstVar') { el.generateConstants = true; return; }
      if (el.type === 'Preset' && name === 'PresetGenIdentFunc') { el.generateIdentifier = true; return; }
      if (el.type === 'Preset' && name === 'PresetInteger') { el.integer = true; return; }
      if (el.type === 'Preset' && name === 'PresetAsBits') { el.asBits = true; return; }
      if (el.type === 'PresetValue' && name === 'DefinesDefault') { el.definesDefault = true; return; }
      if (name === 'ParamFlagReference') { el.isReference = true; return; }
      if (name === 'ParamFlagMultiple') { el.isMultiple = true; return; }
      if (name === 'ParamFlagPreload') { el.isPreload = true; return; }
      if (name === 'Const') { el.isConstant = true; return; }

      // Array tag — self-closing flag OR index refs (context-dependent)
      if (name === 'Array') {
        if (childIsRef) el.arrayRefs.push(mkRef(attrs)); // Param index ref
        else el.isArray = true;                           // Variable isArray flag
        return;
      }

      // BaseType — self-closing with Value attr
      if (name === 'BaseType') {
        if (attrs.Value ?? attrs.value) el.baseType = attrs.Value ?? attrs.value;
        return;
      }

      // ValueType / ValueGameType — self-closing
      if (name === 'ValueType') { if (attrs.Type ?? attrs.type) el.paramValueType = attrs.Type ?? attrs.type; return; }
      if (name === 'ExpressionType') { if (attrs.Type ?? attrs.type) el.expressionType = attrs.Type ?? attrs.type; return; }
      if (name === 'ExpressionCode') { el.expressionCode = attrs.Value ?? attrs.value; return; }
      if (name === 'ValueId') { el.paramValueId = attrs.Id ?? attrs.id; return; }
      if (name === 'ValueTypeInfo') { el.paramValueTypeInfo = attrs.Value ?? attrs.value; return; }
      if (name === 'CustomType') { el.paramCustomType = attrs.Type ?? attrs.type; return; }
      if (name === 'ValueGameType') { if (attrs.Type ?? attrs.type) el.paramValueGameType = attrs.Type ?? attrs.type; return; }

      // Ref-holding tags
      if (!childIsRef) return; // remaining rel=1 tags are either refs or text — text handled at closetag

      switch (name) {
        case 'FunctionDef':   el.functionDef = mkRef(attrs); break;
        case 'ParameterDef':  el.parameterDef = mkRef(attrs); break;
        case 'Preset':        el.preset = mkRef(attrs); break;
        case 'PresetExtends': el.presetExtends = mkRef(attrs); break;
        case 'ValueElement':  el.valueElement = mkRef(attrs); break;
        case 'ValuePreset':   el.valuePresets.push(mkRef(attrs)); break;
        case 'ExpressionParam': el.expressionParams.push(mkRef(attrs)); break;
        case 'ValueParam':    el.valueParams.push(mkRef(attrs)); break;
        case 'StructMember':  el.structMember = mkRef(attrs); break;
        case 'Default':       el.defaultRef = mkRef(attrs); break;
        case 'Event':         el.events.push(mkRef(attrs)); break;
        case 'Condition':     el.conditions.push(mkRef(attrs)); break;

        case 'Variable': {
          const vt = attrs.Type ?? attrs.type;
          if (el.type === 'Trigger' && vt === 'Variable') el.localVariables.push(mkRef(attrs));
          else if (el.type === 'Structure' && vt === 'Variable') el.structVars.push(mkRef(attrs));
          else if (el.type === 'FunctionDef') el.localVariables.push(mkRef(attrs));
          else el.variable = mkRef(attrs); // Param
          break;
        }

        case 'FunctionCall':
          if (el.type === 'FunctionDef') el.actions.push(mkRef(attrs));
          else if (el.type === 'FunctionCall') el.subFunctions.push(mkRef(attrs));
          else el.functionCall = mkRef(attrs); // Param
          break;

        case 'Action': el.actions.push(mkRef(attrs)); break;

        case 'Parameter': {
          const t = attrs.Type ?? attrs.type;
          if (t === 'Comment') break;
          if (t === 'ParamDef' && el.type === 'Param') el.paramRef = mkRef(attrs);
          else el.parameters.push(mkRef(attrs));
          break;
        }

        case 'SubFunctionType': {
          // The tag itself names the element type; the editor writes it on
          // every such reference and a reader that keeps the omission would
          // make two spellings of one reference.
          const sfRef = { library: attrs.Library ?? attrs.library ?? '', id: attrs.Id ?? attrs.id ?? '',
            type: attrs.Type ?? attrs.type ?? 'SubFuncType' };
          if (el.type === 'FunctionDef') el.subFunctionTypes.push(sfRef);
          else el.subFunctionType = sfRef;
          break;
        }

        case 'Item': {
          const t = attrs.Type ?? attrs.type;
          if (t === 'PresetValue') el.values.push(mkRef(attrs));
          else el.items.push(mkRef(attrs));
          break;
        }

        case 'Value':
          // Variable initialValue: <Value Type="Param" Id="..."/>
          if (el.type === 'Variable') el.initialValue = mkRef(attrs);
          break;

        case 'InitialValue':
          el.initialValue = mkRef(attrs);
          break;
      }
      return;
    }

    // ── Inside ParameterType containers (rel === 2) ───────────────────────
    if (rel === 2 && inPTContainer) {
      const pt = activePT();
      switch (name) {
        case 'Type':        pt.type = attrs.Value ?? attrs.value; break;
        case 'GameType':    pt.gameType = attrs.Value ?? attrs.value; break;
        case 'VariableType': pt.variableType = attrs.Value ?? attrs.value; break;
        case 'TypeElement': pt.typeElement = mkRef(attrs); break;
        case 'Constant':    el!.isConstant = true; break;
        case 'ArraySize': {
          el!.isArray = true;
          const dim = Number(attrs.Dim ?? attrs.dim ?? 0);
          const val = attrs.Value ?? attrs.value ?? undefined;
          const varRef = ((attrs.Type === 'Variable' || attrs.type === 'Variable') && (attrs.Id ?? attrs.id))
            ? mkRef(attrs) : undefined;
          el!.arraySizes.push({ dim, value: val, variable: varRef });
          break;
        }
      }
    }
  };

  parser.onclosetag = (tagName) => {
    const rel = depth - elDepth;

    if (el && rel === 1 && childTag === tagName) {
      // Collect text-content children
      const text = textBuf; textBuf = '';
      switch (tagName) {
        case 'Identifier': el.name = text || undefined; break;
        case 'Grammar': el.grammar = text; break;
        case 'ScriptCode':  el.scriptCode = scriptCodeFromBlock(text) || undefined; break;
        case 'ExpressionText': el.expressionText = text; break;
        case 'Comment': el.comment = text; break;
        case 'InitFunc': el.initFunc = text.trim() || undefined; break;
        case 'Value':
          if (!childIsRef) {
            if (el.type === 'PresetValue') el.presetValue = text;
            else el.paramValue = text;
          }
          break;
      }
      childTag = null; childIsRef = false; inPTContainer = false;
    }

    // Element close
    if (el && rel === 0 && tagName === 'Element') {
      const json = finalize(el);
      if (json) registerEl(json);
      el = null; elDepth = -1;
    }

    if (tagName === 'Root' && depth === rootDepth) rootDepth = -1;

    if (libId && tagName === 'Library' && depth === libDepth) {
      emitLibrary(); libId = null; libDepth = -1;
    }

    depth--;
  };

  parser.ontext = (text) => { if (el) textBuf += text; };
  parser.oncdata = (text) => { if (el) textBuf += text; };

  parser.write(xml).close();
  if (libId) emitLibrary(); // flush last library if not explicitly closed

  return libraryMap;
}

// ---------------------------------------------------------------------------
// Post-processing: catalog refs + TriggerStrings
// ---------------------------------------------------------------------------

function buildResult(library: TriggerLibraryJson): TriggerAnalysisResult {
  const refsByElement = new Map<string, CatalogRef[]>();
  const allRefs: CatalogRef[] = [];
  for (const el of Object.values(library.elements)) {
    const refs = (el as any).catalogRefs as CatalogRef[] | undefined;
    if (refs?.length) { refsByElement.set(el.id, refs); allRefs.push(...refs); }
  }
  return { library, refsByElement, allRefs };
}

function applyStrings(result: TriggerAnalysisResult, triggerStrings: string): void {
  const libId = result.library.id;
  result.library.triggerStringsLoaded = true;
  const strings = parseTriggerStrings(triggerStrings);
  result.library.paramValuesLoaded = [...strings.keys()].some(key => key.startsWith('ParamValue:'));
  applyTriggerStringsByType(libId, result.library.elementsByType, strings);
  const libName = strings.get(`Library:${libId}`) ?? strings.get(`Library/Name/${libId}`);
  if (libName) result.library.name = libName;
  const sfNames: Record<string, string> = {};
  for (const [key, name] of strings) {
    if (key.startsWith('SubFuncType:')) sfNames[key.slice('SubFuncType:'.length)] = name;
  }
  if (Object.keys(sfNames).length > 0) result.library.subFuncTypeNames = sfNames;
}

// ---------------------------------------------------------------------------
// Public API — drop-in replacements for reader.ts
// ---------------------------------------------------------------------------

export async function readTriggerLibraryFast(
  xmlContent: string,
  triggerStringsContent?: string,
): Promise<TriggerAnalysisResult> {
  const libs = parseTriggerXmlSync(xmlContent);
  if (libs.size === 0) throw new Error('No libraries found in trigger XML');
  const [, library] = libs.entries().next().value!;
  const result = buildResult(library);
  if (triggerStringsContent !== undefined) applyStrings(result, triggerStringsContent);
  return result;
}

export async function readTriggerLibrariesFast(
  xmlContents: Array<string | Map<string, TriggerLibraryJson>>,
  triggerStringsMap?: Map<string, string>,
): Promise<Map<string, TriggerAnalysisResult>> {
  const results = new Map<string, TriggerAnalysisResult>();
  for (const xml of xmlContents) {
    for (const [libId, library] of typeof xml === 'string' ? parseTriggerXmlSync(xml) : xml) {
      const result = buildResult(library);
      if (triggerStringsMap?.has(libId)) applyStrings(result, triggerStringsMap.get(libId)!);
      results.set(libId, result);
    }
  }
  return results;
}
