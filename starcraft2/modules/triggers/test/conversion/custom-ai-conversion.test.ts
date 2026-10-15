import { describe, expect, it } from 'vitest';
import { convertGalaxyToTriggers, convertTriggersToGalaxy } from '../../../../dist/modules/triggers/services/galaxy-conversion/index.js';
import { generateCustomAiMapScriptSection, generateCustomAiScript } from '../../../../dist/modules/triggers/services/galaxy-conversion/internal/custom-ai-script.js';
import { recoverCustomAi } from '../../../../dist/modules/triggers/services/galaxy-conversion/internal/custom-ai-recovery.js';
import { readAIData, writeAIData } from '../../../../dist/modules/map/shared/format/formats/ai-data.js';

// Every element the corpus's CustomAI documents use: comments, links, a wave that does not wait, a wave
// that runs once, created and trained units, points active at some difficulties, trigger calls at each
// time, a repeated tail and a default gather point.
const document = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<AIData>',
  '    <Definition Id="0A1B2C3D">',
  '        <SourcePlayer Value="5"/>',
  '        <TargetPlayer Value="1"/>',
  '        <TargetPlayer Value="2"/>',
  '        <GatherDefault Id="700"/>',
  '        <RepeatWaves Value="2"/>',
  '        <Step Type="Comment" Text="Opening &quot;waves&quot;"/>',
  '        <Step Type="Wave" Id="1" Text="First">',
  '            <NoWait/>',
  '            <Time Type="Arrival" Trigger="T0" TriggerRunAtEnd="1">',
  '                <Duration DiffLevel="1" Value="40"/>',
  '            </Time>',
  '        </Step>',
  '        <Step Type="Wave" Id="3" Text="Created">',
  '            <OnceOnly/>',
  '            <CreateUnits/>',
  '            <ConfigTrigger Value="T1"/>',
  '            <Unit Type="Zergling">',
  '                <Count DiffLevel="1" Value="6"/>',
  '                <Count DiffLevel="2" Value="8"/>',
  '            </Unit>',
  '            <Unit Type="Roach">',
  '                <Count DiffLevel="2" Value="2"/>',
  '            </Unit>',
  '            <Time Type="Arrival">',
  '                <Duration DiffLevel="1" Value="90"/>',
  '            </Time>',
  '            <Time Type="GatherTime" Trigger="T2">',
  '                <Duration DiffLevel="1" Value="45"/>',
  '            </Time>',
  '            <Point Type="Create" Id="512"/>',
  '            <Point Type="Gather" Id="244"/>',
  '            <Point Type="Waypoint" Id="965437914">',
  '                <Active DiffLevel="2"/>',
  '                <Active DiffLevel="3"/>',
  '            </Point>',
  '            <Point Type="Waypoint" Id="966"/>',
  '            <Point Type="TargetPoint" Id="293"/>',
  '        </Step>',
  '        <Step Type="Link" Id="1"/>',
  '        <Step Type="Wave" Id="2">',
  '            <Unit Type="Marine">',
  '                <Count DiffLevel="1" Value="1"/>',
  '                <Count DiffLevel="3" Value="4"/>',
  '            </Unit>',
  '            <Time Type="Arrival" Trigger="T3">',
  '                <Duration DiffLevel="1" Value="20"/>',
  '            </Time>',
  '            <Time Type="FinalWait">',
  '                <Duration DiffLevel="1" Value="10"/>',
  '            </Time>',
  '        </Step>',
  '    </Definition>',
  '</AIData>',
].join('\r\n');

const triggers = ['gt_Opening_Func', 'gt_Configure_Func', 'gt_Gathered_Func', 'gt_Arrived_Func'];
const names = {
  aiName: () => 'Test Wave AI',
  triggerFunction: (id: string) => triggers[Number(id.slice(1))]!,
};

describe('Custom AI', () => {
  it('reads and writes the CustomAI document without changing a byte', () => {
    const model = readAIData(document);
    expect(model.definitions[0]!.steps.map(step => step.type)).toEqual(['Comment', 'Wave', 'Wave', 'Link', 'Wave']);
    expect(writeAIData(model)).toBe(document);
    // A changed model is written in the editor's layout.
    model.definitions[0]!.sourcePlayer = 6;
    expect(writeAIData(model)).toBe(document.replace('<SourcePlayer Value="5"/>', '<SourcePlayer Value="6"/>'));
  });

  it('reads the document back from the Galaxy generated from it, and not from edited Galaxy', () => {
    const model = readAIData(document);
    const ai = generateCustomAiScript(model.definitions[0], names);
    const section = generateCustomAiMapScriptSection(model, { campaignPlayers: [3, 4] });
    const script = [
      'include "TriggerLibs/NativeLib"', 'include "ai0A1B2C3D"', '', section, '',
      'void InitMap () {', '    InitLibs();', '    InitGlobals();', '    InitCustomAI();', '    InitTriggers();', '}', '',
    ].join('\r\n');
    const recovered = recoverCustomAi(script, [{ fileName: 'ai0A1B2C3D.galaxy', text: ai }]);
    expect(recovered.state).toBe('recovered');
    if (recovered.state !== 'recovered') return;
    const { value } = recovered;
    expect(value.campaignPlayers).toEqual([3, 4]);
    expect(value.aiNames.get('0A1B2C3D')).toBe('Test Wave AI');
    expect([...value.triggerFunctions.values()].sort()).toEqual([...triggers].sort());
    // The placeholders stand for the same trigger functions the document named.
    const byName = new Map([...value.triggerFunctions].map(([id, name]) => [name, `T${triggers.indexOf(name)}`]));
    const back = writeAIData(value.document).replace(/(Trigger|ConfigTrigger Value)="(T\d+)"/gu,
      (_, key, id) => `${key}="${byName.get(value.triggerFunctions.get(id)!)}"`);
    expect(back).toBe(document);
    expect(value.script).not.toContain('cai_');
    expect(value.script).not.toContain('include "ai0A1B2C3D"');
    expect(value.script).toContain('void InitMap () {\n    InitLibs();\n    InitGlobals();\n    InitTriggers();\n}');

    const edited = recoverCustomAi(script, [{ fileName: 'ai0A1B2C3D.galaxy', text: ai.replace('Wait(ts, c_timeAI);', 'Wait(ts + 1, c_timeAI);') }]);
    expect(edited).toMatchObject({ state: 'kept', reason: 'ai-script-differs' });
    expect(recoverCustomAi(script, [])).toMatchObject({ state: 'kept', reason: 'missing-ai-script' });
    expect(recoverCustomAi('void InitMap () { }', [])).toEqual({ state: 'none' });
  });

  it('turns a map\'s Custom AI code into the CustomAI document and generates it again', async () => {
    // Without triggers in this map; a time's TriggerRunAtEnd then has no Galaxy of its own.
    const model = readAIData(document.replace(/ Trigger="T\d"| TriggerRunAtEnd="1"/gu, '').replace(/\r\n\s*<ConfigTrigger Value="T1"\/>/u, ''));
    const ai = generateCustomAiScript(model.definitions[0], names);
    const section = generateCustomAiMapScriptSection(model, { campaignPlayers: [] }).replaceAll('\r\n', '\n');
    const script = [
      'include "TriggerLibs/NativeLib"', 'include "ai0A1B2C3D"', '', section, '',
      'void InitGlobals () {', '}', '',
      'void InitTriggers () {', '}', '',
      'void InitMap () {', '    InitGlobals();', '    InitCustomAI();', '    InitTriggers();', '}', '',
    ].join('\n');
    const reverse = await convertGalaxyToTriggers({
      libraryId: 'Map', documentKind: 'map', verification: 'semantic', script, header: '',
      customAiScripts: [{ fileName: 'ai0A1B2C3D.galaxy', text: ai }],
    });
    expect(reverse.output.customAi?.document).toBe(writeAIData(model));
    expect(reverse.output.customAi?.aiNames).toEqual({ '0A1B2C3D': 'Test Wave AI' });
    expect(reverse.output.replacedScripts).toEqual(['ai0A1B2C3D.galaxy']);
    // Nothing of the generated code became a trigger element.
    expect(reverse.output.triggerData).not.toContain('cai_');
    expect(reverse.output.triggerData).not.toContain('InitCustomAI');

    const forward = await convertTriggersToGalaxy(reverse.output.triggerData, {
      libraryId: 'Map', documentKind: 'map', ...reverse.output.generationOptions, customAi: reverse.output.customAi,
    });
    expect(forward.output.customAiScripts).toEqual([{ fileName: 'ai0A1B2C3D.galaxy', text: ai }]);
    expect(forward.output.script).toContain('include "ai0A1B2C3D"');
    expect(forward.output.script).toContain(section);
    expect(forward.output.script).toMatch(/InitGlobals\(\);\n    InitCustomAI\(\);\n/u);
  });
});

describe('Attributes', () => {
  it('reads the document\'s own lobby attributes from the calls that read them', async () => {
    const script = [
      'void gf_Setup () {',
      '    if ((GameAttributeGameValue("5") == "0002")) {',
      '        UIDisplayMessage(PlayerGroupAll(), c_messageAreaSubtitle, StringToText(GameAttributePlayerValue("16", 1)));',
      '    }',
      '    if (GameAttributeGameValue("5") != "0003") { }',
      '    if (GameAttributeGameValue("[bnet:local/0.0/1]2") == "0001") { }',
      '}',
      '',
      'void gf_Switch () {',
      '    string auto_val;',
      '    auto_val = GameAttributeGameValue("7");',
      '    if (auto_val == "0004") { }',
      '}',
      '',
    ].join('\n');
    const reverse = await convertGalaxyToTriggers({
      libraryId: 'Map', documentKind: 'map', verification: 'semantic', script, header: '',
      gameStrings: 'Attribute005/Name=Starting Money\nAttribute005/Value002/Name=Rich\n',
    });
    expect(reverse.output.recoveredAttributes?.document).toBe([
      '<?xml version="1.0" encoding="utf-8"?>',
      '<Attributes>',
      '    <Attribute>',
      '        <Id Value="5"/>',
      '        <Type Value="Global"/>',
      '        <Name Value="Attribute005/Name"/>',
      '        <Availability Value="All"/>',
      '        <Visibility Value="All"/>',
      '        <Access Value="Host"/>',
      '        <Value>',
      '            <Id Value="2"/>',
      '            <Name Value="Attribute005/Value002/Name"/>',
      '        </Value>',
      '        <Value>',
      '            <Id Value="3"/>',
      '        </Value>',
      '    </Attribute>',
      '    <Attribute>',
      '        <Id Value="7"/>',
      '        <Type Value="Global"/>',
      '        <Availability Value="All"/>',
      '        <Visibility Value="All"/>',
      '        <Access Value="Host"/>',
      '        <Value>',
      '            <Id Value="4"/>',
      '        </Value>',
      '    </Attribute>',
      '    <Attribute>',
      '        <Id Value="16"/>',
      '        <Type Value="Player"/>',
      '        <Availability Value="All"/>',
      '        <Visibility Value="All"/>',
      '        <Access Value="Self"/>',
      '    </Attribute>',
      '    <DefaultVariants Value="0"/>',
      '</Attributes>',
    ].join('\r\n'));
    expect(reverse.output.recoveredAttributes?.inferred).toContain('16/Value');
    expect(reverse.output.recoveredAttributes?.inferred).toContain('5/Default');
  });
});
