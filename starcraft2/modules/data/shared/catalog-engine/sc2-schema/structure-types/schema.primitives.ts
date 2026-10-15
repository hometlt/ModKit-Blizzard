import { isInteger, isNumeric, isValidNumber } from "./util.js";

// --- Type Definitions ---
export type SCDataScalar = string | number | boolean
export type SCDataArrayItem<T = any> = { index: number, removed?: boolean, value?: T }
export type SCDataArray = (any)[]
export type SCDataObject = { [K in string]?: any }
export type SCData = SCDataScalar | SCDataArray | SCDataObject

export type WalkTrace = { object: SCData, schema: SchemaValue<any>, property: string | number }
export type WalkOptions = {
  trace: WalkTrace[],
  context?: any,
  before?: (receiver: any, property: string | number, value: any, schema: SchemaValue<any>, trace: WalkTrace[]) => void | boolean,
  after?: (receiver: any, property: string | number, value: any, schema: SchemaValue<any>, trace: WalkTrace[]) => void | boolean,
  modifyProperty?: boolean
}

/**
 * Base class for all data types. Provides default validation and relation logic.
 */
export interface CDataOptions {
  name?: string;
  path?: string;
  schema?: any; // Will be properly typed once SCHEMA is refactored
}

export abstract class SchemaValue<T = SCData> {
  name: string;
  path?: string;
  schema?: any;
  group?: boolean;
  array?: boolean;
  scalar?: boolean;
  computable?: boolean;
  preventinheritance?: boolean;

  attribute?: boolean;
  saveAsString?: boolean;
  writeAsString?: boolean;
  keepAsString?: boolean;

  constructor(options: CDataOptions = {}) {
    this.name = options.name || this.constructor.name;
    if (options.path !== undefined) this.path = options.path;
    this.schema = options.schema;
  }

  init() { }
  validate(value: T): boolean { return true; }
  fromString(str: string): any { return str; }
  toString(obj: T): string { return String(obj); }
  toXML(obj: T): any {
    return {
      tag: this.name,
      attributes: {
        value: this.toString(obj)
      }
    };
  }

  compute(chain: T[], resolve: boolean = false): T {
    return chain[chain.length - 1]!;
  }

  _walkNode(value: T, options: WalkOptions): void { }

  makeObject(attributes: Record<string, string>): any {
    return attributes;
  }
}

/**
 * Base class for all scalar-like types.
 */
export abstract class CScalar<T = any> extends SchemaValue<T> {
  override scalar: boolean = true;
  declare value: T;

  constructor(options: string | number | boolean | (CDataOptions & { value?: T }) = {}) {
    if (typeof options === "object" && options !== null) {
      super(options as CDataOptions);
      if ("value" in options) this.value = (options as any).value;
    } else {
      super();
      this.value = options as T;
    }
  }

  override toString(obj: T): string {
    return String(obj);
  }

  static Dyn<R = any>(resolverOrType: ((data: any, mod: any) => R) | any): typeof CScalar & { new(options?: any): CScalar<any> } {
    if (typeof resolverOrType === 'function' && resolverOrType.length > 0) {
      const cls = class extends (this as any) {
        static resolver = resolverOrType;
        constructor(options: any = {}) {
          super(options);
        }
      };
      return cls as any;
    } else {
      const cls = class extends (this as any) {
        static type = resolverOrType;
        constructor(options: any = {}) {
          super(options);
        }
      };
      return cls as any;
    }
  }

  static Union(...types: any[]): typeof CScalar & { new(options?: any): CScalar<any> } {
    const cls = class extends (this as any) {
      static types = types;
      constructor(options: any = {}) {
        super(options);
      }
    };
    return cls as any;
  }
}

export class CBoolean extends CScalar<boolean> {
  constructor(options: boolean | CDataOptions = {}) {
    super(options as any);
  }
  override fromString(str: string): boolean { return str === "1"; }
  override toString(obj: boolean): string { return obj ? '1' : '0'; }
}

/**
 * Numbers. Supports integer and float with optional bounds.
 */
export interface NumberOptions extends CDataOptions {
  min?: number;
  max?: number;
  float?: boolean;
  value?: number;
  pad?: number;
}

export class CNumber extends CScalar<number> {
  min?: number;
  max?: number;
  float?: boolean;

  constructor(options: number | NumberOptions = {}) {
    super(options as any);
    if (typeof options === "object") {
      if (options.min !== undefined) this.min = options.min;
      if (options.max !== undefined) this.max = options.max;
      if (options.float !== undefined) this.float = options.float;
    }
  }

  override validate(val: number | string): boolean {
    if (!isValidNumber(val)) return false;
    const num = typeof val === "string" ? Number(val) : val;
    if (typeof num !== "number" || !isFinite(num)) return false;
    if (!this.float && !Number.isInteger(num)) return false;
    if (this.min !== undefined && num < this.min) return false;
    if (this.max !== undefined && num > this.max) return false;
    return true;
  }

  override fromString(str: string): number { return +str; }
  override toString(obj: number): string { return String(obj); }

  static Int<T extends number = number>(min?: number, max?: number, extraOpts?: NumberOptions): typeof CNumber & { new(opts?: number | NumberOptions): CNumber } {
    const cls = class extends (this as any) {
      constructor(opts: number | NumberOptions = {}) {
        super(typeof opts === 'number' ? { value: opts, min, max, float: false, ...extraOpts } : { ...opts, min, max, float: false, ...extraOpts });
      }
    };
    return cls as any;
  }
  static Real<T extends number = number>(min?: number, max?: number, extraOpts?: NumberOptions): typeof CNumber & { new(opts?: number | NumberOptions): CNumber } {
    const cls = class extends (this as any) {
      constructor(opts: number | NumberOptions = {}) {
        super(typeof opts === 'number' ? { value: opts, min, max, float: true, ...extraOpts } : { ...opts, min, max, float: true, ...extraOpts });
      }
    };
    return cls as any;
  }
  static UInt<T extends number = number>(max?: number, extraOpts?: NumberOptions): typeof CNumber & { new(opts?: number | NumberOptions): CNumber } {
    const cls = class extends (this as any) {
      constructor(opts: number | NumberOptions = {}) {
        super(typeof opts === 'number' ? { value: opts, min: 0, max, float: false, ...extraOpts } : { ...opts, min: 0, max, float: false, ...extraOpts });
      }
    };
    return cls as any;
  }
  static UReal(max?: number) {
    return class extends this {
      constructor(opts: number | NumberOptions = {}) {
        const maxOpt = max !== undefined ? { max } : {};
        super(typeof opts === 'number' ? { value: opts, min: 0, ...maxOpt, float: true } : { ...opts, min: 0, ...maxOpt, float: true });
      }
    };
  }
}

/**
 * String type with optional max length and regex validation.
 */
export interface CStringOptions extends CDataOptions {
  regexp?: RegExp;
  maxlength?: number;
  value?: string;
}

export class CString extends CScalar<string> {
  regexp?: RegExp;
  maxlength: number = 0;

  constructor(options: string | CStringOptions = {}) {
    super(options as any);
    if (typeof options === "object") {
      if (options.regexp) this.regexp = options.regexp;
      if (options.maxlength) this.maxlength = options.maxlength;
    }
  }

  override validate(str: string): boolean {
    if (typeof str !== "string") return false;
    if (this.maxlength && str.length > this.maxlength) return false;
    if (this.regexp && !this.regexp.test(str)) return false;
    return true;
  }

  override fromString(str: string): string {
    return str.replace(/"|&/g, s => s === '"' ? "&quot;" : "&amp;");
  }

  override toString(obj: string): string {
    return obj;
  }

  static Len<T extends string = string>(length: number): {
    new(opts?: T | CStringOptions): CString & { value?: T };
    prototype: CString & { value?: T };
  } {
    const cls = class extends (this as any) {
      constructor(opts: string | CStringOptions = {}) {
        super(typeof opts === 'string' ? { value: opts, maxlength: length } : { ...opts, maxlength: length });
      }
    };
    return cls as any;
  }
}

/**
 * Base class for SC2 asset file types.
 */
export interface CFileOptions {
  extensions?: string[];
}
export class CFile extends CScalar<string> {
  extensions?: string[];
  regexp: RegExp;

  constructor(options: CFileOptions & CDataOptions = {}) {
    super(options);
    if (options.extensions) this.extensions = options.extensions;
    this.regexp = new RegExp(`^[a-z_#'0-9-]+[\\/a-z_#'0-9-. ]+.(${this.extensions?.join("|") || "[a-z0-9]+"})$`, "i");
  }

  override validate(value: string): boolean {
    return (this.regexp as RegExp).test(value);
  }
}

/**
 * Catalog link type.
 */
export interface CLinkOptions {
  catalog: string;
}
export class CLink1 extends CScalar<string> {
  catalog: string = "Unknown";

  constructor(options: CLinkOptions & CDataOptions = { catalog: "Unknown" }) {
    super(options);
    if (options.catalog) this.catalog = options.catalog;
  }

  override validate(val: string) {
    return /^[^\s]+$/.test(val);
  }
}
export abstract class CLink extends CScalar<string> {
  static link: string
  static Ex(link: string) {
    return class extends this {
      static override link = link;
      constructor(value: string) {
        super(value)
      }
    }
  }
  static FromNamespace(nameSpace: string): typeof CLink {
    if (!this.Links[nameSpace]) {
      this.Links[nameSpace] = CLink.Ex(nameSpace)
    }
    return this.Links[nameSpace]
  }
  static Links = {} as Record<string, typeof CLink>
}

export class CWord extends CString {
  constructor(options: string | CStringOptions = {}) {
    super(options);
    this.regexp = /^\S+$/;
  }
}

export class CDynamic extends CScalar<string> {
  field!: string;
  constructor(options: { field: string } & CDataOptions) {
    super(options);
    this.field = options.field;
  }
}

export class CInstruction extends CScalar<string> {
  override keepAsString = true;
  override writeAsString = true;
}

export class CSObject<T = SCDataObject> extends CScalar<T> {
  constructor(options: T | CDataOptions = {} as T) {
    super(options as any);
    if (typeof options === "object" && options !== null && !(options as any).schema) {
      Object.assign(this, options);
    }
  }
}
