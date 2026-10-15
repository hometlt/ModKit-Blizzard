/* eslint-disable no-extra-semi */
import * as xml from 'xml2js';

export const enum ElementFlag {
    Native             = 1 << 1,
    FuncAction         = 1 << 2,
    FuncCall           = 1 << 3,
    Event              = 1 << 4,
    Template           = 1 << 5,
    PresetGenConstVar  = 1 << 6,
    PresetCustom       = 1 << 7,
    CustomScript       = 1 << 8,
    Operator           = 1 << 9,
    CustomAI           = 1 << 10,
    SubFunctions       = 1 << 11,
    AllowBreak         = 1 << 12,
    Hidden             = 1 << 13,
    NoScriptPrefix     = 1 << 14,
    Deprecated         = 1 << 15,
    Internal           = 1 << 16,
    Restricted         = 1 << 17,
}

export class ElementReference<T extends Element> {
    private store: TriggerStore;
    id!: string;
    type!: typeof Element;
    library?: string;

    public constructor(container: TriggerStore) {
        this.store = container;
    }

    public link() {
        return this.type.name + '/' + this.id;
    }

    public globalLink() {
        let link = this.link();
        if (this.library) {
            link = this.library + '/' + link;
        }
        return link;
    }

    public resolve(): T | undefined {
        if (this.library) {
            const lib = this.store.getLibraries().get(this.library);
            return lib?.findElementById(this.link()) as T;
        }
        return this.store.findElementById(this.link()) as T;
    }
}

export class ParameterType {
    type!: string;
    gameType?: string; // when type == gamelink; e.g. Model; (may be omitted - "any")
    typeElement?: ElementReference<Element>; // e.g. preset type or structure type

    get galaxyType(): string {
        switch (this.type) {
            case 'anygamelink':
            case 'gamelink':
            case 'filepath':
            case 'actormsg':
            case 'aidef':
            case 'modelanim':
            case 'attributegame':
            case 'attributeplayer':
            case 'attributevalue':
            case 'catalogentry':
            case 'catalogfieldname':
            case 'catalogfieldpath':
            case 'reference':
            case 'catalogscope':
            case 'charge':
            case 'convcharacter':
            case 'convline':
            case 'convstateindex':
            case 'conversationtag':
            case 'cooldown':
            case 'fontstyle':
            case 'gameoption':
            case 'gameoptionvalue':
            case 'modelcamera':
            case 'timeofday':
            case 'layoutframe':
            case 'layoutframerel':
            case 'userfield':
            case 'userinstance':
            case 'water':
            {
                return 'string';
            }

            case 'aidefwave':
            case 'cinematic':
            case 'conversation':
            case 'reply':
            case 'datatable':
            case 'dialog':
            case 'control':
            case 'difficulty':
            case 'objective':
            case 'path':
            case 'ping':
            case 'planet':
            case 'playercolor':
            case 'portrait':
            case 'transmission':
            {
                return 'int';
            }

            case 'animlengthquery':
            {
                return 'generichandle';
            }

            case 'targetfilter':
            {
                return 'unitfilter';
            }

            case 'preset':
                return (this.typeElement?.resolve() as Preset | undefined)?.baseType ?? 'int';

            default:
                return this.type;
        }
    }
}

export abstract class Tag {
    static prefix?: string;
    libId?: string;
    id!: string;
    name?: string;

    public link() {
        return (this.libId ? this.libId + '/' : '') + (this.constructor.name + '/') + this.id;
    }

    public toString() {
        const parts: string[] = [];
        if (this.libId) {
            parts.push('lib' + this.libId);
        }
        const prefix = (<any>this.constructor).prefix;
        if (prefix) {
            parts.push(prefix);
        }
        parts.push(this.name ? this.name : this.id);
        return parts.join('_');
    }

    public textKey(kind: string) {
        const parts: string[] = [];
        parts.push(this.constructor.name);
        parts.push(kind);
        if (this.libId) {
            parts.push(['lib', this.libId, this.id].join('_'));
        }
        else {
            parts.push(this.id);
        }
        return parts.join('/');
    }
}

export abstract class Element extends Tag {
    flags: ElementFlag = 0 as ElementFlag;
    label?: ElementReference<Label>;
    items: ElementReference<Element>[] = [];

    public override toString() {
        if (this.flags & ElementFlag.Native) {
            return this.name ? this.name : this.id;
        }
        return super.toString();
    }
}

export class ParamDef extends Element {
    type!: ParameterType;
    isReference?: boolean; // ParamFlagReference
    isMultiple?: boolean; // ParamFlagMultiple
    default?: ElementReference<Param>;

    get galaxyType(): string {
        const rtype = this.type.galaxyType;
        if (this.isReference) {
            switch (rtype) {
                case 'unit':
                {
                    return 'unitref';
                }
            }
        }
        return rtype;
    }
}

export class FunctionDef extends Element {
    static override prefix = 'gf';
    parameters: ElementReference<ParamDef>[] = [];
    returnType?: ParameterType;
    scriptCode?: string;
    eventResponses: ElementReference<FunctionDef>[] = [];
    /** SubFunctionType declarations — lists all sub-block roles this function accepts */
    subFunctionTypes: Array<{ library: string; id: string }> = [];
    /** Body actions (FunctionCall children of FunctionDef in SC2 Editor XML) */
    actions: ElementReference<FunctionCall>[] = [];
    /** Local variables declared in the function body */
    localVariables: ElementReference<Variable>[] = [];

    public getParameters() {
        return this.parameters.map((paramRef): ParamDef => {
            return paramRef.resolve() as ParamDef;
        });
    }
}

export class Preset extends Element {
    baseType!: string;
    values: ElementReference<PresetValue>[] = [];
}

export class PresetValue extends Element {
    value?: string;
}

export class Param extends Element {
    parameterDef?: ElementReference<ParamDef>;
    functionCall?: ElementReference<FunctionCall>;
    preset?: ElementReference<PresetValue>;
    value?: string;
    valueType?: string;
    valueGameType?: string;
    valueElement?: ElementReference<Preset>;
    variable?: ElementReference<Variable>;
    /** Struct member selection for struct-typed variable access */
    structMember?: ElementReference<Param>;
    /** Array index or indices for array variable access. Single index: [0], 2D: [0][1] */
    array?: ElementReference<Param>[];
    /** References a FunctionDef's own ParamDef — encodes "use the function parameter lp_xxx" */
    paramRef?: ElementReference<ParamDef>;
}

export class FunctionCall extends Element {
    functionDef!: ElementReference<FunctionDef>;
    parameters: ElementReference<Param>[] = [];
    subFunctions: ElementReference<FunctionCall>[] = [];
    subFunctionType?: { library: string; id: string };
    scriptCode?: string;
}

export class Category extends Element {
};

export class Label extends Element {
    icon?: string;
    color?: string;
};
    
export class Trigger extends Element {
    events: ElementReference<FunctionCall>[] = [];
    conditions: ElementReference<FunctionCall>[] = [];
    actions: ElementReference<FunctionCall>[] = [];
    localVariables: ElementReference<Variable>[] = [];
}

export class Variable extends Element {
    variableType?: ParameterType;
    initialValue?: ElementReference<Param>;
    isArray?: boolean;
    isConstant?: boolean;
    arraySizes?: Array<{
        dim: number;
        value?: string;
        variable?: ElementReference<Variable>;
    }>;
}

export class Structure extends Element {
    variables: ElementReference<Variable>[] = [];
}

const ElementClasses = {
    ParamDef,
    FunctionDef,
    Preset,
    PresetValue,
    Param,
    FunctionCall,
    Category,
    Label,
    Trigger,
    Variable,
    Structure,
};

// export class TriggerExplorer {
//     protected containers: ElementContainer;
// }

export abstract class ElementContainer {
    public items: ElementReference<Element>[] = [];
    protected elements: Map<string, Element> = new Map();
    protected nameMap: Map<string, Element> = new Map();

    public addElement(identifier: string, el: Element) {
        el.id = identifier;
        if (el instanceof FunctionDef && el.name) {
            this.nameMap.set(el.name, el);
        }
        this.elements.set(el.constructor.name + '/' + el.id, el);
    }

    public findElementByName(name: string): Element | undefined {
        return this.nameMap.get(name);
    }

    public findPresetValueByStr(value: string): PresetValue | undefined {
        for (const el of this.elements.values()) {
            if (!(el instanceof PresetValue)) continue;
            if (el.value && el.value === value) {
                return el;
            }
        }
        return undefined;
    }

    public findPresetByValue(value: PresetValue): Preset | undefined {
        for (const el of this.elements.values()) {
            if (!(el instanceof Preset)) continue;
            const belongsTo = el.values.find((localVal) => {
                return value.id === localVal.id;
            });
            if (belongsTo) {
                return el;
            }
        }
        return undefined;
    }

    public findElementById<T extends Element>(id: string, type?: { new(): T ;}): T | undefined {
        if (type && type.name !== 'Element') {
            id = type.name + '/' + id;
        }
        return this.elements.get(id) as T;
    }

    public getElements() {
        return <ReadonlyMap<string, Element>>this.elements;
    }
}

export class Library extends ElementContainer {
    protected id: string;

    constructor(id: string) {
        super();
        this.id = id;
    }

    public override addElement(identifier: string, el: Element) {
        el.libId = this.id;
        super.addElement(identifier, el);
    }

    public getId() {
        return this.id;
    }
}

export type LibraryContainer = Map<string, Library>;

export class TriggerStore extends ElementContainer {
    protected libraries: LibraryContainer = new Map<string, Library>();
    protected unresolvedReferences = new Map<string, ElementReference<Element>[]>();

    public addElementReference(ref: ElementReference<Element>) {
        const link = ref.globalLink();

        if (this.unresolvedReferences.has(link)) {
            const refList = this.unresolvedReferences.get(link)!;
            refList.push(ref);
        }
        else {
            this.unresolvedReferences.set(link, [ref]);
        }
    }

    public addLibrary(library: Library) {
        this.libraries.set(library.getId(), library);
    }

    // public findElementById<T extends Element>(elementId: string, libraryId?: string): T | undefined {
    //     if (libraryId) {
    //         return this.libraries.get(libraryId).findElementById(elementId) as T;
    //     }
    //     return super.findElementById(elementId) as T;
    // }

    public getLibraries() {
        return <ReadonlyMap<string, Library>>this.libraries;
    }
}

export class XMLReader {
    protected store: TriggerStore;

    private parseReference<T extends Element>(data: any, type: { new(): T }): ElementReference<T> {
        const ref = new ElementReference<T>(this.store);
        ref.id = data.$.Id;
        if (data.$.Library) {
            ref.library = data.$.Library;
        }
        ref.type = (ElementClasses as any)[type.name];

        this.store.addElementReference(ref);

        return ref;
    }

    private parseParam(item: any): Param {
        const element = new Param();
        if (item.ParameterDef) {
            element.parameterDef = this.parseReference(item.ParameterDef[0], ParamDef);
        }
        if (item.FunctionCall) {
            element.functionCall = this.parseReference(item.FunctionCall[0], FunctionCall);
        }
        if (item.Preset) {
            element.preset = this.parseReference(item.Preset[0], PresetValue);
        }
        if (item.Value) {
            element.value = item.Value[0];
        }
        if (item.ValueType) {
            element.valueType = item.ValueType[0].$.Type;
            if (item.ValueGameType) {
                element.valueGameType = item.ValueGameType[0].$.Type;
            }
        }
        if (item.ValueElement) {
            element.valueElement = this.parseReference(item.ValueElement[0], Preset);
        }
        // Variable reference inside Param (e.g. variable as parameter value)
        if (item.Variable) {
            element.variable = this.parseReference(item.Variable[0], Variable);
        }
        if (item.StructMember) {
            element.structMember = this.parseReference(item.StructMember[0], Param);
        }
        // Array indices: one or more Param references for 1D/2D/etc array access
        if (item.Array) {
            element.array = (item.Array as any[]).map((a: any) => this.parseReference(a, Param));
        }
        // <Parameter Type="ParamDef" ...> — encodes "use the function input parameter lp_xxx"
        if (item.Parameter) {
            for (const p of item.Parameter) {
                if (p.$?.Type === 'ParamDef') {
                    element.paramRef = this.parseReference(p, ParamDef);
                    break;
                }
            }
        }
        return element;
    }

    private parseParamDef(item: any): ParamDef {
        const paramDef = new ParamDef();
        paramDef.type = this.parseParameterType(item.ParameterType[0]);
        if (item.Default) {
            paramDef.default = this.parseReference(item.Default[0], Param);
        }
        if (item.ParamFlagReference) {
            paramDef.isReference = true;
        }
        if (item.ParamFlagMultiple) {
            paramDef.isMultiple = true;
        }
        return paramDef;
    }

    private parseFunctionCall(item: any): FunctionCall {
        const element = new FunctionCall();
        if (item.FunctionDef) {
            // TODO: check one of the void story libraries - it doesn't have FunctionDef
            element.functionDef = this.parseReference(item.FunctionDef[0], FunctionDef);
        }
        if (item.Parameter) {
            for (const param of item.Parameter) {
                if (param.$.Type === 'Comment') continue;
                element.parameters.push(this.parseReference(param, Param));
            }
        }
        // Inline sub-function blocks (for IfThenElse, WhileDo, PickEachInteger, etc.)
        if (item.FunctionCall) {
            for (const fc of item.FunctionCall) {
                element.subFunctions.push(this.parseReference(fc, FunctionCall));
            }
        }
        // SubFunctionType identifies the role of this sub-block (e.g. "If", "Then", "Else", "Actions")
        if (item.SubFunctionType) {
            element.subFunctionType = {
                library: item.SubFunctionType[0].$.Library,
                id: item.SubFunctionType[0].$.Id,
            };
        }
        if (item.ScriptCode) {
            let code: string = item.ScriptCode[0];
            const whitespace = code.match(/^\r?\n(\s+)/);
            if (whitespace) {
                code = code.trim().replace(/\r?\n/g, '\n').replace(new RegExp('^' + whitespace[1], 'gm'), '');
            }
            element.scriptCode = code.trim();
        }
        return element;
    }

    private parseParameterType(item: any): ParameterType {
        const element = new ParameterType();
        element.type = item.Type[0].$.Value;
        if (element.type === 'gamelink' && item.GameType) {
            element.gameType = item.GameType[0].$.Value;
        }
        if (item.TypeElement) {
            const typeName = item.TypeElement[0]?.$?.Type;
            if (typeName === 'Structure') {
                element.typeElement = this.parseReference(item.TypeElement[0], Structure);
            }
            else {
                element.typeElement = this.parseReference(item.TypeElement[0], Preset);
            }
        }
        return element;
    }

    private parseCategory(_item: any) {
        const element = new Category();
        return element;
    }

    private parseLabel(item: any) {
        const element = new Label();
        if (item.Icon) {
            element.icon = item.Icon[0];
        }
        if (item.Color) {
            element.color = item.Color[0];
        }
        return element;
    }

    private parseElement(item: any): Element | undefined {
        let el: Element;

        switch (item.$.Type) {
            case 'FunctionDef':
            {
                const func = el = new FunctionDef();

                func.flags |= item.FlagNative ? ElementFlag.Native : 0;
                func.flags |= item.FlagAction ? ElementFlag.FuncAction : 0;
                func.flags |= item.FlagCall ? ElementFlag.FuncCall : 0;
                func.flags |= item.FlagEvent ? ElementFlag.Event : 0;
                func.flags |= item.Template ? ElementFlag.Template : 0;
                func.flags |= item.FlagCustomScript ? ElementFlag.CustomScript : 0;
                func.flags |= item.FlagOperator ? ElementFlag.Operator : 0;
                func.flags |= item.FlagCustomAI ? ElementFlag.CustomAI : 0;
                func.flags |= item.FlagSubFunctions ? ElementFlag.SubFunctions : 0;
                func.flags |= item.FlagAllowBreak ? ElementFlag.AllowBreak : 0;
                func.flags |= item.FlagHidden ? ElementFlag.Hidden : 0;
                func.flags |= item.FlagNoScriptPrefix ? ElementFlag.NoScriptPrefix : 0;
                func.flags |= item.Deprecated ? ElementFlag.Deprecated : 0;
                func.flags |= item.Internal ? ElementFlag.Internal : 0;
                func.flags |= item.FlagRestricted ? ElementFlag.Restricted : 0;

                if (item.Parameter) {
                    for (const param of item.Parameter) {
                        if (param.$.Type === 'Comment') continue;
                        func.parameters.push(this.parseReference(param, ParamDef));
                    }
                }

                if (item.ReturnType) {
                    func.returnType = this.parseParameterType(item.ReturnType[0]);
                }

                if (item.ScriptCode) {
                    let code: string = item.ScriptCode[0];
                    const whitespace = code.match(/^\r?\n(\s+)/);
                    if (whitespace) {
                        code = code.trim().replace(/\r?\n/g, '\n').replace(new RegExp('^' + whitespace[1], 'gm'), '');
                    }
                    func.scriptCode = code;
                }

                if (item.FunctionCall) {
                    for (const fc of item.FunctionCall) {
                        func.actions.push(this.parseReference(fc, FunctionCall));
                    }
                }

                if (item.Variable) {
                    for (const v of item.Variable) {
                        func.localVariables.push(this.parseReference(v, Variable));
                    }
                }

                if (item.EventResponse) {
                    for (const er of item.EventResponse) {
                        func.eventResponses.push(this.parseReference(er, FunctionDef));
                    }
                }

                if (item.SubFunctionType) {
                    for (const sft of item.SubFunctionType) {
                        func.subFunctionTypes.push({
                            library: sft.$.Library,
                            id: sft.$.Id,
                        });
                    }
                }
                break;
            }
            case 'ParamDef':
            {
                el = this.parseParamDef(item);
                break;
            }
            case 'Param':
                el = this.parseParam(item);
                break;
            case 'FunctionCall':
                el = this.parseFunctionCall(item);
                break;
            case 'Preset':
            {
                const preset = el = new Preset();
                preset.flags |= item.PresetGenConstVar ? ElementFlag.PresetGenConstVar : 0;
                preset.flags |= item.PresetCustom ? ElementFlag.PresetCustom : 0;
                preset.baseType = item.BaseType[0].$.Value;
                if (item.Item) {
                    for (const val of item.Item) {
                        if (val.$.Type !== 'PresetValue') continue;
                        preset.values.push(this.parseReference(val, PresetValue));
                    }
                }
                // item.$.PresetCustom
                // item.$.PresetGenConstVar
                // item.$.PresetAsBits
                break;
            }
            case 'PresetValue':
            {
                const presetValue = el = new PresetValue();
                if (item.Value) {
                    presetValue.value = item.Value[0];
                }
                break;
            }
            case 'Trigger':
            {
                const trigger = el = new Trigger();
                if (item.Event) {
                    for (const ev of item.Event) {
                        trigger.events.push(this.parseReference(ev, FunctionCall));
                    }
                }
                if (item.Condition) {
                    for (const cond of item.Condition) {
                        trigger.conditions.push(this.parseReference(cond, FunctionCall));
                    }
                }
                if (item.Action) {
                    for (const action of item.Action) {
                        trigger.actions.push(this.parseReference(action, FunctionCall));
                    }
                }
                // SC2 uses <Variable Type="Variable"> for local vars (not LocalVariable)
                if (item.Variable) {
                    for (const lv of item.Variable) {
                        if (lv.$.Type === 'Variable') {
                            trigger.localVariables.push(this.parseReference(lv, Variable));
                        }
                    }
                }
                break;
            }
            case 'Variable':
            {
                const variable = el = new Variable();
                if (item.VariableType) {
                    variable.variableType = this.parseParameterType(item.VariableType[0]);
                    // <Constant/> inside <VariableType> — SC2 Editor format
                    if (item.VariableType[0].Constant) {
                        variable.isConstant = true;
                    }
                    // <ArraySize> inside <VariableType> — SC2 Editor array format
                    if (item.VariableType[0].ArraySize) {
                        variable.isArray = true;
                        variable.arraySizes = (item.VariableType[0].ArraySize as any[])
                            .map((arrItem: any) => {
                                const attrs = arrItem?.$ ?? {};
                                const dim = Number(attrs.Dim ?? 0);
                                const value = attrs.Value !== undefined ? String(attrs.Value) : undefined;
                                let variableRef: ElementReference<Variable> | undefined;
                                if (attrs.Type === 'Variable' && attrs.Id) {
                                    variableRef = this.parseReference({ $: attrs }, Variable);
                                }
                                return { dim, value, variable: variableRef };
                            })
                            .sort((a, b) => a.dim - b.dim);
                    }
                }
                // SC2 Editor uses <Value Type="Param" ...> for the initial value.
                // Fall back to <InitialValue> for compatibility with other tools.
                if (item.Value && (item.Value[0] as any)?.$) {
                    variable.initialValue = this.parseReference(item.Value[0], Param);
                } else if (item.InitialValue) {
                    variable.initialValue = this.parseReference(item.InitialValue[0], Param);
                }
                if (item.Array) {
                    variable.isArray = true;
                }
                if (item.Const) {
                    variable.isConstant = true;
                }
                break;
            }
            case 'Structure':
            {
                const structure = el = new Structure();
                if (item.Variable) {
                    for (const v of item.Variable) {
                        if (v.$.Type === 'Variable') {
                            structure.variables.push(this.parseReference(v, Variable));
                        }
                    }
                }
                break;
            }
            case 'Category':
                el = this.parseCategory(item);
                break;
            case 'Label':
                el = this.parseLabel(item);
                break;
            default:
            {
                return undefined;
            }
        }

        if (item.Item) {
            el.items = this.parseItems(item);
        }

        if (item.Label) {
            el.label = this.parseReference(item.Label[0], Label);
        }

        if (item.Identifier) {
            el.name = item.Identifier[0];
        }

        return el;
    }

    private parseItems(data: any) {
        const elItems: ElementReference<Element>[] = [];
        for (const itEntry of data.Item) {
            const cls = (ElementClasses as any)[itEntry.$.Type];
            if (!cls) continue;
            elItems.push(this.parseReference(itEntry, cls));
        }
        return elItems;
    }

    private parseTree(data: any, container: ElementContainer) {
        if (data.Root && data.Root[0].Item) {
            container.items = this.parseItems(data.Root[0]);
        }
        if (!data.Element) return;
        for (const item of data.Element) {
            const el = this.parseElement(item);
            if (el) {
                container.addElement(item.$.Id, el);
            }
        }
    }

    private parseLibrary(id: string, data: any): Library {
        const lib = new Library(id);
        this.parseTree(data, lib);
        return lib;
    }

    constructor(container: TriggerStore) {
        this.store = container;
    }

    protected loadXML(content: string) {
        return new Promise<any>((resolve, reject) => {
            xml.parseString(content, (err, result) => {
                if (err) {
                    reject(err);
                }
                else {
                    try {
                        resolve(result.TriggerData);
                    }
                    catch (err) {
                        reject(err);
                    }
                }
            });
        });
    }

    /** Parse XML once so archive workspaces can cache the expensive xml2js result. */
    public parseXML(content: string): Promise<any> {
        return this.loadXML(content);
    }

    /** Build and register a library from a parsed or cached TriggerData document. */
    public buildLibrary(data: any): Library {
        const lib = this.parseLibrary(data.Standard[0].$.Id, data);
        this.store.addLibrary(lib);
        return lib;
    }

    /** Build libraries and optional root elements from parsed or cached TriggerData. */
    public buildStore(data: any, onlyLibraries: boolean = false): TriggerStore {
        if (data.Library) {
            for (const item of data.Library) {
                const lib = this.parseLibrary(item.$.Id, item);
                this.store.addLibrary(lib);
            }
        }

        if (!onlyLibraries) {
            this.parseTree(data, this.store);
        }
        return this.store;
    }

    public async loadLibrary(content: string): Promise<Library> {
        return this.buildLibrary(await this.parseXML(content));
    }

    public async load(content: string, onlyLibraries: boolean = false): Promise<TriggerStore> {
        return this.buildStore(await this.parseXML(content), onlyLibraries);
    }
}

// export function forEachElement(element: Element) {
//     function visitElement()
// }
