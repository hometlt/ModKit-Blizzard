import type { GalaxyConstantIndex, ConstantFold } from './galaxy-constants.js';
/**
 * g2t-core — shared infrastructure for the Galaxy→trigger reverse conversion.
 *
 * Contains everything that every other g2t-* module depends on:
 *   - GalaxyToTriggerOptions and ReverseCtx interfaces
 *   - ID generator — generateId / resetGalaxyToTriggerIdCounter
 *   - Element creation helpers — mkParamRef, mkFCRef, fdRef
 *   - Name extraction helpers — extractGlobalVarName, extractTriggerName, etc.
 *   - Boilerplate detection — isLibraryBoilerplate, isTriggerInitFunction, etc.
 *   - Reverse lookup map builders — buildFuncNameToFuncDefMap, etc.
 *   - Variable initial-value helpers — defaultValueForType, attachDefaultParam
 *   - AST utility functions — unwrapParens, getIdentifierName, getBlockStatements, etc.
 *   - Type helpers — getTypeName, unwrapArrayType, galaxyTypeToTrigger
 */
import { SyntaxKind, tokenToString, isKeywordTypeKind, stringToToken } from '@modkit/blizzard-starcraft2/galaxy/language-core';
import { conversionError, libraryPrefix, lookupElementIn, sanitizeIdentifier, startupFunctionName } from './conversion-model.js';

import type {
  TriggerLibraryJson,
  VariableJson,
  FunctionCallJson,
  FunctionDefJson,
  ParamJson,
  ParamDefJson,
  ElementJson,
  ElementRefJson,
} from '../../../shared/trigger-document/index.js';

// ---------------------------------------------------------------------------
// Options interface
// ---------------------------------------------------------------------------

export interface GalaxyToTriggerOptions {
  libraryId: string;
  libraryName?: string;
  /** The script belongs to a map document, whose namespace is the script's own:
   *  its functions, variables and triggers are unprefixed and its startup
   *  functions carry a map's names. */
  implicitLibrary?: boolean;
  galaxyDeclarations?: Array<{ fileName: string; text: string }>;
  constantFolds?: ConstantFold[];
  /** Preserve source startup functions when an explicit generation contract is used. */
  preserveInitialization?: boolean;
  /** A library the map defines itself: the libraries the map starts before it
   *  (the lib<X>_InitLib calls ahead of its own). Its InitLibraries may call their
   *  InitVariables again, which the model does not regenerate and need not. */
  initializedDependencies?: readonly string[];
  /** Receives the dependency InitVariables calls a recognized library startup
   *  had beyond the ones regenerated from element references. */
  droppedStartupCalls?: string[];
  /** NativeLib для reverse lookup FunctionDef/SubFuncType */
  nativeLibrary?: TriggerLibraryJson;
  dependencyLibraries?: Map<string, TriggerLibraryJson>;
  /** Global vars from OTHER libraries, keyed by galaxy identifier (lib{ID}_gv_{NAME}) */
  crossLibVars?: Map<string, { id: string; library: string }>;
  externalFuncParamTypes?: Map<string, string[]>;
  /** Function defs from OTHER libraries already converted in this session.
   *  Key: galaxy identifier lib{LIB}_gf_{name}  →  { library, id } element ref.
   *  Used to seed funcNameToFuncDef so cross-library calls resolve to proper element IDs. */
  crossLibFuncDefs?: Map<string, CrossLibFunctionDefInfo>;
  /** Other Galaxy files of the document converted together with the script
   *  (convertAdditionalScripts): the top-level names each one defines get a
   *  folder named after the file. */
  additionalScriptFolders?: Array<{ fileName: string; names: string[] }>;
  sourceText?: string;
  /** Optional observational progress stream. Callback failures are isolated
   * from conversion; cancellation remains the AbortSignal's responsibility. */
  onProgress?: (progress: GalaxyToTriggerProgress) => void;
}

export interface GalaxyToTriggerProgress {
  phase: 'index' | 'declarations' | 'bodies' | 'initialization' | 'events' | 'finalize';
  completed: number;
  total: number;
  elements: number;
}

export interface CrossLibFunctionDefInfo {
  library: string;
  id: string;
  parameters?: ElementRefJson[];
}

// ---------------------------------------------------------------------------
// ID counter
// ---------------------------------------------------------------------------

let allocation = { counter: 0, used: new Set<string>() };
function generateId(): string {
  // IDs must be valid 8-char hex for TriggerStrings.txt regex ([A-Fa-f0-9]+).
  // Start at 0xA0000000 to avoid collision with NativeLib's low-value IDs AND with
  // content-derived IDs (which are forced below 0x80000000, see idFromKey).
  // Localized values can preserve an authored Param/Value/A....... identity in
  // this same high range, however, so the sequential allocator must skip every
  // identity already claimed by either path.
  for (;;) {
    const id = (0xA0000000 + allocation.counter++).toString(16).toUpperCase();
    if (allocation.used.has(id)) continue;
    allocation.used.add(id);
    return id;
  }
}

// ID counter is NOT reset between libraries — keeps IDs unique across all libraries
// in a single conversion session, preventing cross-library ID collisions.

// ---------------------------------------------------------------------------
// Content-derived (deterministic) IDs
// ---------------------------------------------------------------------------
//
// Cross-library references (Variable, FunctionDef) are remapped by a pass1/pass2
// fix-up because order-based counter IDs differ between the two passes. Deriving
// those IDs from stable content (libId + kind + name) makes them identical across
// passes, so the remap is unnecessary and cross-library IDs never collide.
//
// Content IDs occupy the 0x00000000–0x7FFFFFFF range (high bit cleared); the
// counter occupies 0xA0000000+. The two spaces are therefore disjoint by
// construction, so a content ID can never collide with a counter ID. Collisions
// *between* content keys are resolved by deterministic re-hashing.
/** Observational callbacks may synchronously start/reset another converter.
 * Give that call tree its own allocator and restore the outer one on failure
 * as well as success. Keep the legacy session allocator outside callbacks. */
export function withIsolatedGalaxyToTriggerIds<T>(callback: () => T): T {
  const previous = allocation;
  allocation = { counter: 0, used: new Set<string>() };
  try { return callback(); } finally { allocation = previous; }
}

function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic 8-hex ID for a stable content key (e.g. `${libId}|gf|${name}`). */
function idFromKey(key: string): string {
  let probe = key;
  for (let attempt = 0; attempt < 1000; attempt++) {
    const id = ((fnv1a32(probe) & 0x7fffffff) >>> 0).toString(16).toUpperCase().padStart(8, '0');
    if (!allocation.used.has(id)) {
      allocation.used.add(id);
      return id;
    }
    probe = key + '~' + attempt;
  }
  // Pathological fallback (effectively unreachable): linear scan.
  let n = 0;
  for (;;) {
    const id = (n++).toString(16).toUpperCase().padStart(8, '0');
    if (!allocation.used.has(id)) { allocation.used.add(id); return id; }
  }
}

export { generateId, idFromKey };

export function reserveGalaxyToTriggerId(id: string): void {
  allocation.used.add(id.toUpperCase());
}

/** The editor names the private variables of a template action after the
 *  action's own element id, `auto<ID>_<name>`, and the compiler regenerates
 *  them from the call id the same way. A call restored from such variables
 *  takes that id back when every bound variable spells it and it is still
 *  free, so a round trip keeps `auto9DE7D937_var` instead of inventing
 *  `autoA00000D8_var`. Claim it before the call's children are built. */
export function claimAutoCallId(autos: ReadonlyMap<string, { name?: string } | undefined>): string | undefined {
  let id: string | undefined;
  for (const [name, node] of autos) {
    const auto = extractAutoVarName(node?.name ?? '');
    if (!auto || auto.suffix !== name) return undefined;
    const candidate = auto.id.toUpperCase();
    if (id !== undefined && candidate !== id) return undefined;
    id = candidate;
  }
  if (id === undefined || allocation.used.has(id)) return undefined;
  allocation.used.add(id);
  return id;
}

/** claimAutoCallId for an action builder that knows its automatic variables by
 *  their source names (Switch `val`, loop `ae`/`ai`/`var`); names that are not
 *  automatic variables do not take part. */
export function claimAutoCallIdFromNames(names: ReadonlyArray<string | undefined>): string | undefined {
  const autos = new Map<string, { name: string }>();
  for (const name of names) {
    const auto = name === undefined ? undefined : extractAutoVarName(name);
    if (auto && name !== undefined) autos.set(auto.suffix, { name });
  }
  return autos.size ? claimAutoCallId(autos) : undefined;
}

/** Give back an id claimed for a call that was then discarded. */
export function releaseAutoCallId(id: string | undefined): void {
  if (id !== undefined) allocation.used.delete(id);
}

export function resetGalaxyToTriggerIdCounter(): void {
  allocation = { counter: 0, used: new Set<string>() };
}

// ---------------------------------------------------------------------------
// Name extraction helpers
// ---------------------------------------------------------------------------

/** Extracts global variable name from Galaxy name: lib{LIB}_gv_{NAME} */
export function extractGlobalVarName(galaxyName: string, libId: string): string | undefined {
  const prefix = `${libraryPrefix(libId)}gv_`;
  if (galaxyName.startsWith(prefix)) {
    return galaxyName.slice(prefix.length);
  }
  // MapScript-style globals (SC2Map): gv_name
  if (galaxyName.startsWith('gv_') && galaxyName.length > 3) {
    return galaxyName.slice(3);
  }
  // A map has no Trigger XML library namespace, but its compiled MapScript can
  // retain the linkage prefix of an embedded editor library. Both gv_ and ge_
  // declarations become ordinary map variables; the editor writes its own gv_
  // prefix when it compiles the map again.
  if (libraryPrefix(libId) === '') {
    const match = /^lib[A-Za-z0-9_]+_g[ve]_(.+)$/u.exec(galaxyName);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

/** Extracts user-function name from Galaxy name: lib{LIB}_gf_{NAME} or plain gf_{NAME} */
export function extractUserFunctionName(galaxyName: string, libId: string): string | undefined {
  const prefix = `${libraryPrefix(libId)}gf_`;
  if (galaxyName.startsWith(prefix)) {
    return galaxyName.slice(prefix.length);
  }
  if (galaxyName.startsWith('gf_') && galaxyName.length > 3) {
    return galaxyName.slice(3);
  }
  // A map has no Trigger XML library namespace, but MapScript.galaxy can be a
  // compiled remnant of a formerly embedded library and retain lib*_gf_.  The
  // document kind proves map ownership; the arbitrary library token itself is
  // linkage syntax, not part of the authored function name.
  if (libraryPrefix(libId) === '') {
    const match = /^lib[A-Za-z0-9_]+_gf_(.+)$/u.exec(galaxyName);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

/** Extracts local variable name: lv_{NAME} (at least 1 char after prefix) */
export function extractLocalVarName(galaxyName: string): string | undefined {
  if (galaxyName.startsWith('lv_') && galaxyName.length > 3) {
    return galaxyName.slice(3);
  }
  return undefined;
}

/** Extracts an editor auto-variable name: auto{8-hex call ID}_{macro name}. The macro
 *  name is whatever the ScriptCode declares (`var`, `ae`, Repeat's `n`, an authored
 *  `cursor`); a fixed suffix list left Repeat's count unrecognized. */
export function extractAutoVarName(galaxyName: string): { id: string; suffix: string } | undefined {
  const match = galaxyName.match(/^auto([A-Fa-f0-9]{8})_([A-Za-z_]\w*)$/);
  if (match) {
    return { id: match[1], suffix: match[2] };
  }
  return undefined;
}

/** Extracts trigger name from handle or function: lib{LIB}_gt_{NAME}[_Func] */
export function extractTriggerName(galaxyName: string, libId: string): string | undefined {
  const prefix = `${libraryPrefix(libId)}gt_`;
  let name: string | undefined;
  if (galaxyName.startsWith(prefix)) {
    name = galaxyName.slice(prefix.length);
  } else if (galaxyName.startsWith('gt_')) {
    // MapScript-style trigger symbol: gt_Name[_Func]
    name = galaxyName.slice(3);
  } else if (libId === 'Map') {
    // A map document has no Library wrapper, but an authored MapScript may
    // retain the editor namespace that existed when the script was generated.
    // The namespace is linkage syntax; TriggerCreate/Init validation below is
    // what proves that the declaration is a trigger.
    const match = /^lib[A-Za-z0-9_]+_gt_(.+)$/u.exec(galaxyName);
    if (match) name = match[1];
  } else {
    return undefined;
  }
  if (name === undefined) return undefined;
  if (name.endsWith('_Func')) {
    name = name.slice(0, -5);
  }
  return name;
}

/** Returns true if FunctionDecl is library boilerplate */
export function isLibraryBoilerplate(funcName: string, libId: string): boolean {
  return funcName === startupFunctionName(libId, 'InitLibraries')
    || funcName === startupFunctionName(libId, 'InitVariables')
    || funcName === startupFunctionName(libId, 'InitLib');
}

/** Returns true if FunctionDecl is a trigger init function */
export function isTriggerInitFunction(funcName: string, libId: string): boolean {
  const prefix = `${libraryPrefix(libId)}gt_`;
  if (funcName.startsWith(prefix) && funcName.endsWith('_Init') && !funcName.endsWith('_Func_Init')) return true;
  // MapScript-style trigger init: gt_Name_Init
  if (funcName.startsWith('gt_') && funcName.endsWith('_Init') && !funcName.endsWith('_Func_Init')) return true;
  return libId === 'Map' && /^lib[A-Za-z0-9_]+_gt_.+_Init$/u.test(funcName) && !funcName.endsWith('_Func_Init');
}

/** Returns true if FunctionDecl is a trigger body function */
export function isTriggerBodyFunction(funcName: string, libId: string): boolean {
  const prefix = `${libraryPrefix(libId)}gt_`;
  if (funcName.startsWith(prefix) && funcName.endsWith('_Func')) return true;
  // MapScript-style trigger body: gt_Name_Func
  if (funcName.startsWith('gt_') && funcName.endsWith('_Func')) return true;
  return libId === 'Map' && /^lib[A-Za-z0-9_]+_gt_.+_Func$/u.test(funcName);
}

// ---------------------------------------------------------------------------
// Reverse conversion context
// ---------------------------------------------------------------------------

export interface ReverseCtx {
  constants?: GalaxyConstantIndex;
  libId: string;
  elements: Record<string, ElementJson>;
  nativeLibrary?: TriggerLibraryJson;
  dependencyLibraries?: Map<string, TriggerLibraryJson>;
  funcNameToFuncDef: Map<string, FunctionDefJson>;
  roleToSubFuncType: Map<string, { library: string; id: string }>;
  /** "lv_X" → element id of the Variable */
  localVarByGalaxyName: Map<string, string>;
  /** "lib{LIB}_gv_X" → {id, library} of the Variable */
  globalVarByGalaxyName: Map<string, { id: string; library: string }>;
  triggerByGalaxyName?: Map<string, ElementRefJson>;
  /** "auto{HEX}_var" → init Expression (start value) */
  pendingAutoInits: Map<string, any>;
  /** "auto{HEX}_ae" → end Expression */
  pendingAutoEnds: Map<string, any>;
  /** "auto{HEX}_ai" → increment Expression */
  pendingAutoIncrements: Map<string, any>;
  /** Galaxy name of the active PickEachInteger loop counter (auto*_var) → maps to IntLoopCurrent() */
  pickEachIntVarName?: string;
  pickEachPlayerVarName?: string;
  pickEachUnitVarName?: string;
  /** NativeLib constant name (e.g. "c_syncFrameTypeConsolePanel") → PresetValue ref */
  galaxyConstToPreset: Map<string, ElementRefJson>;
  /** "gs_Name" → Structure element ref */
  structureByGalaxyTypeName?: Map<string, ElementRefJson>;
  /** "{structureId}:{lv_member}" → member Variable ref */
  structureMemberByKey?: Map<string, ElementRefJson>;
  /** When true, ReturnStatement with value is converted to Return action (user function mode) */
  isUserFunction?: boolean;
  returnType?: string;
  /** Original enclosing body, including any subsequently extracted trigger guards. */
  structuredFunctionStatements?: any[];
  /** Macro names owned by enclosing reconstructed actions. */
  structuredActiveAutoNames?: ReadonlySet<string>;
  /** FunctionDef names of enclosing reconstructed templates.  Accessor
   * templates that use #AUTOVAR(...,ancestor:Name) are only valid while that
   * explicitly named parent is active. */
  structuredAncestorDefinitions?: readonly string[];
  /** Auto variables of enclosing matched actions that read back as a loaded
   * accessor call, by Galaxy name (see templateAutoAccessors). */
  structuredAutoAccessors?: ReadonlyMap<string, FunctionDefJson>;
  structuredTemplates?: Map<string, FunctionDefJson>;
  /** Structural lowering for an expression the native builders cannot represent,
   * such as a call no loaded library defines (set by structuredStatements). */
  structuredExpression?: (expression: any, role: { library: string; id: string } | undefined, ctx: ReverseCtx, expectedType?: string) => ElementRefJson;
  structuredLocals?: ElementRefJson[];
  compiledTemplates?: Map<FunctionDefJson, import('./script-template.js').CompiledTemplate[]>;
  templateDefinitions?: FunctionDefJson[];
  /** Complete immutable candidate list assembled from loaded TriggerData. */
  templateCandidates?: import('./script-template.js').CompiledTemplate[];
  /** Maps lp_xxx galaxy name → { library, id } of the corresponding FunctionDef ParamDef */
  paramRefByGalaxyName?: Map<string, ElementRefJson>;
  externalFuncParamTypes?: Map<string, string[]>;
  /** Function element refs from other already-converted libraries.
   *  Key: galaxy identifier lib{LIB}_gf_{name}  →  { library, id }. */
  crossLibFuncDefs?: Map<string, CrossLibFunctionDefInfo>;
  sourceText?: string;
}

// ---------------------------------------------------------------------------
// Element creation helpers
// ---------------------------------------------------------------------------

export function mkParamRef(data: Partial<Omit<ParamJson, 'type' | 'id' | 'library'>>, ctx: ReverseCtx, reservedId?: string): ElementRefJson {
  // A localized text value is keyed in GameStrings by the identity of the
  // parameter that holds it, so recovering the text means recovering that
  // identity rather than inventing a fresh one.
  const id = reservedId !== undefined && !ctx.elements[reservedId] ? reservedId : generateId();
  reserveGalaxyToTriggerId(id);
  const el = { type: 'Param', id, library: ctx.libId, ...data } as ParamJson;
  ctx.elements[id] = el;
  return { type: 'Param', library: ctx.libId, id };
}

export function mkFCRef(
  data: Partial<Omit<FunctionCallJson, 'type' | 'id' | 'library'>>,
  ctx: ReverseCtx,
  claimedId?: string,
): ElementRefJson {
  // A ScriptCode template may expose a single #SUBFUNCS slot without usable
  // TriggerStrings for that SubFuncType.  The parsed Galaxy proves which calls
  // belong to the parent, and a sole declared role makes their XML placement
  // unambiguous.  Attach that role here, at the common creation boundary, so
  // specialized expression builders cannot accidentally emit orphaned calls.
  // With multiple roles, only a unique action/condition type match is safe.
  const definitionRef = data.functionDef;
  if (definitionRef && data.subFunctions?.length) {
    const libraryId = definitionRef.library ?? ctx.libId;
    const definition = libraryId === ctx.libId
      ? ctx.elements[definitionRef.id]
      : libraryId === (ctx.nativeLibrary?.id ?? 'Ntve')
        ? ctx.nativeLibrary?.elementsByType?.FunctionDef?.[definitionRef.id] ?? ctx.nativeLibrary?.elements?.[definitionRef.id]
        : ctx.dependencyLibraries?.get(libraryId)?.elementsByType?.FunctionDef?.[definitionRef.id]
          ?? ctx.dependencyLibraries?.get(libraryId)?.elements?.[definitionRef.id];
    const roles = definition?.type === 'FunctionDef' ? definition.subFunctionTypes ?? [] : [];
    const resolve = (ref: ElementRefJson): ElementJson | undefined => {
      const owner = ref.library ?? ctx.libId;
      if (owner === ctx.libId) return ctx.elements[ref.id];
      const library = owner === ctx.nativeLibrary?.id ? ctx.nativeLibrary : ctx.dependencyLibraries?.get(owner);
      return library ? lookupElementIn(library, ref) : undefined;
    };
    for (const childRef of data.subFunctions) {
      if ((childRef.library ?? ctx.libId) !== ctx.libId) continue;
      const child = ctx.elements[childRef.id];
      if (child?.type !== 'FunctionCall' || child.subFunctionType) continue;
      let role = roles.length === 1 ? roles[0] : undefined;
      if (!role && child.functionDef) {
        const childDefinition = resolve(child.functionDef);
        if (childDefinition?.type === 'FunctionDef' && typeof childDefinition.isFuncAction === 'boolean') {
          const matching = roles.filter(candidate => {
            const resolved = resolve({ ...candidate, type: 'SubFuncType' });
            return resolved?.type === 'SubFuncType' && (resolved.isAction === true) === childDefinition.isFuncAction;
          });
          if (matching.length === 1) role = matching[0];
        }
      }
      if (role) child.subFunctionType = { ...role, type: 'SubFuncType' };
    }
  }
  const id = claimedId ?? generateId();
  ctx.elements[id] = { type: 'FunctionCall', id, library: ctx.libId, ...data } as FunctionCallJson;
  return { type: 'FunctionCall', library: ctx.libId, id };
}

export function structureMemberKey(structureId: string, galaxyFieldName: string): string {
  return `${structureId}:${galaxyFieldName}`;
}

export function maybeResolveStructureMember(
  baseData: Partial<ParamJson>,
  memberName: string,
  ctx: ReverseCtx,
): Partial<ParamJson> | undefined {
  // A structure path can start at either a Variable or a FunctionDef
  // parameter.  Both carry the declared structure type, but Param encodes the
  // latter with <Parameter Type="ParamDef" .../> rather than <Variable .../>.
  // Treating only variables as owners made assignments through structref
  // parameters silently degrade to <Value>null</Value>.
  let ownerRef = baseData.variable ?? baseData.paramRef;
  let tail: ParamJson | undefined;
  if (baseData.structMember?.id) {
    tail = ctx.elements[baseData.structMember.id] as ParamJson | undefined;
    while (tail?.structMember?.id) tail = ctx.elements[tail.structMember.id] as ParamJson | undefined;
    ownerRef = tail?.variable ?? tail?.paramRef;
  }
  if (!ownerRef) return undefined;
  const owner = ctx.elements[ownerRef.id] as VariableJson | ParamDefJson | undefined;
  const ownerType = owner?.type === 'Variable' ? owner.variableType
    : owner?.type === 'ParamDef' ? owner.paramType
    : undefined;
  const structureRef = ownerType?.typeElement;
  if (!structureRef?.id) return undefined;
  const memberRef = ctx.structureMemberByKey?.get(structureMemberKey(structureRef.id, memberName));
  if (!memberRef) return undefined;
  const next = mkParamRef({ variable: memberRef }, ctx);
  if (tail) {
    tail.structMember = next;
    return baseData;
  }
  return { ...baseData, structMember: next };
}

export function triggerParamTypeFromGalaxyTypeName(
  galaxyTypeName: string | undefined,
  ctx: Pick<ReverseCtx, 'structureByGalaxyTypeName'>,
  parameter = false,
): { type: string; typeElement?: ElementRefJson } {
  const normalized = galaxyTypeName || 'int';
  const reference = /^structref<(.+)>$/u.exec(normalized);
  if (reference) {
    const target = ctx.structureByGalaxyTypeName?.get(reference[1]);
    if (!parameter || !target) return conversionError('UNSUPPORTED_REFERENCE_TYPE', 'Structure references require a known structure in a function parameter', { type: normalized });
    return { type: 'struct', typeElement: target };
  }
  const structureRef = ctx.structureByGalaxyTypeName?.get(normalized);
  if (structureRef) {
    if (parameter) return conversionError('STRUCT_VALUE_PARAMETER', 'A value structure parameter cannot be silently changed to a GUI reference parameter', { type: normalized });
    return { type: 'struct', typeElement: structureRef };
  }
  return { type: galaxyTypeToTrigger(normalized) };
}

export function fdRef(funcDef: FunctionDefJson): ElementRefJson {
  return { type: 'FunctionDef', library: funcDef.library ?? 'Ntve', id: funcDef.id };
}

// ---------------------------------------------------------------------------
// Reverse lookup maps
// ---------------------------------------------------------------------------

/** Mirrors the sanitizeName logic in ttg-core.ts — removes non-identifier chars. */
export function sanitizeFuncName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '').replace(/^[^a-zA-Z_]+/, '');
}

export function buildFuncNameToFuncDefMap(nativeLibrary?: TriggerLibraryJson): Map<string, FunctionDefJson> {
  const map = new Map<string, FunctionDefJson>();
  if (!nativeLibrary?.elementsByType?.FunctionDef) return map;
  const libId = nativeLibrary.id ?? 'Ntve';
  for (const funcDef of Object.values(nativeLibrary.elementsByType.FunctionDef)) {
    // Legacy helpers also use this index for editor operators. Keep those
    // entries, but never let one shadow a callable with the same identifier.
    const operatorOnly = funcDef.flags?.includes('Operator') && !funcDef.scriptCode;
    const existing = funcDef.name && map.get(funcDef.name);
    if (operatorOnly && existing && !existing.flags?.includes('Operator')) continue;
    if (funcDef.name) {
      // Plain identifier names: register as-is.
      if (/^[a-zA-Z_]\w*$/.test(funcDef.name)) {
        map.set(funcDef.name, funcDef);
      }
      // Sanitized form (e.g. "Get DateTime Year" → "GetDateTimeYear").
      // trigger-to-galaxy uses this form as the lib{Ntve}_gf_ galaxy name.
      const sanitized = sanitizeFuncName(funcDef.name);
      if (sanitized && sanitized !== funcDef.name && !map.has(sanitized)) {
        map.set(sanitized, funcDef);
      }
      // Register the lib{libId}_gf_<sanitized> form for non-native lib-prefixed calls.
      if (!funcDef.flags?.includes('Native') && !funcDef.flags?.includes('NoScriptPrefix')) {
        const prefixed = `${libraryPrefix(libId)}gf_${sanitized || funcDef.name}`;
        if (!map.has(prefixed)) map.set(prefixed, funcDef);
      }
    }
    // Also register by Galaxy function name extracted from scriptCode (e.g. "PlayerGroupNextPlayer").
    if (funcDef.scriptCode) {
      const galaxyName = funcDef.scriptCode.match(/^([A-Za-z_]\w*)\s*\(/)?.[1];
      if (galaxyName && !map.has(galaxyName)) {
        map.set(galaxyName, funcDef);
      }
    }
  }
  // Display-name aliases must not shadow functions actually emitted under
  // that name. A native and its library wrapper may have different signatures.
  for (const funcDef of Object.values(nativeLibrary.elementsByType.FunctionDef)) {
    if (funcDef.name && (funcDef.flags?.includes('Native') || funcDef.flags?.includes('NoScriptPrefix'))) {
      map.set(sanitizeFuncName(funcDef.name), funcDef);
    }
  }
  return map;
}

/**
 * Build a reverse map: galaxy constant name (e.g. "c_syncFrameTypeConsolePanel") → PresetValue ref.
 * Used to convert Identifier nodes that are NativeLib constants back to proper Preset references.
 */
export function buildGalaxyConstToPresetMap(
  nativeLibrary?: TriggerLibraryJson,
  dependencyLibraries?: Map<string, TriggerLibraryJson>,
): Map<string, ElementRefJson> {
  const map = new Map<string, ElementRefJson>();
  const mappedValueDefinesDefault = new Map<string, boolean>();
  // A campaign map reaches preset values from every library it depends on, not
  // only the native one. Indexing the native library alone leaves each of those
  // constants unbound, and an unbound constant becomes a synthesized template.
  const sources = [nativeLibrary, ...(dependencyLibraries?.values() ?? [])];
  for (const library of sources) {
    if (!library?.elementsByType?.PresetValue) continue;
    for (const pv of Object.values(library.elementsByType.PresetValue)) {
      if (pv.value && pv.value !== '') {
        // galaxy constant name → ref to this PresetValue
        // Several editor presets can intentionally share one Galaxy sentinel.
        // Without a formal parameter, the concrete "No value" choice is a
        // better inverse than the wildcard choice marked DefinesDefault.
        const existingIsDefault = mappedValueDefinesDefault.get(pv.value);
        if (!map.has(pv.value) || existingIsDefault === true && pv.definesDefault !== true) {
          map.set(pv.value, { type: 'PresetValue', library: pv.library ?? library.id, id: pv.id });
          mappedValueDefinesDefault.set(pv.value, pv.definesDefault === true);
        }
      }
    }
    // A preset that generates constants spells them lib<Id>_ge_<Preset>_<Value>
    // and stores the literal, not that name, in each value. Without this the
    // name is unbound and every use of it becomes a synthesized template.
    for (const preset of Object.values(library.elementsByType?.Preset ?? {})) {
      if (!preset.generateConstants || !preset.name) continue;
      const prefix = `${libraryPrefix(library.id)}ge_${sanitizeIdentifier(preset.name)}_`;
      for (const ref of preset.values ?? []) {
        const value = library.elementsByType?.PresetValue?.[ref.id];
        if (!value?.name) continue;
        const key = prefix + sanitizeIdentifier(value.name);
        if (!map.has(key)) map.set(key, { type: 'PresetValue', library: value.library ?? library.id, id: value.id });
      }
    }
  }
  return map;
}

export function buildRoleToSubFuncTypeMap(
  nativeLibrary?: TriggerLibraryJson,
): Map<string, { library: string; id: string }> {
  const map = new Map<string, { library: string; id: string }>();
  const addRole = (roleName: string, ref: { library: string; id: string }, replace = false): void => {
    const aliases = new Set([roleName, roleName.toLowerCase(), roleName.slice(0, 1).toUpperCase() + roleName.slice(1).toLowerCase()]);
    const typed = { type: 'SubFuncType', ...ref } as any;
    for (const alias of aliases) if (replace || !map.has(alias)) map.set(alias, typed);
  };
  if (!nativeLibrary) return map;
  for (const [key, roleName] of Object.entries(nativeLibrary.subFuncTypeNames ?? {})) {
    // key format: "Ntve_00000003" → roleName: "If"
    const underscoreIdx = key.indexOf('_');
    if (underscoreIdx === -1) continue;
    addRole(roleName, { library: key.slice(0, underscoreIdx), id: key.slice(underscoreIdx + 1) });
  }
  // Native libraries are often loaded without their TriggerStrings companion.
  // The SubFuncType Identifier in the XML is still the authoritative role
  // contract and is enough to build the reverse index.
  for (const subFuncType of Object.values(nativeLibrary.elementsByType?.SubFuncType ?? {})) {
    const roleName = (subFuncType as any).identifier ?? subFuncType.name;
    if (typeof roleName === 'string' && roleName) addRole(roleName, { library: subFuncType.library ?? nativeLibrary.id, id: subFuncType.id });
  }
  return map;
}

/**
 * Build a role→SubFuncType map specific to a given FunctionDef.
 */
export function buildFuncDefRoleMap(
  funcDef: FunctionDefJson,
  nativeLibrary: TriggerLibraryJson | undefined,
  fallbackMap: Map<string, { library: string; id: string }>,
): Map<string, { library: string; id: string }> {
  const localSFTs = funcDef.subFunctionTypes;
  if (!localSFTs || localSFTs.length === 0) return fallbackMap;

  const sftNames = nativeLibrary?.subFuncTypeNames ?? {};
  // Roles are owned by this FunctionDef. Importing unrelated global roles can
  // produce well-formed XML that the editor later removes as an orphan.
  const map = new Map<string, { library: string; id: string }>();
  const addRole = (roleName: string, ref: { library: string; id: string }): void => {
    const aliases = new Set([roleName, roleName.toLowerCase(), roleName.slice(0, 1).toUpperCase() + roleName.slice(1).toLowerCase()]);
    const typed = { type: 'SubFuncType', ...ref } as any;
    for (const alias of aliases) map.set(alias, typed);
  };
  // Override with function-specific SubFuncType IDs (last entry wins for
  // any duplicates within a single FunctionDef — none expected in practice)
  for (const sft of localSFTs) {
    const localSubFunctionType = nativeLibrary
      ? lookupElementIn(nativeLibrary, { type: 'SubFuncType', library: sft.library, id: sft.id }) as any
      : undefined;
    const roleName = sftNames[`${sft.library}_${sft.id}`] ?? localSubFunctionType?.identifier ?? localSubFunctionType?.name;
    if (roleName) {
      addRole(roleName, sft);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Variable initial value helpers
// ---------------------------------------------------------------------------

/** Default literal value for a given trigger type (int, bool, fixed, string, etc.) */
export function defaultValueForType(triggerType: string): { value: string; valueType?: { type: string } } {
  switch (triggerType.toLowerCase()) {
    case 'bool':   return { value: 'false', valueType: { type: 'bool' } };
    case 'fixed':  return { value: '0.0',   valueType: { type: 'fixed' } };
    case 'string': return { value: '',      valueType: { type: 'string' } };
    case 'int':
    default:       return { value: '0',     valueType: { type: triggerType.toLowerCase() === 'int' ? 'int' : triggerType } };
  }
}

/**
 * Attaches a default-value Param element to a VariableJson and stores it in elements.
 * Returns the Param element ref as `initialValue`.
 */
export function attachDefaultParam(
  variable: VariableJson,
  elements: Record<string, ElementJson>,
  libId: string,
): ElementRefJson {
  const paramId = generateId();
  const { value, valueType } = defaultValueForType(variable.variableType?.type ?? 'int');
  const param: ParamJson = { type: 'Param', id: paramId, library: libId, value, valueType };
  elements[paramId] = param;
  return { type: 'Param', library: libId, id: paramId };
}

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

export function unwrapArrayType(typeNode: any): { baseType: any; sizes: any[] } {
  const sizes: any[] = [];
  let cur = typeNode;
  while (cur?.kind === SyntaxKind.ArrayType) {
    sizes.push(cur.size);
    cur = cur.elementType;
  }
  // Parser nests from left to right, so unwrap order is outermost->innermost.
  // Reverse to restore source order: int[a][b] => [a, b].
  return { baseType: cur, sizes: sizes.reverse() };
}

export function parseArraySizeExpr(
  expr: any,
  globalVarByGalaxyName: Map<string, { id: string; library: string }>,
  constants?: GalaxyConstantIndex,
): { value?: string; variable?: ElementRefJson } {
  expr = unwrapParens(expr);

  if (expr?.kind === SyntaxKind.NumericLiteral) {
    const n = Number(expr.text ?? expr.value ?? '0');
    if (Number.isSafeInteger(n) && n > 0) {
      // Galaxy stores size; trigger XML stores inclusive upper bound (size-1).
      return { value: String(n - 1) };
    }
  }

  if (expr?.kind === SyntaxKind.BinaryExpression) {
    const op = expr.operatorToken?.kind as SyntaxKind;
    const left = unwrapParens(expr.left);
    const right = unwrapParens(expr.right);
    const isPlus = op === SyntaxKind.PlusToken;
    if (isPlus && left?.kind === SyntaxKind.Identifier && right?.kind === SyntaxKind.NumericLiteral) {
      const rightNum = Number(right.text ?? right.value ?? '0');
      const ref = globalVarByGalaxyName.get(left.name);
      if (ref && rightNum === 1) {
        return { variable: { type: 'Variable', library: ref.library, id: ref.id } };
      }
    }
    if (isPlus && right?.kind === SyntaxKind.Identifier && left?.kind === SyntaxKind.NumericLiteral) {
      const leftNum = Number(left.text ?? left.value ?? '0');
      const ref = globalVarByGalaxyName.get(right.name);
      if (ref && leftNum === 1) {
        return { variable: { type: 'Variable', library: ref.library, id: ref.id } };
      }
    }
  }

  const length = constants?.evaluate(expr);
  if (length !== undefined && length > 0) return { value: String(length - 1) };

  // A bare [N] is a length, whereas XML's Variable means the inclusive
  // upper bound and emits [N + 1]. Do not silently grow the array or emit [].
  return conversionError('ARRAY_DIMENSION', 'Galaxy array length cannot be represented by the loaded Trigger array bound', {
    kind: expr?.kind, identifier: expr?.name,
  });
}

export function getTypeName(typeNode: any): string {
  if (!typeNode) return 'int';
  if (typeNode.typeArguments && typeNode.returnType) {
    return `${getTypeName(typeNode.returnType)}<${typeNode.typeArguments.map(getTypeName).join(',')}>`;
  }
  if (typeof (typeNode as any).name === 'string' && (typeNode as any).name.length > 0) {
    return (typeNode as any).name;
  }
  if (typeNode.kind === SyntaxKind.ArrayType) {
    return getTypeName(typeNode.elementType);
  }
  if (typeNode.kind === SyntaxKind.TypeReference) {
    if (typeof typeNode.typeName?.name === 'string') return typeNode.typeName.name;
    return conversionError('UNSUPPORTED_TYPE', 'Reference type requires structured type resolution', { kind: typeNode.returnType?.kind, arguments: typeNode.typeArguments?.map((type: any) => type.name) });
  }
  // The language grammar owns its primitive types; an incomplete duplicate
  // table used to silently turn actor/actorscope and other handles into int.
  if (isKeywordTypeKind(typeNode.kind)) return tokenToString(typeNode.kind)!;
  return conversionError('UNSUPPORTED_TYPE', 'Unknown Galaxy type node', { kind: typeNode.kind });
}

export function galaxyTypeToTrigger(galaxyType: string): string {
  const lower = galaxyType.toLowerCase();
  const kind = stringToToken(lower);
  return kind !== undefined && isKeywordTypeKind(kind) ? lower : galaxyType;
}

// ---------------------------------------------------------------------------
// AST utility helpers
// ---------------------------------------------------------------------------

export function unwrapParens(expr: any): any {
  let cur = expr;
  while (cur?.kind === SyntaxKind.ParenthesizedExpression) cur = cur.expression;
  return cur;
}

export function isTrueExpr(expr: any): boolean {
  return unwrapParens(expr)?.kind === SyntaxKind.TrueKeyword;
}

export function readSignedIntLiteral(expr: any): number | undefined {
  const e = unwrapParens(expr);
  if (!e) return undefined;
  if (e.kind === SyntaxKind.NumericLiteral) {
    const n = Number(e.text ?? e.value);
    return Number.isFinite(n) ? n : undefined;
  }
  if (e.kind === SyntaxKind.PrefixUnaryExpression && e.operator?.kind === SyntaxKind.MinusToken) {
    const op = e.operand;
    if (op?.kind === SyntaxKind.NumericLiteral) {
      const n = Number(op.text ?? op.value);
      return Number.isFinite(n) ? -n : undefined;
    }
  }
  return undefined;
}

export function getAssignSides(stmt: any): { left: any; right: any } | undefined {
  if (stmt?.kind !== SyntaxKind.ExpressionStatement) return undefined;
  const expr = stmt.expression;
  if (!expr || expr.kind !== SyntaxKind.BinaryExpression) return undefined;
  if ((expr.operatorToken?.kind as SyntaxKind) !== SyntaxKind.EqualsToken) return undefined;
  return { left: expr.left, right: expr.right };
}

export function getIdentifierName(expr: any): string | undefined {
  const e = unwrapParens(expr);
  if (e?.kind === SyntaxKind.Identifier) return e.name;
  return undefined;
}

/** Canonical spelling of a side-effect-free variable path: `v`, `v.f`, `v[2]`, `v[i].f`.
 * Editor loop templates write their `#PARAM(var)` target verbatim, so the iterator of a
 * recovered loop may be a record field or an array element as well as a plain variable.
 * Comparing iterators by identifier name only made every such loop fall back to a
 * synthesized `For Statement` template. A plain identifier keeps its name as the key. */
export function lvalueKey(expr: any): string | undefined {
  const e = unwrapParens(expr);
  if (e?.kind === SyntaxKind.Identifier) return e.name;
  if (e?.kind === SyntaxKind.PropertyAccessExpression) {
    const base = lvalueKey(e.expression);
    return base !== undefined && e.name?.name ? `${base}.${e.name.name}` : undefined;
  }
  if (e?.kind === SyntaxKind.ElementAccessExpression) {
    const base = lvalueKey(e.expression);
    const index = unwrapParens(e.argumentExpression);
    const indexKey = index?.kind === SyntaxKind.NumericLiteral ? String(index.text ?? index.value) : lvalueKey(index);
    return base !== undefined && indexKey !== undefined ? `${base}[${indexKey}]` : undefined;
  }
  return undefined;
}

/** Recover the Param identity embedded by the editor in
 * StringExternal("Param/Value[/lib_<id>]/<param-id>").  The localized text
 * lives in GameStrings under that identity; keeping StringExternal as an
 * ordinary nested call makes the Trigger editor show an unresolved key. */
export function localizedTextParamId(expr: any, ctx: ReverseCtx): string | undefined {
  const node = unwrapParens(expr);
  if (node?.kind !== SyntaxKind.CallExpression) return undefined;
  const callee = unwrapParens(node.expression);
  if (callee?.kind !== SyntaxKind.Identifier || callee.name !== 'StringExternal') return undefined;
  const args = Array.from(node.arguments ?? []) as any[];
  if (args.length !== 1) return undefined;
  const literal = unwrapParens(args[0]);
  if (literal?.kind !== SyntaxKind.StringLiteral) return undefined;
  const key = String(literal.value ?? literal.text ?? '');
  const bare = /^Param\/Value\/(?:lib_[A-Za-z0-9]+_)?([0-9A-Fa-f]{8})$/u.exec(key)?.[1]?.toUpperCase();
  return bare && !ctx.elements[bare] ? bare : undefined;
}

export interface FunctionSymbolIndex {
  uses: Map<string, number>;
  assignments: Map<string, number>;
  declarations: Map<string, any>;
}

const functionSymbolIndexes = new WeakMap<any[], FunctionSymbolIndex>();

/** Index lexical symbol use once per parsed function. This is used when
 * generated helper locals can be erased only after proving they have no
 * observable use outside the reconstructed TriggerData template. */
export function functionSymbolIndex(nodes: any[]): FunctionSymbolIndex {
  let cached = functionSymbolIndexes.get(nodes);
  if (cached) return cached;
  const uses = new Map<string, number>();
  const assignments = new Map<string, number>();
  const declarations = new Map<string, any>();
  const visit = (node: any): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const child of node) visit(child); return; }
    if (node.kind === SyntaxKind.Identifier) {
      uses.set(node.name, (uses.get(node.name) ?? 0) + 1);
      return;
    }
    if (node.kind === SyntaxKind.VariableDeclaration) declarations.set(node.name.name, node);
    if (node.kind === SyntaxKind.BinaryExpression && node.operatorToken?.kind === SyntaxKind.EqualsToken) {
      const name = getIdentifierName(node.left);
      if (name) assignments.set(name, (assignments.get(name) ?? 0) + 1);
    }
    for (const [key, child] of Object.entries(node)) {
      if (['parent', 'syntaxTokens', 'pos', 'end'].includes(key)) continue;
      if (key === 'name' && [SyntaxKind.VariableDeclaration, SyntaxKind.PropertyAccessExpression].includes(node.kind)) continue;
      visit(child);
    }
  };
  visit(nodes);
  cached = { uses, assignments, declarations };
  functionSymbolIndexes.set(nodes, cached);
  return cached;
}

export function isBreakGuardOnNegative(stmt: any, iteratorKey: string): boolean {
  if (stmt?.kind !== SyntaxKind.IfStatement) return false;
  const cond = unwrapParens(stmt.expression);
  if (!cond || cond.kind !== SyntaxKind.BinaryExpression) return false;
  if ((cond.operatorToken?.kind as SyntaxKind) !== SyntaxKind.LessThanToken) return false;
  if (lvalueKey(cond.left) !== iteratorKey) return false;
  if (readSignedIntLiteral(cond.right) !== 0) return false;
  const thenStmts = getBlockStatements(stmt.thenStatement);
  if (thenStmts.length !== 1) return false;
  return thenStmts[0]?.kind === SyntaxKind.BreakStatement;
}

export function isBreakGuardOnNull(stmt: any, iteratorKey: string): boolean {
  if (stmt?.kind !== SyntaxKind.IfStatement) return false;
  const cond = unwrapParens(stmt.expression);
  if (!cond || cond.kind !== SyntaxKind.BinaryExpression) return false;
  if ((cond.operatorToken?.kind as SyntaxKind) !== SyntaxKind.EqualsEqualsToken) return false;
  if (lvalueKey(cond.left) !== iteratorKey) return false;
  return unwrapParens(cond.right)?.kind === SyntaxKind.NullKeyword;
}

export function isGeneratedAutoLoopVarName(name: string | undefined): boolean {
  if (!name) return false;
  return /^auto[0-9A-Za-z]+_var$/.test(name);
}

export function getCallExprName(expr: any): string | undefined {
  const e = unwrapParens(expr);
  if (!e || e.kind !== SyntaxKind.CallExpression) return undefined;
  return getIdentifierName(e.expression);
}

export function isCallStmtNamed(stmt: any, name: string): boolean {
  return stmt?.kind === SyntaxKind.ExpressionStatement && getCallExprName(stmt.expression) === name;
}

export function parseWaitCall(stmt: any): { tExpr: any; timeTypeExpr: any } | undefined {
  if (stmt?.kind !== SyntaxKind.ExpressionStatement) return undefined;
  const call = unwrapParens(stmt.expression);
  if (!call || call.kind !== SyntaxKind.CallExpression) return undefined;
  if (getIdentifierName(call.expression) !== 'Wait') return undefined;
  const args: any[] = Array.from(call.arguments ?? []);
  if (args.length < 2) return undefined;
  return { tExpr: args[0], timeTypeExpr: args[1] };
}

export function extractNegatedConditionExpr(expr: any): any | undefined {
  const e = unwrapParens(expr);
  if (!e || e.kind !== SyntaxKind.PrefixUnaryExpression) return undefined;
  if (e.operator?.kind !== SyntaxKind.ExclamationToken) return undefined;
  return unwrapParens(e.operand);
}

export function getBlockStatements(stmt: any): any[] {
  if (!stmt) return [];
  if (stmt.kind === SyntaxKind.Block) return Array.from(stmt.statements ?? []);
  return [stmt]; // single statement (rare in practice)
}

export function stmtUsesLoopCounterVar(stmt: any, varName: string): boolean {
  if (!stmt) return false;

  if (stmt.kind === SyntaxKind.ForStatement) {
    const init = stmt.initializer;
    if (
      init?.kind === SyntaxKind.BinaryExpression &&
      (init.operatorToken?.kind as SyntaxKind) === SyntaxKind.EqualsToken &&
      init.left?.kind === SyntaxKind.Identifier &&
      init.left.name === varName
    ) {
      return true;
    }
    return stmtUsesLoopCounterVar(stmt.statement, varName);
  }

  if (stmt.kind === SyntaxKind.Block) {
    for (const s of Array.from(stmt.statements ?? [])) {
      if (stmtUsesLoopCounterVar(s, varName)) return true;
    }
    return false;
  }

  if (stmt.kind === SyntaxKind.IfStatement) {
    return stmtUsesLoopCounterVar(stmt.thenStatement, varName) ||
      stmtUsesLoopCounterVar(stmt.elseStatement, varName);
  }

  if (stmt.kind === SyntaxKind.WhileStatement || stmt.kind === SyntaxKind.DoStatement) {
    return stmtUsesLoopCounterVar(stmt.statement, varName);
  }

  return false;
}

export function isLoopCounterDeclaration(stmts: any[], declIndex: number, varName: string): boolean {
  for (let i = declIndex + 1; i < stmts.length; i++) {
    if (stmtUsesLoopCounterVar(stmts[i], varName)) return true;
  }
  return false;
}

export function forStmtUsesCounterVar(forStmt: any, counterName: string): boolean {
  if (!forStmt || forStmt.kind !== SyntaxKind.ForStatement) return false;
  const cond = forStmt.condition;
  if (cond?.kind === SyntaxKind.BinaryExpression) {
    if (getIdentifierName(cond.left) === counterName) return true;
    if (getIdentifierName(cond.right) === counterName) return true;
  }
  const incr = forStmt.incrementor;
  if (incr?.kind === SyntaxKind.BinaryExpression) {
    if (getIdentifierName(incr.left) === counterName) return true;
  }
  return false;
}

/** Deep-scans an AST subtree for an Identifier with the given name (skips parent links). */
export function exprContainsIdentifier(node: any, name: string, depth = 0): boolean {
  if (!node || typeof node !== 'object' || depth > 16) return false;
  if (node.kind === SyntaxKind.Identifier && node.name === name) return true;
  for (const key of Object.keys(node)) {
    if (key === 'parent' || key === 'pos' || key === 'end' || key === 'kind' || key === 'name') continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) if (exprContainsIdentifier(c, name, depth + 1)) return true;
    } else if (v && typeof v === 'object') {
      if (exprContainsIdentifier(v, name, depth + 1)) return true;
    }
  }
  return false;
}

/**
 * True when one of the next few statements is a ForStatement whose condition or
 * incrementor references `name`. Used to decide whether an `auto*_ae` / `auto*_ai`
 * helper assignment belongs to an upcoming loop (and must be consumed, not emitted
 * as a standalone action).
 */
export function upcomingForStmtUsesName(stmts: any[], index: number, name: string, lookahead: number = 3): boolean {
  for (let j = index + 1; j <= index + lookahead && j < stmts.length; j++) {
    const s = stmts[j];
    if (s?.kind !== SyntaxKind.ForStatement) continue;
    if (exprContainsIdentifier(s.condition, name) || exprContainsIdentifier(s.incrementor, name)) return true;
  }
  return false;
}
