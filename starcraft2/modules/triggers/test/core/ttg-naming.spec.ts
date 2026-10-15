import { describe, expect, it } from 'vitest';
import { structureTypeName } from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/ttg-core.js';
import { globalVariableName, withImplicitLibrary } from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/conversion-model.js';

const library = (id: string, name: string) => ({
  id,
  elements: { STRUCT: { type: 'Structure', id: 'STRUCT', library: id, name } },
  elementsByType: { Structure: { STRUCT: { type: 'Structure', id: 'STRUCT', library: id, name } } },
  items: [],
}) as any;

describe('TriggerData to Galaxy structure naming', () => {
  it('uses the owning library namespace for structures declared by a mod', () => {
    const source = library('TEST', 'state');
    expect(structureTypeName({ type: 'Structure', library: 'TEST', id: 'STRUCT' }, source))
      .toBe('libTEST_gs_State');
  });

  it('leaves structures owned by an implicit map document unprefixed', () => {
    const source = library('Map', 'state');
    expect(withImplicitLibrary('Map', () =>
      structureTypeName({ type: 'Structure', library: 'Map', id: 'STRUCT' }, source)))
      .toBe('gs_State');
  });

  it('uses a dependency structure owner rather than the current library', () => {
    const source = library('HERE', 'unused');
    const dependency = library('OTHER', 'state');
    expect(structureTypeName(
      { type: 'Structure', library: 'OTHER', id: 'STRUCT' },
      source,
      undefined,
      new Map([['OTHER', dependency]]),
    )).toBe('libOTHER_gs_State');
  });
});

describe('TriggerData to Galaxy variable naming', () => {
  it('lower-cases the initial of an ordinary GUI variable', () => {
    expect(globalVariableName('TEST', { type: 'Variable', id: 'V', name: 'DialogControl' } as any))
      .toBe('libTEST_gv_dialogControl');
  });

  it('applies the editor lower-initial rule to an internal variable', () => {
    expect(globalVariableName('TEST', { type: 'Variable', id: 'V', name: 'ScriptFacing', flags: ['Internal'] } as any))
      .toBe('libTEST_gv_scriptFacing');
  });

  it('applies the editor lower-initial rule to an upper-snake variable constant', () => {
    expect(globalVariableName('TEST', { type: 'Variable', id: 'V', name: 'MISSION_STARTED_EVENT', isConstant: true } as any))
      .toBe('libTEST_gv_mISSION_STARTED_EVENT');
  });

  it('preserves an explicit Galaxy identifier independently of GUI flags', () => {
    expect(globalVariableName('TEST', {
      type: 'Variable', id: 'V', name: 'Localized label', identifier: 'ONLINE_TEST',
      flags: ['Internal'], isConstant: true,
    } as any)).toBe('libTEST_gv_ONLINE_TEST');
  });

  it('uses map naming even when a map element is internal', () => {
    expect(withImplicitLibrary('Map', () =>
      globalVariableName('Map', { type: 'Variable', id: 'V', name: 'PLAYER_ONE', flags: ['Internal'] } as any)))
      .toBe('gv_pLAYER_ONE');
  });

  it('keeps a Galaxy global without the editor prefix only when reconstruction marked it', () => {
    const handle = { type: 'Variable', id: 'V', library: 'Map', name: 'gt_DefeatCheat', variableType: { type: 'trigger' } } as any;
    withImplicitLibrary('Map', () => {
      expect(globalVariableName('Map', handle)).toBe('gv_gt_DefeatCheat');
      expect(globalVariableName('Map', { ...handle, flags: ['NoScriptPrefix'] })).toBe('gt_DefeatCheat');
      expect(globalVariableName('Map', { ...handle, name: 'cai_playerAI', variableType: { type: 'string' }, flags: ['NoScriptPrefix'] }))
        .toBe('cai_playerAI');
    });
  });
});
