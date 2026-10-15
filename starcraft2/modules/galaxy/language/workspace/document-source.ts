import type { LanguageDocument } from '@modkit/sdk/language';
import type { GalaxyLspSnapshot, GalaxyLspSnapshotScope } from '../lsp-feature-adapter.js';

export interface GalaxyIndexedDocument {
    readonly fileName: string;
    readonly text: string;
}

export interface GalaxyDocumentIndex {
    readonly documents: ReadonlyMap<string, GalaxyIndexedDocument>;
    readonly lazyFileCount: number;
    getDocument(uri: string): GalaxyIndexedDocument | undefined;
}

export interface GalaxyOpenDocument {
    readonly uri: string;
    readonly languageId: string;
    readonly version: number;
    getText(): string;
}

export interface GalaxyOpenDocuments {
    get(uri: string): GalaxyOpenDocument | undefined;
    all(): readonly GalaxyOpenDocument[];
}

export interface GalaxyWorkspaceDocumentSourceOptions {
    readonly maximumDocuments?: number;
    readonly preparePrimary?: (uri: string, signal?: AbortSignal) => void | Promise<void>;
    readonly prepareWorkspace?: (signal?: AbortSignal) => void | Promise<void>;
    readonly isCurrentWorkspaceDocument?: (uri: string) => boolean;
    readonly isEditableDocument?: (uri: string) => boolean;
}

/** Structural form of the MK3 host dependency-document request. */
export interface GalaxyHostDocumentSourceRequest {
    readonly document: LanguageDocument;
    readonly workspaceDocuments: readonly LanguageDocument[];
    readonly workspaceLanguageIds: readonly string[];
    readonly maxDocuments: number;
    readonly signal: AbortSignal;
}

export interface GalaxyHostDocumentSourceResult {
    readonly documents: readonly LanguageDocument[];
    readonly isComplete: boolean;
}

export interface GalaxyHostDocumentSource {
    snapshot(request: GalaxyHostDocumentSourceRequest): Promise<GalaxyHostDocumentSourceResult>;
}

/**
 * Builds the immutable, bounded document snapshot passed to MK3 language providers.
 *
 * The source depends only on document/index views. The current parser store is one possible
 * implementation; archive or host-owned indexes can replace it without changing LSP adapters.
 */
export class GalaxyWorkspaceDocumentSource {
    private readonly maximumDocuments: number;

    constructor(
        private readonly index: GalaxyDocumentIndex,
        private readonly openDocuments: GalaxyOpenDocuments,
        private readonly options: GalaxyWorkspaceDocumentSourceOptions = {},
    ) {
        this.maximumDocuments = Math.max(1, options.maximumDocuments ?? 64);
    }

    async snapshot(
        primaryUri: string,
        workspaceLanguageIds: readonly string[],
        scope: GalaxyLspSnapshotScope = 'document',
        signal?: AbortSignal,
    ): Promise<GalaxyLspSnapshot | undefined> {
        signal?.throwIfAborted();
        if (primaryUri) await this.options.preparePrimary?.(primaryUri, signal);
        signal?.throwIfAborted();
        if (scope !== 'document') await this.options.prepareWorkspace?.(signal);
        signal?.throwIfAborted();
        if (primaryUri && !this.index.documents.has(primaryUri)) this.index.getDocument(primaryUri);

        const accepted = new Set(workspaceLanguageIds);
        const documents = new Map<string, LanguageDocument>();
        const editableDocumentUris = new Set<string>();
        for (const sourceFile of this.index.documents.values()) {
            signal?.throwIfAborted();
            const open = this.openDocuments.get(sourceFile.fileName);
            if (
                scope === 'current-workspace' &&
                open === undefined &&
                this.options.isCurrentWorkspaceDocument?.(sourceFile.fileName) !== true
            ) continue;
            documents.set(sourceFile.fileName, {
                uri: sourceFile.fileName,
                languageId: 'galaxy',
                version: open?.version ?? 0,
                text: open?.getText() ?? sourceFile.text,
            });
            if (open !== undefined || this.options.isEditableDocument?.(sourceFile.fileName) === true) {
                editableDocumentUris.add(sourceFile.fileName);
            }
        }
        for (const open of this.openDocuments.all()) {
            signal?.throwIfAborted();
            if (!accepted.has(open.languageId)) continue;
            documents.set(open.uri, {
                uri: open.uri,
                languageId: open.languageId,
                version: open.version,
                text: open.getText(),
            });
            editableDocumentUris.add(open.uri);
        }

        const primary = primaryUri
            ? documents.get(primaryUri)
            : [...documents.values()].find(document => document.languageId === 'galaxy');
        if (primary === undefined || primary.languageId !== 'galaxy') return undefined;

        const candidates = [...documents.values()]
            .filter(document => accepted.has(document.languageId) && document.uri !== primary.uri)
            .sort((left, right) => left.uri.localeCompare(right.uri));
        return {
            document: primary,
            workspaceDocuments: [primary, ...candidates.slice(0, this.maximumDocuments - 1)],
            workspaceIncomplete:
                this.index.lazyFileCount > 0 || candidates.length + 1 > this.maximumDocuments,
            editableDocumentUris: [...editableDocumentUris]
                .filter(uri => documents.has(uri))
                .sort((left, right) => left.localeCompare(right)),
        };
    }

    /** Adapt the archive-aware Galaxy index to the protocol-neutral MK3 host source contract. */
    async hostSnapshot(
        request: GalaxyHostDocumentSourceRequest,
    ): Promise<GalaxyHostDocumentSourceResult> {
        request.signal.throwIfAborted();
        if (!Number.isSafeInteger(request.maxDocuments) || request.maxDocuments < 0) {
            throw new RangeError('maxDocuments must be a non-negative safe integer');
        }
        const snapshot = await this.snapshot(
            request.document.uri,
            request.workspaceLanguageIds,
            'current-workspace',
            request.signal,
        );
        if (snapshot === undefined) return { documents: [], isComplete: true };
        const supplied = new Set(request.workspaceDocuments.map(document => document.uri));
        const candidates = snapshot.workspaceDocuments.filter(
            document => document.uri !== request.document.uri && !supplied.has(document.uri),
        );
        return {
            documents: candidates.slice(0, request.maxDocuments),
            isComplete:
                !snapshot.workspaceIncomplete && candidates.length <= request.maxDocuments,
        };
    }
}

/** Expose the existing Galaxy archive index as an MK3 host option without importing host code. */
export function createGalaxyHostDocumentSource(
    source: GalaxyWorkspaceDocumentSource,
): GalaxyHostDocumentSource {
    return Object.freeze({
        snapshot: (request: GalaxyHostDocumentSourceRequest) => source.hostSnapshot(request),
    });
}
