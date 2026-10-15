/** TriggerData fixtures shared by the MK3 gamelink edit tests. */
export const TRIGGER_GAMELINK_FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<TriggerData>
    <Standard Id="Test"/>
    <Root>
        <Item Type="Trigger" Library="Test" Id="00000001"/>
    </Root>
    <Element Type="Param" Id="A0000001">
        <ParameterDef Type="ParamDef" Library="Ntve" Id="9A7F392A"/>
        <Value>Marine</Value>
        <ValueType Type="gamelink"/>
        <ValueGameType Type="Unit"/>
    </Element>
    <Element Type="Param" Id="A0000002">
        <ParameterDef Type="ParamDef" Library="Ntve" Id="9A7F392A"/>
        <Value>ZapDamage</Value>
        <ValueType Type="gamelink"/>
        <ValueGameType Type="Effect"/>
    </Element>
    <Element Type="Param" Id="A0000003">
        <ParameterDef Type="ParamDef" Library="Ntve" Id="3F2584C8"/>
        <Value>ZapAbil,Execute</Value>
        <ValueType Type="abilcmd"/>
    </Element>
    <Element Type="Param" Id="A0000004">
        <ParameterDef Type="ParamDef" Library="Ntve" Id="11111111"/>
        <Value>Marine</Value>
        <ValueType Type="string"/>
    </Element>
</TriggerData>`

/** The same document plus Galaxy source that a typed gamelink edit must not rewrite. */
export const TRIGGER_GAMELINK_WITH_SCRIPT_FIXTURE = TRIGGER_GAMELINK_FIXTURE.replace(
  '</TriggerData>',
  `    <Element Type="FunctionDef" Id="A0000005">
        <Identifier>DemoSpawn</Identifier>
        <FlagCustomScript/>
        <ScriptCode>
            UnitCreate(1, "Marine", 0, 1, PointFrom(0, 0), 270.0);
        </ScriptCode>
    </Element>
</TriggerData>`,
)
