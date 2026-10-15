import { describe, expect, it } from 'vitest';
import { convertGalaxyToTriggers, convertTriggersToGalaxy } from '../../../../dist/modules/triggers/services/galaxy-conversion/index.js';
import { validateGalaxyPair } from '../../../../dist/modules/triggers/services/galaxy-conversion/validation.js';
import { parseGalaxySource } from '../../../../dist/modules/triggers/services/galaxy-conversion/internal/galaxy-to-trigger.js';
import { SyntaxKind as K } from '@modkit/blizzard-starcraft2/galaxy/language-core';

// Small test evaluator for guard/assignment/call sequences. It executes the
// parsed output, so a missing startup call or a moved initializer changes the trace.
function runStartup(script: string, header: string, entryPoint: string) {
  const nodes: any[] = [...parseGalaxySource(header).statements, ...parseGalaxySource(script).statements];
  const globals = new Map<string, any>(), functions = new Map<string, any>();
  const trace: any[] = [];
  const evaluate = (node: any): any => {
    if (!node) return undefined;
    switch (node.kind) {
      case K.Identifier: return globals.get(node.name);
      case K.TrueKeyword: return true;
      case K.FalseKeyword: return false;
      case K.NumericLiteral: return Number(node.text ?? node.value);
      case K.ParenthesizedExpression: return evaluate(node.expression);
      case K.BinaryExpression: {
        const value = evaluate(node.right);
        const next = node.operatorToken.kind === K.PlusEqualsToken ? globals.get(node.left.name) + value : value;
        globals.set(node.left.name, next); return next;
      }
      case K.CallExpression: {
        const name = node.expression.name;
        if (name === 'record') { trace.push(...node.arguments.map(evaluate)); return; }
        if (name === 'seed') { const value = evaluate(node.arguments[0]); trace.push(`seed:${value}`); return value; }
        if (name === 'dependency') { trace.push('dependency'); return; }
        const fn = functions.get(name);
        if (!fn) throw new Error(`Unexpected call ${name}`);
        execute(fn.body.statements); return;
      }
      default: throw new Error(`Unsupported test expression ${node.kind}`);
    }
  };
  const execute = (statements: any[]): boolean => {
    for (const node of statements) {
      if (node.kind === K.ReturnStatement) return true;
      if (node.kind === K.IfStatement) {
        if (evaluate(node.expression) && execute(node.thenStatement.kind === K.Block ? node.thenStatement.statements : [node.thenStatement])) return true;
      } else if (node.kind === K.ExpressionStatement) evaluate(node.expression);
      else throw new Error(`Unsupported test statement ${node.kind}`);
    }
    return false;
  };
  for (const node of nodes) if (node.kind === K.FunctionDeclaration && node.body) functions.set(node.name.name, node);
  for (const node of nodes) if (node.kind === K.VariableDeclaration) globals.set(node.name.name, node.initializer ? evaluate(node.initializer) : 0);
  const entry = functions.get(entryPoint);
  if (!entry) throw new Error('Entry point disappeared');
  execute(entry.body.statements); execute(entry.body.statements);
  return trace;
}

const bundle = `
bool ready = false;
int score = 4;
void record(int value);
void dependency();
void libTEST_InitLibraries() { dependency(); }
void libTEST_InitVariables() { record(score); score = 7; }
void libTEST_InitCustomScript() { record(score); score += 1; }
void libTEST_InitTriggers() { record(score); }
void libTEST_InitLib() {
  if (ready) { return; }
  ready = true;
  libTEST_InitLibraries();
  libTEST_InitVariables();
  libTEST_InitCustomScript();
  libTEST_InitTriggers();
}`;

describe('source startup and declaration validation', () => {
  it('preserves the executed startup order and once-only guard through XML without a second root', async () => {
    const reverse = await convertGalaxyToTriggers({ libraryId: 'TEST', script: bundle, header: '' });
    const forward = await convertTriggersToGalaxy(reverse.output.triggerData, {});
    expect(forward.output.initialization).toEqual({ mode: 'preserve', entryPoint: 'libTEST_InitLib' });
    expect(forward.output.script).not.toMatch(/void libTEST_Init\w+_1\(/u);
    expect(runStartup(forward.output.script, forward.output.header, 'libTEST_InitLib')).toEqual(runStartup(bundle, '', 'libTEST_InitLib'));
    expect(runStartup(forward.output.script, forward.output.header, 'libTEST_InitLib')).toEqual(['dependency', 4, 7, 8]);
    expect(reverse.fidelity.verification.semanticModelExact).toBe(true);
    expect(reverse.output.triggerData).not.toContain('Type="CustomScript"');
  });

  // A map can define trigger libraries of its own (<Library Id="1"> in its Triggers); the editor
  // compiles each into MapScript.galaxy under its lib<Id>_ prefix, and InitMap only calls InitLibs
  // when the map has no triggers of its own (AllRacesTester, KeyStone).
  it('keeps a library the map defines itself as a Library of its Triggers and compiles it back into the map script', async () => {
    const source = `
      int libQ_gv_value;
      bool libQ_InitVariables_completed = false;
      bool libQ_InitLib_completed = false;
      void libQ_InitLibraries() { libNtve_InitVariables(); }
      void libQ_InitVariables() {
        if (libQ_InitVariables_completed) { return; }
        libQ_InitVariables_completed = true;
        libQ_gv_value = 5;
      }
      void libQ_InitTriggers() {}
      void libQ_InitLib() {
        if (libQ_InitLib_completed) { return; }
        libQ_InitLib_completed = true;
        libQ_InitLibraries();
        libQ_InitVariables();
        libQ_InitTriggers();
      }
      void InitLibs() { libNtve_InitLib(); libQ_InitLib(); }
      void InitMap() { InitLibs(); }
    `;
    const reverse = await convertGalaxyToTriggers({
      libraryId: 'Map', documentKind: 'map', script: source, header: '',
    });

    expect(reverse.output.generationOptions).toBeUndefined();
    expect(reverse.output.triggerData).toContain('<Library Id="Q">');
    expect(reverse.fidelity.diagnostics.some((item: any) => item.code === 'sc2-triggers/embedded-library')).toBe(true);
    expect(reverse.fidelity.diagnostics.some((item: any) => item.code === 'sc2-triggers/startup-libraries-differ')).toBe(false);
    const forward = await convertTriggersToGalaxy(reverse.output.triggerData, {
      libraryId: 'Map', documentKind: 'map', triggerStrings: reverse.output.triggerStrings,
    });
    const program = `${forward.output.header}\n${forward.output.script}`;
    expect(program).toContain('int libQ_gv_value;');
    expect(program).toMatch(/void libQ_InitLib \(\) \{/u);
    expect(program).toContain('libQ_gv_value = 5;');
    expect(program).not.toContain('include "LibQ');
    expect(forward.output.script).toMatch(/void InitLibs \(\) \{\s*libNtve_InitLib\(\);\s*libQ_InitLib\(\);\s*\}/u);
    expect(forward.output.script).toMatch(/void InitMap \(\) \{\s*InitLibs\(\);\s*\}/u);
  });

  // The map's own content and a library of its own in one document: the map's trigger calls the
  // library's function by reference, and the map's Galaxy carries both.
  it('keeps the map\'s own trigger beside the library it defines and binds the trigger\'s call into it', async () => {
    const source = `
      int libQ_gv_value;
      bool libQ_InitVariables_completed = false;
      bool libQ_InitLib_completed = false;
      void libQ_gf_Remember(int lp_amount) { libQ_gv_value = lp_amount; }
      void libQ_InitLibraries() { libNtve_InitVariables(); }
      void libQ_InitVariables() {
        if (libQ_InitVariables_completed) { return; }
        libQ_InitVariables_completed = true;
        libQ_gv_value = 5;
      }
      void libQ_InitTriggers() {}
      void libQ_InitLib() {
        if (libQ_InitLib_completed) { return; }
        libQ_InitLib_completed = true;
        libQ_InitLibraries();
        libQ_InitVariables();
        libQ_InitTriggers();
      }
      trigger gt_Start;
      bool gt_Start_Func(bool testConds, bool runActions) {
        if (!runActions) { return true; }
        libQ_gf_Remember(7);
        return true;
      }
      void gt_Start_Init() { gt_Start = TriggerCreate("gt_Start_Func"); }
      void InitLibs() { libNtve_InitLib(); libQ_InitLib(); }
      void InitTriggers() { gt_Start_Init(); }
      void InitMap() { InitLibs(); InitTriggers(); }
    `;
    const galaxyDeclarations = [{ fileName: 'natives.galaxy', text: 'trigger TriggerCreate(string name);' }];
    const reverse = await convertGalaxyToTriggers({ libraryId: 'Map', documentKind: 'map', script: source, header: '', galaxyDeclarations });

    expect(reverse.output.generationOptions).toBeUndefined();
    expect(reverse.output.typeCounts.Trigger).toBe(1);
    const [own, library] = reverse.output.triggerData.split('<Library Id="Q">');
    expect(own).toContain('<Element Type="Trigger"');
    expect(library).toContain('<Identifier>Remember</Identifier>');
    expect(own).toMatch(/<FunctionDef Type="FunctionDef" Library="Q" Id="[0-9A-F]+"\/>/u);
    const forward = await convertTriggersToGalaxy(reverse.output.triggerData, {
      libraryId: 'Map', documentKind: 'map', triggerStrings: reverse.output.triggerStrings, galaxyDeclarations,
    });
    const program = `${forward.output.header}\n${forward.output.script}`;
    expect(program).toMatch(/void libQ_gf_Remember \(int lp_amount\) \{/u);
    expect(program).toContain('libQ_gf_Remember(7);');
    expect(forward.output.script).toMatch(/void InitLibs \(\) \{\s*libNtve_InitLib\(\);\s*libQ_InitLib\(\);\s*\}/u);
    expect(forward.output.script).toMatch(/void InitMap \(\) \{\s*InitLibs\(\);\s*InitTriggers\(\);\s*\}/u);
    expect(program.indexOf('void libQ_gf_Remember')).toBeLessThan(program.indexOf('bool gt_Start_Func'));
  });

  it('keeps one startup for a library without triggers that the map defines itself', async () => {
    const source = `${libraryWithoutTriggers('1')}
      void InitLibs() { libNtve_InitLib(); lib1_InitLib(); }
      void InitMap() { InitLibs(); }
    `;
    const reverse = await convertGalaxyToTriggers({ libraryId: 'Map', documentKind: 'map', script: source, header: '' });
    expect(reverse.output.triggerData).toContain('<Library Id="1">');
    const forward = await convertTriggersToGalaxy(reverse.output.triggerData, {
      libraryId: 'Map', documentKind: 'map', triggerStrings: reverse.output.triggerStrings,
    });
    const program = `${forward.output.header}\n${forward.output.script}`;
    expect(program.match(/bool lib1_InitLib_completed\b/gu)).toHaveLength(1);
    expect(program.match(/bool lib1_InitVariables_completed\b/gu)).toHaveLength(1);
    expect(program).not.toMatch(/lib1_Init\w*_\d+\b/u);
    expect(forward.fidelity.diagnostics.filter((item: any) => item.code === 'sc2-triggers/galaxy-duplicate-definition')).toEqual([]);
  });

  // Editor output (34-PartAndParcelOriginal): an empty library the map defines calls the InitVariables
  // of a library nothing in it references. The map starts that library first, so the call is a no-op
  // that need not come back; started after it, the call keeps the startup as written.
  it.each([
    ['starts that library first', 'libNtve_InitLib(); libARRA_InitLib(); lib1_InitLib();', true],
    ['starts that library after it', 'libNtve_InitLib(); lib1_InitLib(); libARRA_InitLib();', false],
  ])('folds a map library whose InitLibraries calls an unreferenced library when the map %s', async (_order, initLibs, folded) => {
    const source = `
      void lib1_InitLibraries() { libNtve_InitVariables(); libARRA_InitVariables(); }
      bool lib1_InitLib_completed = false;
      void lib1_InitLib() {
        if (lib1_InitLib_completed) { return; }
        lib1_InitLib_completed = true;
        lib1_InitLibraries();
      }
      void InitLibs() { ${initLibs} }
      void InitMap() { InitLibs(); }
    `;
    const reverse = await convertGalaxyToTriggers({ libraryId: 'Map', documentKind: 'map', script: source, header: '' });
    const codes = reverse.fidelity.diagnostics.map((item: any) => item.code);
    expect(reverse.output.triggerData.includes('<Library Id="1">')).toBe(folded);
    expect(codes.includes('sc2-triggers/embedded-library-kept')).toBe(!folded);
    if (folded) {
      expect(reverse.fidelity.diagnostics.find((item: any) => item.code === 'sc2-triggers/startup-dependency-calls-dropped')?.details)
        .toEqual({ libraryId: '1', libraries: ['ARRA'] });
    }
    const forward = await convertTriggersToGalaxy(reverse.output.triggerData, {
      libraryId: 'Map', documentKind: 'map', triggerStrings: reverse.output.triggerStrings, ...reverse.output.generationOptions,
    });
    const program = `${forward.output.header}\n${forward.output.script}`;
    expect(program.match(/void lib1_InitLib \(\) \{/gu)).toHaveLength(1);
  });

  // A custom script stage is not regenerated from the model, so such a library keeps its startup as
  // written, and the map's Triggers cannot say so for one library: the map stays one document.
  it('converts a map whole when a library it defines keeps its startup as written', async () => {
    const source = `
      bool libQ_InitVariables_completed = false;
      bool libQ_InitLib_completed = false;
      void libQ_InitLibraries() { libNtve_InitVariables(); }
      void libQ_InitVariables() {
        if (libQ_InitVariables_completed) { return; }
        libQ_InitVariables_completed = true;
      }
      void libQ_Start() {}
      void libQ_InitLib() {
        if (libQ_InitLib_completed) { return; }
        libQ_InitLib_completed = true;
        libQ_InitLibraries();
        libQ_InitVariables();
        libQ_Start();
      }
      void InitLibs() { libNtve_InitLib(); libQ_InitLib(); }
      void InitMap() { InitLibs(); }
    `;
    const reverse = await convertGalaxyToTriggers({ libraryId: 'Map', documentKind: 'map', script: source, header: '' });
    expect(reverse.output.triggerData).not.toContain('<Library Id="Q">');
    expect(reverse.fidelity.diagnostics.some((item: any) => item.code === 'sc2-triggers/embedded-library-kept')).toBe(true);
    const forward = await convertTriggersToGalaxy(reverse.output.triggerData, {
      libraryId: 'Map', documentKind: 'map', triggerStrings: reverse.output.triggerStrings, ...reverse.output.generationOptions,
    });
    const program = `${forward.output.header}\n${forward.output.script}`;
    expect(program.match(/void libQ_InitLib \(\) \{/gu)).toHaveLength(1);
    expect(program.match(/bool libQ_InitLib_completed\b/gu)).toHaveLength(1);
  });

  // Editor oracle (Rainbow Arena, library 1): a library's custom script sits between its
  // InitVariables and its InitCustomScript under the author's own names, and the stage calls
  // the initialization function of each CustomScript element (`initMD5();`).
  it('converts a library the map defines with a custom script stage as its own library', async () => {
    const source = `
      bool libQ_InitVariables_completed = false;
      bool libQ_InitLib_completed = false;
      void libQ_InitLibraries() { libNtve_InitVariables(); }
      void libQ_InitVariables() {
        if (libQ_InitVariables_completed) { return; }
        libQ_InitVariables_completed = true;
      }
      int md5Rounds;
      void initMD5() { md5Rounds = 64; }
      void libQ_InitCustomScript() { initMD5(); }
      void libQ_InitLib() {
        if (libQ_InitLib_completed) { return; }
        libQ_InitLib_completed = true;
        libQ_InitLibraries();
        libQ_InitVariables();
        libQ_InitCustomScript();
      }
      void InitLibs() { libNtve_InitLib(); libQ_InitLib(); }
      void InitMap() { InitLibs(); }
    `;
    const reverse = await convertGalaxyToTriggers({ libraryId: 'Map', documentKind: 'map', script: source, header: '' });
    expect(reverse.output.generationOptions).toBeUndefined();
    expect(reverse.fidelity.diagnostics.some((item: any) => item.code === 'sc2-triggers/embedded-library-kept')).toBe(false);
    const library = reverse.output.triggerData.slice(reverse.output.triggerData.indexOf('<Library Id="Q">'));
    expect(library).toContain('<InitFunc>initMD5</InitFunc>');
    expect(library).toContain('<Identifier>initMD5</Identifier>');
    const forward = await convertTriggersToGalaxy(reverse.output.triggerData, {
      libraryId: 'Map', documentKind: 'map', triggerStrings: reverse.output.triggerStrings,
    });
    const program = `${forward.output.header}\n${forward.output.script}`;
    expect(program.match(/void libQ_InitCustomScript \(\) \{\s*initMD5\(\);\s*\}/gu)).toHaveLength(1);
    expect(program).toMatch(/libQ_InitVariables\(\);\s*libQ_InitCustomScript\(\);\s*\}/u);
    expect(program.match(/void initMD5 \(\) \{/gu)).toHaveLength(1);
  });

  // Editor oracle (EditorTest.SC2Mod, LibCAI2): a CustomScript of two includes and no
  // initialization function. The editor writes its includes after InitVariables and an
  // empty InitCustomScript right after them; the includes were dropped.
  it('keeps the includes of a custom script and folds its empty stage', async () => {
    const script = `include "TriggerLibs/NativeLib"
include "LibQ_h"
void libQ_InitLibraries () {
    libNtve_InitVariables();
}
bool libQ_InitVariables_completed = false;
void libQ_InitVariables () {
    if (libQ_InitVariables_completed) {
        return;
    }
    libQ_InitVariables_completed = true;
    libQ_gv_count = 1;
}
include "TriggerLibs/nod/nodai"
include "TriggerLibs/cnc/requirementsai"
void libQ_InitCustomScript () {
}
bool libQ_InitLib_completed = false;
void libQ_InitLib () {
    if (libQ_InitLib_completed) {
        return;
    }
    libQ_InitLib_completed = true;
    libQ_InitLibraries();
    libQ_InitVariables();
    libQ_InitCustomScript();
}
`;
    const header = 'include "TriggerLibs/natives"\nint libQ_gv_count;\nvoid libQ_InitLib ();\n';
    const reverse = await convertGalaxyToTriggers({ libraryId: 'Q', documentKind: 'library', script, header });
    expect(reverse.output.generationOptions).toBeUndefined();
    expect(reverse.output.triggerData).toMatch(/<ScriptCode>\s*include "TriggerLibs\/nod\/nodai"\s*include "TriggerLibs\/cnc\/requirementsai"\s*<\/ScriptCode>/u);
    const forward = await convertTriggersToGalaxy(reverse.output.triggerData, { libraryId: 'Q', triggerStrings: reverse.output.triggerStrings });
    expect(forward.output.script).toMatch(/libQ_gv_count = 1;\s*\}\s*include "TriggerLibs\/nod\/nodai"\s*include "TriggerLibs\/cnc\/requirementsai"\s*void libQ_InitCustomScript \(\) \{\s*\}/u);
    expect(forward.output.script).toMatch(/libQ_InitVariables\(\);\s*libQ_InitCustomScript\(\);\s*\}/u);
    expect(forward.output.script.match(/void libQ_InitCustomScript \(/gu)).toHaveLength(1);
  });

  // Editor oracle (EditorTest.SC2Mod CCEM and 11 more corpus libraries): a library whose elements
  // reference no other library, Ntve included, includes TriggerLibs/natives and has no InitLibraries.
  // Only a loaded native library tells that its elements do not use it.
  const nativeLibrary = { triggerData: '<TriggerData>\n    <Library Id="Ntve">\n    </Library>\n</TriggerData>\n' };
  it('writes a library that uses no other library with the natives include and no InitLibraries', async () => {
    const empty = '<TriggerData>\n    <Library Id="Q">\n    </Library>\n</TriggerData>\n';
    const forward = await convertTriggersToGalaxy(empty, { libraryId: 'Q', dependencyLibraries: [nativeLibrary] });
    expect(forward.output.script).toMatch(/^(?:\/\/[^\n]*\n)*include "TriggerLibs\/natives"\s*include "LibQ_h"/u);
    expect(forward.output.script).not.toContain('InitLibraries');
    expect(forward.output.script).toMatch(/libQ_InitLib_completed = true;\s*\}/u);
    const unloaded = await convertTriggersToGalaxy(empty, { libraryId: 'Q' });
    expect(unloaded.output.script).toMatch(/libQ_InitLib_completed = true;\s*libQ_InitLibraries\(\);\s*\}/u);
  });

  // Editor oracle (AllRaces2-AI.SC2Mod, LibB09742AC): a library whose one CustomScript includes the AI
  // libraries. Its custom script follows its header include directly.
  it('folds the startup of a library with custom script only', async () => {
    const script = `include "TriggerLibs/natives"
include "LibQ_h"
include "TriggerLibs/DebugAI"
include "TriggerLibs/MeleeAI"
void libQ_InitCustomScript () {
}
bool libQ_InitLib_completed = false;
void libQ_InitLib () {
    if (libQ_InitLib_completed) {
        return;
    }
    libQ_InitLib_completed = true;
    libQ_InitCustomScript();
}
`;
    const reverse = await convertGalaxyToTriggers({ libraryId: 'Q', documentKind: 'library', script, header: 'include "TriggerLibs/natives"\n', dependencyLibraries: [nativeLibrary] });
    expect(reverse.output.generationOptions).toBeUndefined();
    const forward = await convertTriggersToGalaxy(reverse.output.triggerData, { libraryId: 'Q', triggerStrings: reverse.output.triggerStrings, dependencyLibraries: [nativeLibrary] });
    expect(forward.output.script).toMatch(/include "TriggerLibs\/natives"\s*include "LibQ_h"\s*include "TriggerLibs\/DebugAI"\s*include "TriggerLibs\/MeleeAI"\s*void libQ_InitCustomScript \(\) \{\s*\}/u);
    expect(forward.output.script).toMatch(/libQ_InitLib_completed = true;\s*libQ_InitCustomScript\(\);\s*\}/u);
    expect(forward.output.script).not.toContain('InitLibraries');
  });

  // Editor output (19-HotCargo): a custom script that includes libraries before any declaration of the map.
  // Its banner ends the editor's own includes; taken for them, TriggerLibs/AI and Computer were dropped.
  it('keeps the includes of a custom script that precedes every declaration', async () => {
    const script = [
      'include "TriggerLibs/natives"', '',
      '//--------------------------------------------------------------------------------------------------',
      '// Custom Script: Triggers',
      '//--------------------------------------------------------------------------------------------------',
      'include "TriggerLibs/AI"', 'include "TriggerLibs/Computer"',
      'void gf_Go () {', '}', '',
    ].join('\n');
    const reverse = await convertGalaxyToTriggers({ libraryId: 'Map', documentKind: 'map', script, header: '' });
    expect(reverse.output.triggerData).toMatch(/<ScriptCode>\s*include "TriggerLibs\/AI"\s*include "TriggerLibs\/Computer"\s*<\/ScriptCode>/u);
    expect(reverse.output.triggerData).not.toMatch(/include "TriggerLibs\/natives"/u);
  });

  // Editor oracle (City of Tempest): InitMap calls InitCustomScript between InitGlobals and
  // InitTriggers; the startup was kept as written, a second InitCustomScript beside the editor's.
  it('folds a map startup with a custom script stage', async () => {
    const source = `
      int gv_count;
      void setUp() { gv_count = 2; }
      void InitLibs() { libNtve_InitLib(); }
      void InitGlobals() { gv_count = 1; }
      void InitCustomScript() { setUp(); }
      void InitTriggers() {}
      void InitMap() { InitLibs(); InitGlobals(); InitCustomScript(); InitTriggers(); }
    `;
    const reverse = await convertGalaxyToTriggers({ libraryId: 'Map', documentKind: 'map', script: source, header: '' });
    expect(reverse.output.generationOptions).toBeUndefined();
    expect(reverse.output.triggerData).toContain('<InitFunc>setUp</InitFunc>');
    const forward = await convertTriggersToGalaxy(reverse.output.triggerData, { libraryId: 'Map', documentKind: 'map', triggerStrings: reverse.output.triggerStrings });
    expect(forward.output.script.match(/void InitCustomScript \(\) \{\s*setUp\(\);\s*\}/gu)).toHaveLength(1);
    expect(forward.output.script).toMatch(/InitLibs\(\);\s*InitGlobals\(\);\s*InitCustomScript\(\);\s*InitTriggers\(\);/u);
  });

  // The editor writes InitLibs from the libraries the elements reference; a map
  // startup is folded even when InitLibs names libraries of other packages.
  it('folds a map startup that initializes other packages and reports InitLib calls it cannot regenerate', async () => {
    const source = `
      void InitLibs() { libNtve_InitLib(); libARRA_InitLib(); libCOMI_InitLib(); }
      void InitGlobals() {}
      void InitTriggers() {}
      void InitMap() { InitLibs(); InitGlobals(); InitTriggers(); }
    `;
    const reverse = await convertGalaxyToTriggers({ libraryId: 'Map', documentKind: 'map', script: source, header: '' });
    expect(reverse.output.generationOptions).toBeUndefined();
    expect(reverse.output.triggerData).not.toContain('<Identifier>InitLibs</Identifier>');
    expect(reverse.output.triggerData).not.toContain('ScriptCode');
    expect(reverse.fidelity.diagnostics.find((item: any) => item.code === 'sc2-triggers/startup-libraries-differ')?.details)
      .toEqual({ source: ['Ntve', 'ARRA', 'COMI'], regenerated: ['Ntve'] });
    const forward = await convertTriggersToGalaxy(reverse.output.triggerData, { libraryId: 'Map', documentKind: 'map' });
    expect(forward.output.script.match(/void InitLibs \(/gu)).toHaveLength(1);
    expect(forward.output.script).not.toContain('libARRA_InitLib();');
  });

  it('folds a map startup whose external InitLib call the elements reference, and writes the call again', async () => {
    const dependency = { triggerData: '<TriggerData><Library Id="OTHER"><Element Type="FunctionDef" Id="00000007"><Identifier>Help</Identifier><FlagAction/></Element></Library></TriggerData>' };
    const source = `
      void InitLibs() { libNtve_InitLib(); libOTHER_InitLib(); }
      void gf_Perform() { libOTHER_gf_Help(); }
      void InitTriggers() {}
      void InitMap() { InitLibs(); InitTriggers(); }
    `;
    const reverse = await convertGalaxyToTriggers({ libraryId: 'Map', documentKind: 'map', script: source, header: '', dependencyLibraries: [dependency] });
    expect(reverse.output.generationOptions).toBeUndefined();
    expect(reverse.output.triggerData).not.toContain('ScriptCode');
    expect(reverse.fidelity.diagnostics.some((item: any) => item.code === 'sc2-triggers/startup-libraries-differ')).toBe(false);
    const forward = await convertTriggersToGalaxy(reverse.output.triggerData, { libraryId: 'Map', documentKind: 'map', dependencyLibraries: [dependency] });
    expect(forward.output.script).toMatch(/void InitLibs \(\) \{\s*libNtve_InitLib\(\);\s*libOTHER_InitLib\(\);\s*\}/u);
  });

  // Editor oracle (UEDFL Ouroboros AIGiveMinerals, Mercs Episode 1 Height): a trigger with conditions
  // and no actions has no runActions guard. Refused, its callback and initializer stayed ordinary
  // functions, and the map kept its whole startup as written.
  it('restores a trigger with conditions and no actions and folds the startup that initializes it', async () => {
    const source = `
      trigger gt_Watch;
      bool gv_ready;
      trigger TriggerCreate(string name);
      bool gt_Watch_Func (bool testConds, bool runActions) {
        // Automatic Variable Declarations
        // Conditions
        if (testConds) {
          if (!((gv_ready == true))) {
            return false;
          }
        }

        return true;
      }
      void gt_Watch_Init () {
        gt_Watch = TriggerCreate("gt_Watch_Func");
      }
      void InitLibs() { libNtve_InitLib(); }
      void InitGlobals() {}
      void InitTriggers() { gt_Watch_Init(); }
      void InitMap() { InitLibs(); InitGlobals(); InitTriggers(); }
    `;
    const reverse = await convertGalaxyToTriggers({ libraryId: 'Map', documentKind: 'map', script: source, header: '' });
    expect(reverse.output.typeCounts.Trigger).toBe(1);
    expect(reverse.output.generationOptions).toBeUndefined();
    const forward = await convertTriggersToGalaxy(reverse.output.triggerData, { libraryId: 'Map', documentKind: 'map' });
    const script = forward.output.script;
    const callback = script.slice(script.indexOf('bool gt_Watch_Func'), script.indexOf('void gt_Watch_Init'));
    expect(callback).toMatch(/if \(testConds\) \{\s*if \(!\(+gv_ready == true\)+\) \{\s*return false;\s*\}\s*\}\s*return true;\s*\}/u);
    expect(callback).not.toContain('!runActions');
    expect(script).toMatch(/void InitTriggers \(\) \{\s*gt_Watch_Init\(\);\s*\}/u);
  });

  // A statement after the conditions is an action the editor would put behind a runActions guard
  // (SkyFall's hand-written COOP_Init callbacks): that callback is not the editor's.
  it('keeps a callback with actions but no runActions guard as the functions it is', async () => {
    const source = `
      trigger gt_Watch;
      bool gv_ready;
      trigger TriggerCreate(string name);
      bool gt_Watch_Func (bool testConds, bool runActions) {
        if (testConds) {
          if (!((gv_ready == true))) {
            return false;
          }
        }
        gv_ready = false;
        return true;
      }
      void gt_Watch_Init () {
        gt_Watch = TriggerCreate("gt_Watch_Func");
      }
    `;
    const reverse = await convertGalaxyToTriggers({ libraryId: 'Map', documentKind: 'map', script: source, header: '' });
    expect(reverse.output.typeCounts.Trigger ?? 0).toBe(0);
  });

  // Editor oracle (Унитазофoбия, an achievement library the map defines): a library without triggers
  // has no trigger stage, so its InitLib calls InitLibraries and InitVariables alone. Left unrecognized,
  // the startup became ordinary functions next to a second, generated InitLib.
  const libraryWithoutTriggers = (id: string) => `
      bool lib${id}_gv_done;
      void lib${id}_InitLibraries() { libNtve_InitVariables(); }
      bool lib${id}_InitVariables_completed = false;
      void lib${id}_InitVariables() {
        if (lib${id}_InitVariables_completed) { return; }
        lib${id}_InitVariables_completed = true;
      }
      void lib${id}_gf_Finish() { lib${id}_gv_done = true; }
      bool lib${id}_InitLib_completed = false;
      void lib${id}_InitLib() {
        if (lib${id}_InitLib_completed) { return; }
        lib${id}_InitLib_completed = true;
        lib${id}_InitLibraries();
        lib${id}_InitVariables();
      }
    `;

  it('folds a library startup without a trigger stage and writes none back', async () => {
    const reverse = await convertGalaxyToTriggers({ libraryId: 'Q', documentKind: 'library', script: libraryWithoutTriggers('Q'), header: '' });
    expect(reverse.output.generationOptions).toBeUndefined();
    const forward = await convertTriggersToGalaxy(reverse.output.triggerData, { libraryId: 'Q', triggerStrings: reverse.output.triggerStrings });
    expect(forward.output.script).toMatch(/void libQ_InitLib \(\) \{[^}]*\}\s*libQ_InitLib_completed = true;\s*libQ_InitLibraries\(\);\s*libQ_InitVariables\(\);\s*\}/u);
    expect(forward.output.script).not.toContain('InitTriggers');
    expect(forward.output.script.match(/void libQ_InitLib \(/gu)).toHaveLength(1);
  });

  it('does not request preserve after folding a generated library startup in semantic mode', async () => {
    const source = `
      bool libQ_InitVariables_completed = false;
      bool libQ_InitLib_completed = false;
      void libQ_InitLibraries() { libNtve_InitVariables(); }
      void libQ_InitVariables() {
        if (libQ_InitVariables_completed) { return; }
        libQ_InitVariables_completed = true;
      }
      void libQ_InitTriggers() {}
      void libQ_InitLib() {
        if (libQ_InitLib_completed) { return; }
        libQ_InitLib_completed = true;
        libQ_InitLibraries(); libQ_InitVariables(); libQ_InitTriggers();
      }
    `;
    const reverse = await convertGalaxyToTriggers({ libraryId: 'Q', verification: 'semantic', script: source, header: '' });
    expect(reverse.output.generationOptions).toBeUndefined();
    const forward = await convertTriggersToGalaxy(reverse.output.triggerData, reverse.output.generationOptions);
    expect(forward.output.script).toContain('void libQ_InitLib ()');
  });

  it('retains a custom Galaxy global identifier instead of adding gv_', async () => {
    const source = 'string cai_playerAI; void cai_start(string ai) { cai_playerAI = ai; }';
    const reverse = await convertGalaxyToTriggers({ libraryId: 'Map', documentKind: 'map', verification: 'semantic', script: source, header: '' });
    const forward = await convertTriggersToGalaxy(reverse.output.triggerData, reverse.output.generationOptions);
    expect(forward.output.script).toContain('cai_playerAI = lp_ai;');
    expect(forward.output.script).not.toContain('gv_cai_playerAI');
  });

  it('honors an explicit preserve request for a structurally recognizable map startup', async () => {
    const source = `
      void libQ_InitLibraries() {}
      void libQ_InitVariables() {}
      void libQ_InitTriggers() {}
      bool libQ_InitLib_completed = false;
      void libQ_InitLib() {
        if (libQ_InitLib_completed) { return; }
        libQ_InitLib_completed = true;
        libQ_InitLibraries(); libQ_InitVariables(); libQ_InitTriggers();
      }
      void InitLibs() { libQ_InitLib(); }
      void InitMap() { InitLibs(); }
    `;
    const reverse = await convertGalaxyToTriggers({
      libraryId: 'Map', documentKind: 'map', initialization: 'preserve', script: source, header: '',
    });

    expect(reverse.output.generationOptions).toEqual({ initialization: 'preserve', entryPoint: 'InitMap' });
    expect(reverse.output.triggerData).toContain('<Identifier>InitMap</Identifier>');
  });

  it.each(['LaunchScenario', 'BeginUserCode'])('keeps an explicitly chosen arbitrary entry point %s', async entryPoint => {
    const script = `int score = 4; void record(int value); void ${entryPoint}() { record(score); score += 1; }`;
    const reverse = await convertGalaxyToTriggers({ libraryId: 'TEST', script, header: '', entryPoint });
    expect(reverse.output.generationOptions).toEqual({ initialization: 'preserve', entryPoint });
    const forward = await convertTriggersToGalaxy(reverse.output.triggerData, reverse.output.generationOptions);
    expect(forward.output.script).not.toContain('libTEST_InitLib');
    expect(runStartup(forward.output.script, forward.output.header, entryPoint)).toEqual([4, 5]);
  });

  it('returns a generation contract for a utility script without inventing an entry point', async () => {
    const reverse = await convertGalaxyToTriggers({ libraryId: 'TEST', script: 'int value(){ return 3; }', header: '' });
    expect(reverse.output.generationOptions).toEqual({ initialization: 'preserve' });
    const forward = await convertTriggersToGalaxy(reverse.output.triggerData, reverse.output.generationOptions);
    expect(forward.output.script).not.toContain('InitLib');
    expect(forward.output.script).toContain('return 3;');
  });

  it('retains global initializer evaluation order across sorted XML elements', async () => {
    const script = 'int seed(int value); void record(int value); int z = seed(1); int a = seed(2); void Launch(){ record(z); record(a); }';
    const reverse = await convertGalaxyToTriggers({ libraryId: 'TEST', script, header: '', entryPoint: 'Launch' });
    const forward = await convertTriggersToGalaxy(reverse.output.triggerData, reverse.output.generationOptions);
    expect(runStartup(forward.output.script, forward.output.header, 'Launch')).toEqual(runStartup(script, '', 'Launch'));
    expect(runStartup(forward.output.script, forward.output.header, 'Launch')).toEqual(['seed:1', 'seed:2', 1, 2, 1, 2]);
  });

  it.each(['missing', 'wrong', 'parameterized'])('rejects an invalid entry point %s', entryPoint => {
    return expect(convertGalaxyToTriggers({ libraryId: 'TEST', script: 'int wrong(){ return 1; } void parameterized(int x){}', header: '', entryPoint }))
      .rejects.toMatchObject({ context: { conversionCode: 'INITIALIZATION_SIGNATURE' } });
  });

  const check = (script: string, header = '', declarations: any[] = [], strict = false) => validateGalaxyPair([
    { fileName: 'library_h.galaxy', text: header }, { fileName: 'library.galaxy', text: script },
  ], declarations, strict);

  it('resolves a script against its header and explicitly supplied declarations', () => {
    const result = check('int run(){ return External(value); }', 'int value = 7; int run();', [{ fileName: 'dependency.galaxy', text: 'native int External(int input);' }]);
    expect(result.diagnostics).toEqual([]);
    expect(result.verification.status).toBe('passed');
  });

  // Editor output (a campaign map, KeyStone): a literal on the left of a comparison was reported as
  // "Cannot compare 'string' with 'string'" in both the source and the regenerated script.
  it('accepts a comparison whose left side is a literal of the other side\'s type', () => {
    const result = check(`
      bool run(string lp_text, int lp_count) {
        if (("Marine" == gv_name[1])) { return true; }
        if (((28.5 * 60.0) < Time())) { return true; }
        if ((3 < lp_count)) { return true; }
        return ("Zealot" != lp_text);
      }`, 'string[4] gv_name; fixed Time();');
    expect(result.diagnostics).toEqual([]);
  });

  it.each([
    ['void run(){ target(); }', 'void target(int x);', 'galaxy-call-arity'],
    ['void run(){ target("bad"); }', 'void target(int x);', 'galaxy-type-mismatch'],
    ['int run(){ return 3; }', 'bool run();', 'galaxy-signature-conflict'],
    ['void run(){ target(); }', 'int target;', 'galaxy-not-callable'],
    ['void run(){ value = 2; }', 'const int value = 1;', 'galaxy-constant-write'],
    ['void run(){} void run(){}', '', 'galaxy-duplicate-definition'],
  ])('reports a declaration-backed error: %s', (script, header, code) => {
    const result = check(script, header);
    expect(result.verification.status).toBe('failed');
    expect(result.diagnostics.some(d => d.code === `sc2-triggers/${code}`)).toBe(true);
  });

  it('checks nested arguments even when the outer function is unknown', () => {
    const result = check('void run(){ unknownOuter(unknownInner(missingValue)); }');
    expect(result.verification.unresolvedSymbols).toEqual(['missingValue', 'unknownInner', 'unknownOuter']);
    expect(result.verification.status).toBe('incomplete');
    expect(result.diagnostics.every(d => d.severity === 'warning')).toBe(true);
    expect(check('void run(){ missing(); }', '', [], true).verification.status).toBe('failed');
  });

  it('handles block scopes, structure members, and symbolic array lengths', () => {
    const valid = check('void run(){ int[capacity] values; Data data; values[0] = data.value; }', 'const int capacity = 2; struct Data { int value; };');
    expect(valid.diagnostics).toEqual([]);
    const bad = check('void run(){ { int local = 1; } consume(local); }', 'void consume(int x);');
    expect(bad.verification.unresolvedSymbols).toEqual(['local']);
    expect(check('int[missing] values;').verification.unresolvedSymbols).toEqual(['missing']);
  });

  it('surfaces known signature errors through the public forward operation', async () => {
    const reverse = await convertGalaxyToTriggers({ libraryId: 'TEST', script: 'void run(){ External("bad"); }', header: '' });
    const result = await convertTriggersToGalaxy(reverse.output.triggerData, {
      ...reverse.output.generationOptions, galaxyDeclarations: [{ fileName: 'native.galaxy', text: 'void External(int value);' }],
    });
    expect(result.fidelity.completeness).toBe('partial');
    expect(result.fidelity.verification.galaxyValidation.status).toBe('failed');
    expect(result.fidelity.diagnostics.some(d => d.code === 'sc2-triggers/galaxy-type-mismatch')).toBe(true);
  });

  const callback = (prefix: string) => `trigger libTEST_gt_Run;
    trigger TriggerCreate(string name); int seed(int value); void record(int value);
    bool libTEST_gt_Run_Func(bool testConds, bool runActions) {
      int first; int second; ${prefix}
      if (testConds) { if (!(second == 5)) { return false; } }
      if (!runActions) { return true; }
      record(second); return true;
    }
    void libTEST_gt_Run_Init(){ libTEST_gt_Run = TriggerCreate("libTEST_gt_Run_Func"); }`;

  it('binds GUI conditions to locals initialized before either callback guard', async () => {
    const result = await convertGalaxyToTriggers({ libraryId: 'TEST', script: callback('first = seed(5); second = first;'), header: '' });
    const forward = await convertTriggersToGalaxy(result.output.triggerData, result.output.generationOptions);
    expect(result.output.typeCounts.Trigger).toBe(1);
    expect(result.fidelity.verification.galaxyValidation.lostSourceBindings).toEqual([]);
    expect(forward.fidelity.verification.galaxyValidation.status).toBe('passed');
    const body = forward.output.script.slice(forward.output.script.indexOf('bool libTEST_gt_Run_Func'));
    expect(body.indexOf('= seed(5);')).toBeLessThan(body.indexOf('if (testConds)'));
    expect(body.indexOf('if (testConds)')).toBeLessThan(body.indexOf('if (!runActions)'));
  });

  it('keeps a non-GUI callback prefix as structured function statements in its original position', async () => {
    const result = await convertGalaxyToTriggers({ libraryId: 'TEST', script: callback('record(4); first = seed(5); second = first;'), header: '' });
    const forward = await convertTriggersToGalaxy(result.output.triggerData, result.output.generationOptions);
    expect(result.output.typeCounts.Trigger ?? 0).toBe(0);
    expect(result.output.triggerData).not.toContain('FlagCustomScript');
    const body = forward.output.script.slice(forward.output.script.indexOf('bool libTEST_gt_Run_Func'));
    expect(body.indexOf('record(4);')).toBeLessThan(body.indexOf('if (lp_testConds)'));
    expect(forward.fidelity.verification.galaxyValidation).toMatchObject({ errors: 0, unresolvedSymbols: [] });
  });

  it('regenerates declarations for scalar editor presets, retaining their actual values', async () => {
    const result = await convertGalaxyToTriggers({ libraryId: 'TEST', header: 'const int libTEST_ge_Mode_First = 3; const int libTEST_ge_Mode_Last = 8;', script: 'int use(){ return libTEST_ge_Mode_First + libTEST_ge_Mode_Last; }' });
    const forward = await convertTriggersToGalaxy(result.output.triggerData, result.output.generationOptions);
    expect(forward.output.header).toContain('const int libTEST_ge_Mode_First = 3;');
    expect(forward.output.header).toContain('const int libTEST_ge_Mode_Last = 8;');
    expect(forward.fidelity.verification.galaxyValidation.status).toBe('passed');
  });

  // Editor oracle (50-RealSteel, 11-TempleOfThePast): a value whose name begins with a digit is
  // written with a leading `_` (`ge_CoopAIAttackWaveBuckets__1Smallest`), so the `_` before a digit
  // does not end the preset; `ge_PersistentAttackLevel_Level_00` is the value `Level_00`. Split at
  // the last `_`, they came back as `…___1Smallest` and `…_Level__00`.
  it('names preset values so their constants are written back as they were', async () => {
    const constants = ['libTEST_ge_Buckets__1Smallest', 'libTEST_ge_Buckets__2Smaller', 'libTEST_ge_Attack_Level_00', 'libTEST_ge_Attack_Level_01'];
    const header = constants.map((name, index) => `const int ${name} = ${index};`).join(' ');
    const result = await convertGalaxyToTriggers({ libraryId: 'TEST', header, script: `int use(){ return ${constants.join(' + ')}; }` });
    expect(result.output.typeCounts.Preset).toBe(2);
    const forward = await convertTriggersToGalaxy(result.output.triggerData, result.output.generationOptions);
    for (const [index, name] of constants.entries()) expect(forward.output.header).toContain(`const int ${name} = ${index};`);
    expect(forward.fidelity.verification.galaxyValidation.status).toBe('passed');
  });

  it('does not discard mutable variables merely because their names resemble a preset', async () => {
    const result = await convertGalaxyToTriggers({ libraryId: 'TEST', header: 'int libTEST_ge_Mode_Mutable = 3;', script: 'void change(){ libTEST_ge_Mode_Mutable += 1; }' });
    const forward = await convertTriggersToGalaxy(result.output.triggerData, result.output.generationOptions);
    expect(result.output.typeCounts.Preset ?? 0).toBe(0);
    expect(forward.fidelity.verification.galaxyValidation.status).toBe('passed');
    expect(result.fidelity.verification.galaxyValidation.lostSourceBindings).toEqual([]);
  });
});
