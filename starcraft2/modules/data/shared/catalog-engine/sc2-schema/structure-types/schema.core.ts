import {
  CScalar,
  CBoolean,
  CNumber,
  CString,
  SchemaValue,
  type CDataOptions,
  type WalkOptions,
  type WalkTrace,
  type SCData,
  type SCDataScalar,
  type SCDataArray,
  type SCDataArrayItem,
  type SCDataObject
} from "./schema.primitives.js";

// Re-export primitives for convenience
// export {
//   CScalar,
//   CBoolean,
//   CNumber,
//   CString,
//   CDataOptions,
//   SchemaValue,
//   WalkOptions,
//   WalkTrace,
//   SCData,
//   SCDataScalar,
//   SCDataArray,
//   SCDataArrayItem,
//   SCDataObject
// };
import { isInteger, isNumeric } from "./util.js";
import type { JSONXMLNode } from "./util.js";
import { getLogger } from "@modkit/codec-kit";

const schemaLog = getLogger(["schema", "enum"]);



export const TypeFlags = {
  JSON: 1,
  Attribute: 2,
  Instruction: 4,
  Default: 8,
  Tag: 16,
  PreventInheritance: 32,
  Use: 64,
}


// --- Type Definitions ---
type Ctor<T = any> = new (...args: any[]) => T;
export type ScalarTypeDefinition = string | (abstract new (...args: any[]) => any) | typeof Number | typeof String | typeof Boolean;

// Improved SchemaOf type to properly extract schema
export type SchemaOf<T> = T extends { schema: infer S } ? S : never;

// Utility type to extract schema input types
export type TypeOf<T> = T extends abstract new (...args: any[]) => CScalar<infer V> ? V : any;

export type ExtractSchemaInput<T extends Record<string, any>> = {
  [K in keyof T]?: T[K] extends { schema: infer S }
  ? (S extends Record<string, any> ? ExtractSchemaInput<S> : never)
  : T[K] extends { index: any, value: any }
  ? ExtractRecordInput<T[K]>
  : T[K] extends { list: infer L }
  ? (L extends Ctor<infer E> ? (E extends CEnum<infer EV> ? Partial<Record<EV, boolean>> : never) : never)
  : T[K] extends Ctor<infer U>
  ? (U extends { __cEnumBrand: infer EV extends string } ? EV
    : U extends { value: infer V } ? V
    : U extends CFlags<infer F> ? Partial<Record<F, boolean>>
    : U extends CTuple ? ReadonlyArray<any>
    : U extends CRecord ? ExtractRecordInput<T[K]>
    : never)
  : T[K] extends readonly [infer U]
  ? (U extends { schema: infer S }
    ? (S extends Record<string, any> ? ExtractSchemaInput<S>[] : never)
    : U extends { index: any, value: any }
    ? ExtractRecordInput<U>[]
    : U extends Ctor<infer V>
    ? (V extends { __cEnumBrand: infer EK extends string } ? EK[]
      : V extends { value: infer W } ? W[]
      : V extends CFlags<infer F> ? Partial<Record<F, boolean>>[]
      : V extends CTuple ? ReadonlyArray<any>[]
      : V extends CRecord ? ExtractRecordInput<U>[]
      : never)
    : never)
  : never;
};

type ExtractRecordInput<T> =
  T extends { index: infer I; value: infer V }
  ? I extends new (...args: any[]) => infer X
    ? X extends CEnum<infer K>
      ? (V extends { schema: infer S }
        ? (S extends Record<string, any> ? Partial<Record<K, ExtractSchemaInput<S>>> : never)
        : (V extends new (...args: any[]) => infer U
          ? (U extends { __cEnumBrand: infer EV extends string } ? Partial<Record<K, EV>>
            : U extends { value: infer W } ? Partial<Record<K, W>>
            : never)
          : never)
      )
      : never
    : T extends new (...args: any[]) => CRecord ? any // Fallback
    : never
  : never;

// Schema output types (for instance properties)
export type SchemaOutput<T extends Record<string, any>> = {
  [K in keyof T]: T[K] extends { schema: infer S }
  ? S extends Record<string, any> ? SchemaOutput<S> : never
  : T[K] extends { index: any, value: any }
  ? ExtractRecordOutput<T[K]>
  : T[K] extends { list: infer L }
  ? (L extends Ctor<infer E> ? (E extends CEnum<infer EV> ? Record<EV, boolean> : never) : never)
  : T[K] extends Ctor<infer U>
  ? (U extends { __cEnumBrand: infer EV extends string } ? EV
    : U extends { value: infer V } ? V
    : U extends CFlags<infer F> ? Record<F, boolean>
    : U extends CTuple ? ReadonlyArray<any>
    : U extends CRecord ? ExtractRecordOutput<T[K]>
    : never)
  : T[K] extends readonly [infer U]
  ? (U extends { schema: infer S }
    ? (S extends Record<string, any> ? SchemaOutput<S>[] : never)
    : U extends { index: any, value: any }
    ? ExtractRecordOutput<U>[]
    : U extends Ctor<infer V>
    ? (V extends { __cEnumBrand: infer EK extends string } ? EK[]
      : V extends { value: infer W } ? W[]
      : V extends CFlags<infer F> ? Record<F, boolean>[]
      : V extends CTuple ? ReadonlyArray<any>[]
      : V extends CRecord ? ExtractRecordOutput<U>[]
      : never)
    : never)
  : never;
};

type ExtractRecordOutput<T> =
  T extends { index: infer I; value: infer V }
  ? I extends new (...args: any[]) => infer X
    ? X extends CEnum<infer K>
      ? (V extends { schema: infer S }
        ? (S extends Record<string, any> ? Record<K, SchemaOutput<S>> : never)
        : (V extends new (...args: any[]) => infer U
          ? (U extends { __cEnumBrand: infer EV extends string } ? Record<K, EV>
            : U extends { value: infer W } ? Record<K, W>
            : never)
          : never)
      )
      : never
    : T extends new (...args: any[]) => CRecord ? any // Fallback
    : never
  : never;

type IsAny<T> = 0 extends (1 & T) ? true : false;
type MergeSchemas<A, B> = IsAny<A> extends true
  ? B
  : { [K in keyof A | keyof B]: K extends keyof B ? B[K] : K extends keyof A ? A[K] : never };

type CObjectBase = { schema: any; new(...args: any[]): any; Ex: any };

export type CObjectConstructor<T extends Record<string, any> = Record<string, never>> = {
  new(options?: ExtractSchemaInput<T> & Record<string, any>): CObject<T> & SchemaOutput<T>;
  schema: T;
  Ex: <TThis extends CObjectBase, TSchema extends Record<string, any>>(this: TThis, schema: TSchema) => CObjectConstructor<MergeSchemas<TThis['schema'], TSchema>>;
};

// --- Core Classes ---

export abstract class CDataFields<T extends SCDataObject = SCDataObject> extends SchemaValue<T> {
  override group = true;
  computeField(merged: SCDataObject, chain: SCDataObject[], field: string, schema: SchemaValue<any>, resolve: boolean) {
    if (schema.computable) {
      const values: any[] = [];
      for (let i = 0; i < chain.length; i++) {
        if (chain[i]![field] !== undefined) values.push(chain[i]![field]);
      }
      if (values.length === 0) return;
      merged[field] = schema.compute(values, resolve);
    } else {
      let i = chain.length - 1;
      do {
        if (chain[i]![field] !== undefined) {
          merged[field] = chain[i]![field];
          break;
        }
      } while (i--);
    }
  }

  getChainFields(chain: T[]) {
    const keys = new Set<string>();
    for (const item of chain) for (const key in item) keys.add(key);
    return keys;
  }
}

export class CEnum<T extends string = string> extends CScalar<T> {
  declare readonly __cEnumBrand: T; // phantom brand вЂ” prevents structural false-matches with CNumber
  static enum: readonly string[];
  enum?: readonly string[];
  unknown?: string;
  missing?: string[];

  constructor(options: any = {}) {
    super(options);
    if (options.list) this.enum = options.list;
    if (options.unknown) this.unknown = options.unknown;
  }

  static Ex<E extends Record<string, string | number>>(e: E): {
    new(options?: any): CEnum<Extract<keyof E, string>> & { [K in Extract<keyof E, string>]: boolean };
    enum: Extract<keyof E, string>[];
    Ex: typeof CEnum.Ex;
    FromArray: typeof CEnum.FromArray;
    prototype: CEnum<any>;
  } & Omit<typeof CEnum, 'new'> {
    type Keys = Extract<keyof E, string>;
    const keys = Object.keys(e).filter(k => isNaN(Number(k))) as Keys[];
    const cls = class extends (this as any) {
      static enum = keys;
      enum = keys;
    };
    return cls as any;
  }

  static FromArray<T extends string>(list: readonly T[]): {
    new(options?: any): CEnum<T>;
    enum: readonly T[];
    Ex: typeof CEnum.Ex;
    FromArray: typeof CEnum.FromArray;
    prototype: CEnum<any>;
  } & Omit<typeof CEnum, 'new'> {
    const cls = class extends (this as any) {
      static enum = list;
      enum = list;
    };
    return cls as any;
  }

  override validate(val: string): boolean {
    const unknown = this.unknown || "Unknown";
    if (val === unknown) return true;
    if (!this.enum?.includes(val)) return false;
    return true;
  }

  override fromString(val: string): T {
    if (this.validate(val)) return val as T;
    if (isInteger(val)) {
      return (this.getEnumName(+val) ?? val) as T;
    }
    return val as T;
  }

  getEnumName(value: number) {
    return value === -1 ? this.unknown : this.enum?.[value];
  }

  log(val: string, trace?: string[], category: string = "Error", message: string = "") {
    schemaLog.info(`[${category}] ${message || val} ${trace ? '(' + trace.join('.') + ')' : ''}`);
  }
}

/**
 * List of scalar items, e.g. "a,b,c" or "1;2;3".
 */
export class CList extends CScalar<any[]> {
  separator: string = ",";
  itemType: SchemaValue;

  constructor(options: { type: ScalarTypeDefinition, separator?: string } & CDataOptions) {
    super(options);
    if (options.separator) this.separator = options.separator;
    this.itemType = this.schema.getType(options.type);
  }

  override fromString(str: string): any[] {
    return str.split(this.separator).filter(Boolean).map(v => this.itemType.fromString(v));
  }

  override toString(obj: any[]): string {
    return obj.map(v => this.itemType.toString(v)).join(this.separator);
  }
}

/**
 * String-based array with factory methods.
 */
export class CStringArray<T = any[]> extends CScalar<T> {
  separator: string = ",";
  itemType?: SchemaValue;
  size?: number;

  /** Static item type for introspection (relations/rename walkers). */
  static memberType?: ScalarTypeDefinition

  static Ex<TType extends ScalarTypeDefinition, TSize extends number | undefined = undefined>(type: TType, size?: TSize): any {
    // NB: extend `this` (CSArray/CWArray/CCArray), not CStringArray — the subclass
    // must keep the separator of the class Ex() was called on.
    return class extends (this as any) {
      static memberType = type;
      constructor(opts: CDataOptions = {}) {
        super({ ...opts });
        (this as unknown as CStringArray).itemType = (this as unknown as CStringArray).schema.getType(type);
        if (size !== undefined) (this as unknown as CStringArray).size = size;
      }
    };
  }

  override fromString(str: string): any {
    if (!this.itemType) return [];
    return str.split(this.separator).filter(Boolean).map(v => this.itemType!.fromString(v));
  }

  override toString(obj: any): string {
    if (!this.itemType) return "";
    return (obj as any[]).map(v => this.itemType!.toString(v)).join(this.separator);
  }
}

export class CCArray<T = any[]> extends CStringArray<T> { override separator = ',' }
export class CSArray<T = any[]> extends CStringArray<T> { override separator = ';' }
export class CWArray<T = any[]> extends CStringArray<T> { override separator = ' ' }

/**
 * Tuple of fixed types, e.g. "255,128,64".
 */
export class CTuple extends SchemaValue<any[]> {
  override group = true;
  types: SchemaValue[];
  separator: string = ",";

  constructor(options: { types: ScalarTypeDefinition[], separator?: string } & CDataOptions) {
    super(options);
    this.types = options.types.map(t => this.schema.getType(t));
    if (options.separator) this.separator = options.separator;
  }

  /** Static member types for introspection (relations/rename walkers). */
  static memberTypes?: ScalarTypeDefinition[]

  static Ex<T extends ScalarTypeDefinition[]>(...types: T): any {
    const cls = class extends (this as any) {
      static memberTypes = types;
      constructor(opts: any = {}) {
        super({ ...opts, types });
      }
    };
    return cls as any;
  }

  override fromString(str: string): any[] {
    const parts = str.split(this.separator);
    return this.types.map((t, i) => t.fromString(parts[i] || ''));
  }

  override toString(obj: any[]): string {
    return this.types.map((t, i) => t.toString(obj[i])).join(this.separator);
  }

  override _walkNode(object: any[], options: WalkOptions) {
    const trace = options.trace;
    const crumb = { object, schema: this, property: '' } as WalkTrace;
    trace.push(crumb);
    for (let i = 0; i < this.types.length; i++) {
      crumb.property = i;
      const type = this.types[i]!;
      const result = options.before?.(object, i, object[i], type, trace);
      if (result !== false) {
        if (!type.scalar) type._walkNode(object[i], options);
        options.after?.(object, i, object[i], type, trace);
      }
    }
    trace.pop();
  }
}

export class CWTuple<T> extends CTuple { override separator = ' ' }
export class CCTuple<T> extends CTuple { override separator = ',' }
export class CSTuple<T> extends CTuple { override separator = ';' }
export class CDTuple<T> extends CTuple { override separator = '.' }
export class COTuple<T> extends CTuple { override separator = ':' }

export class CVariator<T extends SCData = number> extends CScalar<[T] | [T, T]> {
  separator: string = ",";
  itemType!: SchemaValue;

  constructor(options: { type?: ScalarTypeDefinition, separator?: string } & CDataOptions = {}) {
    super(options);
    if (typeof options === 'object' && options !== null && !Array.isArray(options)) {
      if (options.type) this.itemType = this.schema.getType(options.type);
      if (options.separator) this.separator = options.separator;
    }
  }

  static Ex<T extends ScalarTypeDefinition>(type: T): any {
    const cls = class extends (this as any) {
      constructor(opts: any = {}) {
        super({ ...opts, type });
      }
    };
    return cls as any;
  }

  override fromString(str: string): [T] | [T, T] {
    if (!this.itemType) return [0 as any];
    const parts = str.split(this.separator).map(v => this.itemType.fromString(v));
    return parts.slice(0, 2) as [T] | [T, T];
  }

  override toString(obj: [T] | [T, T]): string {
    if (!this.itemType) return "";
    return obj.map(v => this.itemType.toString(v)).join(this.separator);
  }
}

export class CRecord extends CDataFields {
  static index: Ctor<any>;
  static value: Ctor<any>;
  indexField: string = "index";
  override computable = true;

  constructor(options?: any) {
    super(options);
    if (options) {
      Object.assign(this, options);
    }
  }

  static Ex<I extends Ctor<any>, VCls extends Ctor<any>>(index: I, value: VCls): typeof CRecord & { new(options?: any): CRecord; index: I; value: VCls } {
    const cls = class extends (this as any) {
      static index = index;
      static value = value;
    };
    return cls as any;
  }

  override toXML(data: SCDataObject): JSONXMLNode[] {
    const result: JSONXMLNode[] = [];
    const valueType = (this.constructor as any).value.prototype as SchemaValue;
    for (const index in data) {
      const item = data[index];
      const base = valueType.toXML(item);
      result.push({
        ...base,
        attributes: {
          ...base.attributes,
          [this.indexField]: index
        }
      });
    }
    return result;
  }

  override compute(chain: SCDataObject[], resolve: boolean = false): SCDataObject {
    const keys = this.getChainFields(chain);
    const merged = {} as SCDataObject;
    const valueType = (this.constructor as any).value.prototype as SchemaValue;
    for (const field of keys) {
      this.computeField(merged, chain, field, valueType, resolve);
    }
    return merged;
  }

  override _walkNode(object: SCDataObject, options: WalkOptions) {
    const trace = options.trace;
    const valueType = (this.constructor as any).value.prototype as SchemaValue;
    const indexType = (this.constructor as any).index.prototype as CEnum;
    const keys = Object.keys(object);
    const crumb = { object, schema: this, property: '' } as WalkTrace;
    trace.push(crumb);
    for (const key of keys) {
      crumb.property = key;
      const item = object[key];
      const recorditem = { [this.indexField]: key };
      const result = options.before?.(recorditem, this.indexField, recorditem[this.indexField], indexType, trace);
      if (recorditem[this.indexField] !== key) {
        delete object[key];
        object[recorditem[this.indexField] as string] = item;
      }
      if (result !== false) {
        if (!valueType.scalar) valueType._walkNode(item, options);
        options.after?.(recorditem, this.indexField, recorditem[this.indexField], indexType, trace);
      }
    }
    trace.pop();
  }
}

/**
 * Specialized SchemaRecord used in lib_schema.
 */
export class SchemaRecord extends CRecord {
  type!: SchemaValue;
  list!: CEnum;

  constructor(options: { type: string | SchemaValue, index?: string, list: string } & CDataOptions) {
    super(options);
    if (options.index) this.indexField = options.index;
    this.initTypes(options.type, options.list);
  }

  private initTypes(type: string | SchemaValue, list: string) {
    this.type = typeof type === 'string' ? this.schema.getType(type) : type;
    this.list = this.schema.enums[list] as CEnum;
    (this.constructor as any).value = { prototype: this.type };
    (this.constructor as any).index = { prototype: this.list };
  }

  override compute(chain: SCDataObject[], resolve: boolean = false): SCDataObject {
    const keys = this.getChainFields(chain);
    const merged = {} as SCDataObject;
    for (const field of keys) {
      this.computeField(merged, chain, field, this.type, resolve);
    }
    return merged;
  }
}

/**
 * Flags collection saved as a semicolon-separated string.
 */
export class CFlags<T extends string = string> extends SchemaValue<Record<T, boolean>> {
  override group = true;
  list?: CEnum;

  constructor(options: ({ list: string } & CDataOptions) | Record<T, boolean>) {
    // If it's a schema definition
    if (typeof options === 'object' && 'list' in options && typeof options.list === 'string') {
      super(options);
      if (this.schema?.enums) {
        this.list = this.schema.enums[options.list] as CEnum;
      }
    } else {
      // If it's a data instance
      super();
      Object.assign(this, options);
    }
  }

  static Ex<T extends string>(
    list: (new (...args: any[]) => CEnum<T>) | CEnum<T> | T[]
  ): {
    new(init?: Partial<Record<T, boolean>>): CFlags<T> & Record<T, boolean>;
    list: T[];
    prototype: CFlags<T> & Record<T, boolean>;
  } {
    const keys = (typeof list === "function" && "enum" in list) ? (list as any).enum : (list instanceof CEnum ? list.enum : (Array.isArray(list) ? list : []));

    const cls = class extends CFlags<T> {
      static list = keys;
      constructor(init?: Partial<Record<T, boolean>>) {
        super({ list: keys });
        for (const key of (keys || [])) {
          (this as any)[key] = false;
        }
        if (init) {
          for (const key in init) {
            (this as any)[key] = init[key];
          }
        }
      }
    };
    return cls as any;
  }

  override fromString(str: string): Record<string, boolean> {
    const result: Record<string, boolean> = {};
    str.split(";").filter(Boolean).forEach(p => {
      result[p] = true;
    });
    return result;
  }

  override toString(obj: Record<string, boolean>): string {
    return Object.keys(obj).filter(k => obj[k]).join(";");
  }

  override _walkNode(object: Record<string, boolean>, options: WalkOptions) {
    const trace = options.trace;
    const crumb = { object, schema: this, property: '' } as WalkTrace;
    trace.push(crumb);
    for (const key in object) {
      crumb.property = key;
      const result = options.before?.(object, key, object[key], this.list!, trace);
      if (result !== false) options.after?.(object, key, object[key], this.list!, trace);
    }
    trace.pop();
  }
}

/**
 * Array of items. Supports index/removed tags for SC2 diffing.
 */
export class CArray extends SchemaValue<SCDataArray> {
  override array = true;
  type: SchemaValue;

  constructor(options: { type: string | SchemaValue } & CDataOptions) {
    super(options);
    this.type = typeof options.type === 'string' ? this.schema.getType(options.type) : options.type;
  }

  override compute(chain: SCDataArray[], resolve: boolean = false): SCDataArray {
    return chain.flat();
  }

  override _walkNode(object: SCDataArray, options: WalkOptions) {
    const trace = options.trace, type = this.type;
    const crumb = { object, schema: this, property: '' } as WalkTrace;
    trace.push(crumb);
    for (let i = 0; i < object.length; i++) {
      crumb.property = i;
      const item = object[i];
      const result = options.before?.(object, i, item, type, trace);
      if (result !== false) {
        if (!type.scalar) type._walkNode(item, options);
        options.after?.(object, i, item, type, trace);
      }
    }
    trace.pop();
  }
}

// --- CObject with Proper Typings ---
export class CObject<T extends Record<string, any> = Record<string, never>> extends CDataFields<T> {
  static schema: any = {};
  static Ex: <TThis extends CObjectBase, TSchema extends Record<string, any>>(this: TThis, schema: TSchema) => CObjectConstructor<MergeSchemas<TThis['schema'], TSchema>>;
  override computable = true;

  constructor(options?: ExtractSchemaInput<T>) {
    super(options as any);
    if (options) {
      Object.assign(this, options);
    }
  }

  static getMergedSchema(): Record<string, any> {
    const merged: Record<string, any> = {};
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let current: any = this;
    while (current && current.schema) {
      Object.assign(merged, current.schema);
      current = Object.getPrototypeOf(current);
    }
    return merged;
  }

  override toXML(data: T): any {
    const schema = (this.constructor as any).getMergedSchema();
    const node: any = {
      tag: (data as any).class || this.name,
      attributes: {},
      children: []
    };

    for (const [field, value] of Object.entries(data)) {
      const fType = schema[field];
      if (!fType) continue;
      const fschema = fType.prototype as SchemaValue;

      if (fschema.attribute) {
        node.attributes![field] = fschema.toXML(value as SCData) as string;
      } else {
        const childNode = fschema.toXML(value as SCData);
        if (Array.isArray(childNode)) {
          node.children!.push(...childNode);
        } else if (childNode) {
          node.children!.push(childNode);
        }
      }
    }
    return node;
  }
}

// Add the Ex method to CObject after class definition
CObject.Ex = function <TThis extends CObjectBase, TSchema extends Record<string, any>>(this: TThis, schema: TSchema): CObjectConstructor<MergeSchemas<TThis['schema'], TSchema>> {
  const base = this as any;
  const baseSchema = base.schema || {};
  const mergedSchema = { ...baseSchema, ...schema } as MergeSchemas<TThis['schema'], TSchema>;

  const NewClass = class extends base {
    static schema = mergedSchema;

    constructor(options?: ExtractSchemaInput<MergeSchemas<TThis['schema'], TSchema>> & Record<string, any>) {
      super(options as any);

      // Process each field according to its type with validation
      for (const key in mergedSchema) {
        if (!options || !(key in options)) continue;

        const type = mergedSchema[key];
        const val = (options as any)[key];

        if (type && type.prototype instanceof CScalar) {
          const scalar = new type({ schema: (this as any).schema, value: val });
          if (!scalar.validate(scalar.value)) {
            throw new TypeError(`Validation failed for field "${key}": ${val}`);
          }
          (this as any)[key] = scalar.value;
        } else if (Array.isArray(type)) {
          const inner = type[0];
          (this as any)[key] = (val as any[]).map((v: any) => {
            if (inner.prototype instanceof CScalar) {
              const s = new inner({ schema: (this as any).schema, value: v });
              if (!s.validate(s.value)) throw new TypeError(`Validation failed for field "${key}": ${v}`);
              return s.value;
            }
            if (inner.prototype instanceof CObject) return new inner(v);
            return v;
          });
        } else if (type && type.prototype instanceof CRecord) {
          (this as any)[key] = new type({ schema: (this as any).schema, ...val });
        } else if (type && (type.prototype instanceof CObject || type.prototype instanceof CRecord)) {
          (this as any)[key] = new type({ schema: (this as any).schema, ...val });
        } else {
          (this as any)[key] = val;
        }
      }
    }
  } as unknown as CObjectConstructor<MergeSchemas<TThis['schema'], TSchema>>;

  (NewClass as any).Ex = CObject.Ex;
  return NewClass;
};

// Re-export primitives already exported at the top



