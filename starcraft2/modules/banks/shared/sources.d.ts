export function bankSectionId(bankId: any, index: any): string;
export function bankKeyId(bankId: any, sectionIndex: any, keyIndex: any): string;
export function createBankSources(bank: any, options: any): Readonly<{
    factsSource: import("@modkit/sdk").SubjectFactsSource;
    relationGraphSource: import("@modkit/sdk").RelationGraphSource;
}>;
export function createBankListSources(bankList: any, options: any): Readonly<{
    factsSource: import("@modkit/sdk").SubjectFactsSource;
    relationGraphSource: import("@modkit/sdk").RelationGraphSource;
}>;
import { createRelationGraphSource } from '@modkit/codec-kit';
import { createSubjectFactsSource } from '@modkit/codec-kit';
export function fact(source: any, id: any, label: any, value: any, semanticPath: any): import("@modkit/sdk").SubjectFact;
export const provenance: typeof provenanceOf;
import { provenanceOf } from '@modkit/codec-kit';
export { createRelationGraphSource, createSubjectFactsSource };
//# sourceMappingURL=sources.d.ts.map