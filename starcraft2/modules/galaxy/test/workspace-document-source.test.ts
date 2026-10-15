import { describe, expect, it, vi } from 'vitest';
import {
    createGalaxyHostDocumentSource,
    GalaxyWorkspaceDocumentSource,
    type GalaxyDocumentIndex,
    type GalaxyOpenDocument,
} from '../language/workspace/document-source.js';

function openDocument(
    uri: string,
    text: string,
    languageId = 'galaxy',
    version = 1,
): GalaxyOpenDocument {
    return { uri, languageId, version, getText: () => text };
}

function createIndex(
    entries: readonly [string, string][],
    lazyFileCount = 0,
): GalaxyDocumentIndex {
    const documents = new Map(entries.map(([fileName, text]) => [fileName, { fileName, text }]));
    return { documents, lazyFileCount, getDocument: uri => documents.get(uri) };
}

describe('GalaxyWorkspaceDocumentSource', () => {
    it('overlays open text and includes accepted cross-language documents', async () => {
        const index = createIndex([
            ['file:///main.galaxy', 'int old;'],
            ['file:///include.galaxy', 'int included;'],
        ]);
        const open = [
            openDocument('file:///main.galaxy', 'int current;', 'galaxy', 7),
            openDocument('file:///GameData.xml', '<CUnit id="Marine"/>', 'sc2-data'),
            openDocument('file:///ignored.txt', 'ignored', 'plaintext'),
        ];
        const source = new GalaxyWorkspaceDocumentSource(index, {
            get: uri => open.find(document => document.uri === uri),
            all: () => open,
        });

        const snapshot = await source.snapshot(
            'file:///main.galaxy', ['galaxy', 'sc2-data']);

        expect(snapshot?.document).toMatchObject({ text: 'int current;', version: 7 });
        expect(snapshot?.workspaceDocuments.map(document => document.uri)).toEqual([
            'file:///main.galaxy',
            'file:///GameData.xml',
            'file:///include.galaxy',
        ]);
        expect(snapshot?.workspaceIncomplete).toBe(false);
        expect(snapshot?.editableDocumentUris).toEqual([
            'file:///GameData.xml',
            'file:///main.galaxy',
        ]);
    });

    it('prepares and hydrates the primary document before reading the snapshot', async () => {
        const documents = new Map<string, { fileName: string; text: string }>();
        const order: string[] = [];
        const source = new GalaxyWorkspaceDocumentSource({
            documents,
            lazyFileCount: 0,
            getDocument(uri) {
                order.push('hydrate');
                const document = { fileName: uri, text: 'void main() {}' };
                documents.set(uri, document);
                return document;
            },
        }, {
            get: () => undefined,
            all: () => [],
        }, {
            preparePrimary: () => { order.push('prepare'); },
        });

        expect((await source.snapshot('file:///main.galaxy', ['galaxy']))?.document.text)
            .toBe('void main() {}');
        expect(order).toEqual(['prepare', 'hydrate']);
    });

    it('keeps the primary first, applies a deterministic bound and reports partial workspaces', async () => {
        const index = createIndex([
            ['file:///main.galaxy', 'main'],
            ['file:///z.galaxy', 'z'],
            ['file:///a.galaxy', 'a'],
        ], 1);
        const source = new GalaxyWorkspaceDocumentSource(index, {
            get: () => undefined,
            all: () => [],
        }, { maximumDocuments: 2 });

        const snapshot = await source.snapshot('file:///main.galaxy', ['galaxy']);

        expect(snapshot?.workspaceDocuments.map(document => document.uri)).toEqual([
            'file:///main.galaxy',
            'file:///a.galaxy',
        ]);
        expect(snapshot?.workspaceIncomplete).toBe(true);
    });

    it('prepares the complete index only for workspace-wide requests', async () => {
        const prepareWorkspace = vi.fn();
        const index = createIndex([['file:///main.galaxy', 'main']]);
        const source = new GalaxyWorkspaceDocumentSource(index, {
            get: () => undefined,
            all: () => [],
        }, { prepareWorkspace });

        await source.snapshot('file:///main.galaxy', ['galaxy'], 'document');
        expect(prepareWorkspace).not.toHaveBeenCalled();

        await source.snapshot('file:///main.galaxy', ['galaxy'], 'workspace');
        expect(prepareWorkspace).toHaveBeenCalledOnce();
    });

    it('can limit a workspace snapshot to current and open documents', async () => {
        const index = createIndex([
            ['file:///current.galaxy', 'int current;'],
            ['file:///dependency.galaxy', 'int dependency;'],
            ['file:///open-dependency.galaxy', 'int disk;'],
        ]);
        const open = [openDocument('file:///open-dependency.galaxy', 'int edited;')];
        const source = new GalaxyWorkspaceDocumentSource(index, {
            get: uri => open.find(document => document.uri === uri),
            all: () => open,
        }, {
            isCurrentWorkspaceDocument: uri => uri === 'file:///current.galaxy',
            isEditableDocument: uri => uri === 'file:///current.galaxy',
        });

        const snapshot = await source.snapshot(
            'file:///current.galaxy',
            ['galaxy'],
            'current-workspace',
        );

        expect(snapshot?.workspaceDocuments.map(document => document.uri)).toEqual([
            'file:///current.galaxy',
            'file:///open-dependency.galaxy',
        ]);
        expect(snapshot?.workspaceDocuments[1]?.text).toBe('int edited;');
        expect(snapshot?.editableDocumentUris).toEqual([
            'file:///current.galaxy',
            'file:///open-dependency.galaxy',
        ]);
    });

    it('adapts current archive documents to the bounded MK3 host source contract', async () => {
        const index = createIndex([
            ['file:///main.galaxy', 'void main() {}'],
            ['file:///dependency.galaxy', 'void dependency() {}'],
            ['file:///extra.galaxy', 'void extra() {}'],
        ]);
        const source = new GalaxyWorkspaceDocumentSource(index, {
            get: () => undefined,
            all: () => [],
        }, {
            isCurrentWorkspaceDocument: () => true,
        });
        const controller = new AbortController();

        const snapshot = await createGalaxyHostDocumentSource(source).snapshot({
            document: {
                uri: 'file:///main.galaxy',
                languageId: 'galaxy',
                version: 1,
                text: 'void main() {}',
            },
            workspaceDocuments: [{
                uri: 'file:///main.galaxy',
                languageId: 'galaxy',
                version: 1,
                text: 'void main() {}',
            }],
            workspaceLanguageIds: ['galaxy'],
            maxDocuments: 1,
            signal: controller.signal,
        });

        expect(snapshot.documents.map(document => document.uri)).toEqual([
            'file:///dependency.galaxy',
        ]);
        expect(snapshot.isComplete).toBe(false);
    });

    it('honours cancellation before reading the index', async () => {
        const getDocument = vi.fn();
        const controller = new AbortController();
        controller.abort();
        const source = new GalaxyWorkspaceDocumentSource({
            documents: new Map(),
            lazyFileCount: 0,
            getDocument,
        }, {
            get: () => undefined,
            all: () => [],
        });

        await expect(source.snapshot('file:///main.galaxy', ['galaxy'], 'document', controller.signal))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(getDocument).not.toHaveBeenCalled();
    });
});
