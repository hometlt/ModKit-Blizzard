/**
 * @file reader.ts
 * @package @modkitx/triggers
 *
 * Converts a TriggerLib XML file (via sc2-galaxy-lang's XMLReader/TriggerStore) into
 * the portable {@link TriggerLibraryJson} representation used throughout modkitx.
 *
 * ## Entry points
 * - {@link readTriggerLibrary}  — async; reads the XML from disk and parses it.
 * - {@link parseTriggerLibrary} — sync; accepts an already-loaded XML string.
 *
 * ## What it does
 * 1. Parses the TriggerLib XML with sc2-galaxy-lang's XMLReader.
 * 2. Walks every element (FunctionDef, FunctionCall, Param, ParamDef, Variable,
 *    Trigger, Preset, PresetValue, Category, Label, Structure) and converts it to
 *    the corresponding *Json shape defined in `types.ts`.
 * 3. Loads TriggerStrings (the localised string tables that accompany the XML) and
 *    applies them — filling in `FunctionDefJson.name`, `TriggerJson.name`, etc.
 * 4. Builds `TriggerLibraryJson.subFuncTypeNames` from TriggerLib metadata so that
 *    the to-engine pipeline can identify sub-function roles (If/Then/Else/Actions …)
 *    without any hardcoded element IDs.
 *
 * ## Source of truth for names
 * All human-readable names come from TriggerStrings files, not from the XML element
 * IDs.  The reader populates `FunctionDefJson.name` (e.g. `"IfThenElse"`) which the
 * `to-engine` pipeline then uses for control-flow dispatch.
 */
import {
  XMLReader,
  TriggerStore,
  Library,
  Element,
  ElementReference,
  FunctionDef,
  FunctionCall,
  Param,
  ParamDef,
  Preset,
  PresetValue,
  Category,
  Label,
  Trigger,
  Variable,
  Structure,
  ParameterType,
} from './trigger-store.js';

import type {
  TriggerLibraryJson,
  ElementJson,
  ElementRefJson,
  ParameterTypeJson,
  CatalogRef,
  TriggerAnalysisResult,
  FunctionDefJson,
  FunctionCallJson,
  ParamJson,
  ParamDefJson,
  PresetJson,
  PresetValueJson,
  StructureJson,
  CategoryJson,
  TriggerJson,
  VariableJson,
  LabelJson,
} from './types.js';

import { parseTriggerStrings, applyTriggerStringsByType } from './trigger-strings.js';

function toRefJson(ref?: ElementReference<Element>): ElementRefJson | undefined {
  if (!ref) return undefined;
  return {
    id: ref.id,
    library: ref.library,
    type: ref.type?.name,
  };
}

function toParamTypeJson(pt?: ParameterType): ParameterTypeJson | undefined {
  if (!pt) return undefined;
  return {
    type: pt.type,
    gameType: pt.gameType,
    typeElement: toRefJson(pt.typeElement),
  };
}

function elementFlags(el: Element): string[] | undefined {
  const flags: string[] = [];
  // ElementFlag values are bitflags - check each
  const f = (el as any).flags as number;
  if (!f) return undefined;
  const map: Record<number, string> = {
    0x02: 'Native',
    0x04: 'Action',
    0x08: 'Call',
    0x10: 'Event',
    0x20: 'Template',
    0x40: 'PresetGenConstVar',
    0x80: 'PresetCustom',
    0x100: 'CustomScript',
    0x200: 'Operator',
    0x400: 'CustomAI',
    0x800: 'SubFunctions',
    0x1000: 'AllowBreak',
    0x2000: 'Hidden',
    0x4000: 'NoScriptPrefix',
    0x8000: 'Deprecated',
    0x10000: 'Internal',
    0x20000: 'Restricted',
  };
  for (const [bit, name] of Object.entries(map)) {
    if (f & Number(bit)) flags.push(name);
  }
  return flags.length ? flags : undefined;
}

/**
 * Извлекает catalog refs из элемента Param.
 */
function safeResolve<T extends Element>(ref?: ElementReference<T>): T | undefined {
  try {
    return ref?.resolve();
  } catch {
    return undefined;
  }
}

function extractParamRefs(param: Param, path: string): CatalogRef[] {
  const refs: CatalogRef[] = [];

  // gamelink: ValueType + ValueGameType + Value
  if (param.valueType && param.value) {
    const vt = param.valueType.toLowerCase();
    if (vt === 'gamelink' || vt === 'anygamelink') {
      const catalog = param.valueGameType || 'unknown';
      refs.push({
        catalog,
        entry: param.value,
        path,
      });
    }
  }

  // PresetValue может содержать catalog entry
  const presetVal = safeResolve(param.preset);
  if (presetVal?.value) {
    refs.push({
      catalog: 'preset',
      entry: presetVal.value,
      path: `${path}.preset`,
    });
  }

  // valueElement — ссылка на Preset (тип)
  const preset = safeResolve(param.valueElement);
  if (preset?.baseType) {
    refs.push({
      catalog: 'preset_type',
      entry: preset.baseType,
      path: `${path}.valueElement`,
    });
  }

  // Рекурсивно из FunctionCall
  const fc = safeResolve(param.functionCall);
  if (fc) {
    refs.push(...extractFunctionCallRefs(fc, `${path}.functionCall`));
  }

  return refs;
}

function extractFunctionCallRefs(fc: FunctionCall, path: string): CatalogRef[] {
  const refs: CatalogRef[] = [];
  // FunctionDef может иметь scriptCode с catalog refs
  const funcDef = safeResolve(fc.functionDef);
  if (funcDef?.scriptCode) {
    refs.push(...extractScriptCodeRefs(funcDef.scriptCode, `${path}.functionDef.scriptCode`));
  }
  return refs;
}

/**
 * Извлекает catalog refs из Galaxy scriptCode.
 * Простой regex-based подход — достаточно для большинства случаев.
 */
function extractScriptCodeRefs(code: string, path: string): CatalogRef[] {
  const refs: CatalogRef[] = [];
  // Примеры: UnitCreate(..., "Marine", ...), TechTreeAbilityAdd(..., "Stimpack", ...)
  // Catalog refs часто передаются как строковые литералы в определённых функциях
  const patterns = [
    // Unit/Abil/Actor/Upgrade/Behavior/Effect/Weapon creation/modification
    { re: /(?:CreateUnit|UnitCreate|UnitTypeFromName|UnitTypeFromString)\s*\([^)]*"([^"]+)"/g, catalog: 'Unit' },
    { re: /(?:TechTreeAbilityAdd|TechTreeAbilityRemove|AbilityCommand|AbilCreate)\s*\([^)]*"([^"]+)"/g, catalog: 'Abil' },
    { re: /(?:ActorCreate|ActorFromName|ActorTypeFromName)\s*\([^)]*"([^"]+)"/g, catalog: 'Actor' },
    { re: /(?:TechTreeUpgradeAdd|UpgradeCreate)\s*\([^)]*"([^"]+)"/g, catalog: 'Upgrade' },
    { re: /(?:BehaviorAdd|BehaviorRemove)\s*\([^)]*"([^"]+)"/g, catalog: 'Behavior' },
    { re: /(?:EffectCreate|EffectTypeFromName)\s*\([^)]*"([^"]+)"/g, catalog: 'Effect' },
    { re: /(?:WeaponCreate|WeaponTypeFromName)\s*\([^)]*"([^"]+)"/g, catalog: 'Weapon' },
  ];

  for (const { re, catalog } of patterns) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(code)) !== null) {
      refs.push({ catalog, entry: match[1], path });
    }
  }

  return refs;
}

function convertElement(el: Element): ElementJson | undefined {
  const base = {
    id: el.id,
    type: el.constructor.name as any,
    library: (el as any).libId,
    name: el.name,
  };

  if (el instanceof FunctionDef) {
    const flags = elementFlags(el);
    const json: FunctionDefJson = {
      ...base,
      type: 'FunctionDef',
      scriptCode: el.scriptCode,
      parameters: el.parameters.map(toRefJson).filter(Boolean) as ElementRefJson[],
      returnType: toParamTypeJson(el.returnType),
      flags,
      isSubFunction: flags?.includes('SubFunctions') ?? false,
      isFuncAction: flags?.includes('Action') ?? false,
      isFuncCall: flags?.includes('Call') ?? false,
      subFunctionTypes: (el.subFunctionTypes?.length ?? 0) > 0 ? el.subFunctionTypes : undefined,
      actions: (el.actions?.length ?? 0) > 0 ? el.actions.map(toRefJson).filter(Boolean) as ElementRefJson[] : undefined,
      localVariables: (el.localVariables?.length ?? 0) > 0 ? el.localVariables.map(toRefJson).filter(Boolean) as ElementRefJson[] : undefined,
    };
    return json;
  }

  if (el instanceof FunctionCall) {
    const json: FunctionCallJson = {
      ...base,
      type: 'FunctionCall',
      functionDef: toRefJson(el.functionDef),
      parameters: el.parameters.map(toRefJson).filter(Boolean) as ElementRefJson[],
      subFunctions: el.subFunctions?.map(toRefJson).filter(Boolean) as ElementRefJson[] ?? [],
      subFunctionType: el.subFunctionType,
      scriptCode: el.scriptCode,
    };
    return json;
  }

  if (el instanceof Param) {
    const json: ParamJson = {
      ...base,
      type: 'Param',
      parameterDef: toRefJson((el as any).parameterDef),
      value: el.value,
      valueType: el.valueType ? { type: el.valueType } : undefined,
      functionCall: toRefJson(el.functionCall),
      preset: toRefJson(el.preset),
      valueElement: toRefJson(el.valueElement),
      array: (() => {
        const arr = (el as any).array;
        if (!arr) return undefined;
        if (Array.isArray(arr)) {
          if (arr.length === 0) return undefined;
          if (arr.length === 1) return toRefJson(arr[0]);
          return arr.map((a: any) => toRefJson(a)).filter(Boolean) as any;
        }
        return toRefJson(arr);
      })(),
      variable: toRefJson(el.variable),
      structMember: toRefJson((el as any).structMember),
      paramRef: toRefJson((el as any).paramRef),
    };
    return json;
  }

  if (el instanceof ParamDef) {
    const json: ParamDefJson = {
      ...base,
      type: 'ParamDef',
      paramType: toParamTypeJson(el.type) ?? { type: 'unknown' },
      default: toRefJson(el.default),
      isReference: el.isReference,
      isMultiple: el.isMultiple,
    };
    return json;
  }

  if (el instanceof Preset) {
    const json: PresetJson = {
      ...base,
      type: 'Preset',
      baseType: el.baseType,
      values: el.values.map(toRefJson).filter(Boolean) as ElementRefJson[],
    };
    return json;
  }

  if (el instanceof PresetValue) {
    const json: PresetValueJson = {
      ...base,
      type: 'PresetValue',
      value: el.value,
    };
    return json;
  }

  if (el instanceof Category) {
    const json: CategoryJson = {
      ...base,
      type: 'Category',
      items: el.items.map(toRefJson).filter(Boolean) as ElementRefJson[],
    };
    return json;
  }

  if (el instanceof Label) {
    const json: LabelJson = {
      ...base,
      type: 'Label',
    };
    return json;
  }

  if (el instanceof Variable) {
    const json: VariableJson = {
      ...base,
      type: 'Variable',
      variableType: toParamTypeJson(el.variableType),
      initialValue: toRefJson(el.initialValue),
      isArray: el.isArray,
      isConstant: el.isConstant,
      arraySizes: (el as any).arraySizes?.map((s: any) => ({
        dim: s.dim,
        value: s.value,
        variable: toRefJson(s.variable),
      })),
    };
    return json;
  }

  if (el instanceof Structure) {
    const json: StructureJson = {
      ...base,
      type: 'Structure',
      variables: ((el as any).variables ?? []).map(toRefJson).filter(Boolean) as ElementRefJson[],
    };
    return json;
  }

  if (el instanceof Trigger) {
    const json: TriggerJson = {
      ...base,
      type: 'Trigger',
      events: el.events.map(toRefJson).filter(Boolean) as ElementRefJson[],
      conditions: el.conditions.map(toRefJson).filter(Boolean) as ElementRefJson[],
      actions: el.actions.map(toRefJson).filter(Boolean) as ElementRefJson[],
      localVariables: el.localVariables.map(toRefJson).filter(Boolean) as ElementRefJson[],
    };
    return json;
  }

  return undefined;
}

function normalizeTriggerXml(xmlContent: string): string {
  // Адаптация NativeLib формата:
  // <TriggerData><Standard Id="Ntve"/><Root>...</Root><Element>...</Element></TriggerData>
  // → <TriggerData><Library Id="Ntve"><Root>...</Root><Element>...</Element></Library></TriggerData>
  // Моды уже используют <Library> внутри <TriggerData> — их не трогаем.
  if (xmlContent.includes('<Standard Id=')) {
    return xmlContent
      .replace(/<Standard Id="([^"]+)"\s*\/>/, '<Library Id="$1">')
      .replace(/<\/TriggerData>/, '</Library></TriggerData>');
  }
  return xmlContent;
}

function buildAnalysisResult(libId: string, lib: Library): TriggerAnalysisResult {
  // Elements are stored separately by type. Same ID can exist in multiple
  // type-specific maps (e.g. 00000136 is both FunctionDef "SetVariable" and
  // ParamDef "u" in NativeLib). Consumers should query the appropriate map.
  const elements: Record<string, ElementJson> = {};
  const elementsByType: Record<string, Record<string, ElementJson>> = {
    'FunctionDef': {},
    'ParamDef': {},
    'FunctionCall': {},
    'Param': {},
    'Variable': {},
    'Trigger': {},
    'Preset': {},
    'PresetValue': {},
    'Category': {},
    'Label': {},
    'Structure': {},
  };
  const refsByElement = new Map<string, CatalogRef[]>();
  const allRefs: CatalogRef[] = [];

  for (const [, el] of lib.getElements()) {
    const json = convertElement(el);
    if (!json) continue;

    // Store in global elements map (first occurrence wins for same ID+type)
    const typeKey = `${json.type}:${json.id}`;
    if (!elements[typeKey]) {
      elements[typeKey] = json;
    }

    // Store in type-specific map
    const typeMap = elementsByType[json.type];
    if (typeMap && !typeMap[json.id]) {
      typeMap[json.id] = json;
    }

    const refs: CatalogRef[] = [];

    if (el instanceof Param) {
      refs.push(...extractParamRefs(el, ''));
    }

    if (el instanceof FunctionDef && el.scriptCode) {
      refs.push(...extractScriptCodeRefs(el.scriptCode, 'scriptCode'));
    }

    if (refs.length > 0) {
      (json as any).catalogRefs = refs;
      refsByElement.set(el.id, refs);
      allRefs.push(...refs);
    }
  }

  const items: ElementJson[] = [];
  for (const itemRef of lib.items) {
    const resolved = itemRef.resolve();
    if (resolved) {
      const json = convertElement(resolved);
      if (json) items.push(json);
    }
  }

  const libraryJson: TriggerLibraryJson = {
    id: libId,
    items,
    elements,
    elementsByType: elementsByType as any,
  };

  return {
    library: libraryJson,
    refsByElement,
    allRefs,
  };
}

/**
 * Читает Trigger XML и возвращает строго типизированный JSON + catalog refs.
 * Опционально применяет TriggerStrings для локализации имён элементов.
 */
export async function readTriggerLibrary(
  xmlContent: string,
  triggerStringsContent?: string
): Promise<TriggerAnalysisResult> {
  xmlContent = normalizeTriggerXml(xmlContent);

  const store = new TriggerStore();
  const reader = new XMLReader(store);
  await reader.load(xmlContent);

  const libraries = store.getLibraries();
  if (libraries.size === 0) {
    throw new Error('No libraries found in trigger XML');
  }

  const [libId, lib] = libraries.entries().next().value!;
  const result = buildAnalysisResult(libId, lib);

  if (triggerStringsContent !== undefined) {
    result.library.triggerStringsLoaded = true;
    const strings = parseTriggerStrings(triggerStringsContent);
    result.library.paramValuesLoaded = [...strings.keys()].some(key => key.startsWith('ParamValue:'));
    applyTriggerStringsByType(libId, result.library.elementsByType, strings);
    const libName = strings.get(`Library:${libId}`);
    if (libName) result.library.name = libName;
    const subFuncTypeNames: Record<string, string> = {};
    for (const [key, name] of strings) {
      if (key.startsWith('SubFuncType:')) subFuncTypeNames[key.slice('SubFuncType:'.length)] = name;
    }
    if (Object.keys(subFuncTypeNames).length > 0) result.library.subFuncTypeNames = subFuncTypeNames;
  }

  return result;
}

/**
 * Читает несколько Trigger XML в один shared store.
 * Возвращает Map<libraryId, AnalysisResult>.
 * Cross-library ссылки (например DPAN → Ntve) корректно резолвятся.
 */
export async function readTriggerLibraries(
  xmlContents: string[],
  triggerStringsMap?: Map<string, string>
): Promise<Map<string, TriggerAnalysisResult>> {
  const store = new TriggerStore();
  const reader = new XMLReader(store);

  for (const xml of xmlContents) {
    await reader.load(normalizeTriggerXml(xml));
  }

  const results = new Map<string, TriggerAnalysisResult>();
  for (const [libId, lib] of store.getLibraries()) {
    const result = buildAnalysisResult(libId, lib);

    if (triggerStringsMap?.has(libId)) {
      result.library.triggerStringsLoaded = true;
      const strings = parseTriggerStrings(triggerStringsMap.get(libId)!);
      result.library.paramValuesLoaded = [...strings.keys()].some(key => key.startsWith('ParamValue:'));
      applyTriggerStringsByType(libId, result.library.elementsByType, strings);
      const libName = strings.get(`Library:${libId}`);
      if (libName) result.library.name = libName;
      const subFuncTypeNames: Record<string, string> = {};
      for (const [key, name] of strings) {
        if (key.startsWith('SubFuncType:')) subFuncTypeNames[key.slice('SubFuncType:'.length)] = name;
      }
      if (Object.keys(subFuncTypeNames).length > 0) result.library.subFuncTypeNames = subFuncTypeNames;
    }

    results.set(libId, result);
  }

  return results;
}
