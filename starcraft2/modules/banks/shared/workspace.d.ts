/**
 * Inspect Banks, BankList and literal Galaxy BankLoad calls only through an already-mounted SC2
 * namespace. Optional malformed or over-budget documents make the semantic graph partial without
 * making the package itself unreadable.
 */
export function inspectSc2BankWorkspace(options: any): Promise<Readonly<{
    summary: Readonly<{
        bankLists: number;
        declaredBanks: number;
        bankFiles: any;
        parsedBankFiles: number;
        bankSections: number;
        bankKeys: number;
        bankNames: readonly any[];
        galaxyBankLoads: number;
        dynamicGalaxyBankLoads: number;
        semanticFilesRead: number;
        semanticBytesRead: number;
    }>;
    facts: readonly import("@modkit/sdk").SubjectFact[];
    relations: readonly Readonly<{
        role: "declares-bank" | "references-bank";
        subjectId: string;
        label: any;
        kind: "sc2-bank";
        provenance: readonly import("@modkit/sdk").SubjectFactProvenance[];
    }>[];
    tableRows: readonly any[][];
    treeNode: Readonly<{
        kind: "banks";
        label: "Banks";
        preview: `${number} bank(s), ${number} key(s)`;
        children: {
            kind: string;
            label: string;
            preview: string;
            children: {
                kind: string;
                label: any;
                preview: string;
                children: {
                    kind: string;
                    label: any;
                    preview: string | undefined;
                }[];
            }[];
        }[];
    }>;
    diagnostics: readonly any[];
    relationGraphSource: import("@modkit/sdk").RelationGraphSource;
}>>;
//# sourceMappingURL=workspace.d.ts.map