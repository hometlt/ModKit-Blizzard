export function decodeXmlValue(value: any): any;
export function coerceSc2BankValue(value: any): any;
/** Parse one authored SC2Bank without normalizing or mutating its source text. */
export function parseSc2Bank(text: any, budget: any): Readonly<{
    version: any;
    attributes: Readonly<{}>;
    sections: readonly Readonly<{
        name: any;
        attributes: Readonly<{}>;
        keys: readonly Readonly<{
            value?: Readonly<{
                semantic: any;
                type: string | undefined;
                value: any;
            }>;
            name: any;
            attributes: Readonly<{}>;
        }>[];
    }>[];
    signature: any;
    elementCount: number;
}>;
/** Parse BankList/BankList.xml metadata. Player is optional for shared banks. */
export function parseSc2BankList(text: any, budget: any): Readonly<{
    banks: readonly Readonly<{
        attributes: Readonly<{}>;
        player?: any;
        name: any;
    }>[];
    elementCount: number;
}>;
/**
 * Resolve only literal BankLoad("name", player) calls. Dynamic names remain an explicit count;
 * they are never guessed from identifiers or nearby BankList entries.
 */
export function scanGalaxyBankLoads(text: any, budget: any): Readonly<{
    calls: readonly Readonly<{
        offset: number;
        player?: number;
        name: any;
        playerExpression: string;
    }>[];
    dynamicCalls: number;
}>;
export function bankNameFromPath(path: any): string;
export function bankIdentity(name: any): string;
//# sourceMappingURL=model.d.ts.map