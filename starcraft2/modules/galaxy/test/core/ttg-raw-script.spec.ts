import { describe, expect, it } from 'vitest';
import type { FunctionCallJson, FunctionDefJson, TriggerJson, TriggerLibraryJson } from '@modkit/blizzard-starcraft2/triggers/document/index.js';
import { convertTriggerLibraryToGalaxyFull } from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/trigger-to-galaxy.js';

function emptyElementsByType(): TriggerLibraryJson['elementsByType'] {
  return {
    FunctionDef: {},
    ParamDef: {},
    FunctionCall: {},
    Param: {},
    Variable: {},
    Trigger: {},
    Preset: {},
    PresetValue: {},
    Category: {},
    Label: {},
    Structure: {},
  };
}

describe('raw custom script conversion', () => {
  it('preserves complex inline custom script instead of parsing it', () => {
    const customScriptDef: FunctionDefJson = {
      type: 'FunctionDef',
      id: '00000123',
      library: 'Ntve',
      name: 'customscriptaction',
      flags: ['CustomScript'],
      parameters: [],
      isFuncAction: true,
    };
    const rawCode = 'lv_vString = (lv_vString + lib1_gf_UT_ReplaceEmotes(("(" + lib1_gv_uT_SC_Emoticons[auto4FE2F147_var] + ")")) + " " + lv_vStyle + "(" + lib1_gv_uT_SC_Emoticons[auto4FE2F147_var] + ")</s> </n>");';
    const action: FunctionCallJson = {
      type: 'FunctionCall',
      id: 'A0001338',
      library: '1',
      functionDef: { type: 'FunctionDef', library: 'Ntve', id: customScriptDef.id },
      parameters: [],
      subFunctions: [],
      scriptCode: rawCode,
    };
    const trigger: TriggerJson = {
      type: 'Trigger',
      id: 'A00012E3',
      library: '1',
      name: 'UT_ListEmotes',
      events: [],
      conditions: [],
      actions: [{ type: 'FunctionCall', library: '1', id: action.id }],
      localVariables: [],
    };

    const nativeLibrary: TriggerLibraryJson = {
      id: 'Ntve',
      items: [],
      elements: { [`FunctionDef:${customScriptDef.id}`]: customScriptDef },
      elementsByType: { ...emptyElementsByType(), FunctionDef: { [customScriptDef.id]: customScriptDef } },
    };
    const library: TriggerLibraryJson = {
      id: '1',
      items: [trigger],
      elements: {
        [`Trigger:${trigger.id}`]: trigger,
        [`FunctionCall:${action.id}`]: action,
      },
      elementsByType: { ...emptyElementsByType(), Trigger: { [trigger.id]: trigger }, FunctionCall: { [action.id]: action } },
    };
    const allLibraries = new Map<string, TriggerLibraryJson>([
      [nativeLibrary.id, nativeLibrary],
      [library.id, library],
    ]);

    const { script } = convertTriggerLibraryToGalaxyFull(library, nativeLibrary, allLibraries);

    expect(script).toContain(rawCode);
    expect(script).not.toContain('__mx_raw_script');
  });
});
