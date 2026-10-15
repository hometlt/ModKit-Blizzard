import * as path from 'path';
import { Emitter, type Event } from '@modkit/codec-kit/legacy/sc2-support';
import { BasicLayoutWorkspace, type LayoutArchive, type LayoutWorkspace } from './workspace.js';
import { URI } from 'vscode-uri';
import * as sch from '../schema/base.js';
import { XMLDocument, TextDocument, type SC2Layout } from '../types.js';
import { parseDocument } from '../parser/parser.js';
import { DescIndex, DescNamespace } from './desc.js';
import { readFileAsync } from '../common.js';

export async function createTextDocumentFromFs(filepath: string): Promise<TextDocument> {
    return new TextDocument(URI.file(path.resolve(filepath)).toString(), await readFileAsync(filepath, 'utf8'));
}

/** Build a TextDocument from already-in-hand text (e.g. the persistent layout content cache). */
export function createTextDocumentFromText(filepath: string, text: string): TextDocument {
    return new TextDocument(URI.file(path.resolve(filepath)).toString(), text);
}

export type LayoutDocument = XMLDocument;

export interface FileDescEventData {
    archive: LayoutArchive;
    xDoc: XMLDocument;
    fDesc: DescNamespace;
}

export interface IStoreEvents {
    readonly onDidFileDescCreate: Event<FileDescEventData>;
    readonly onDidFileDescChange: Event<FileDescEventData>;
    readonly onDidFileDescDelete: Event<FileDescEventData>;

    readonly onDidArchiveAdd: Event<LayoutArchive>;
    readonly onDidArchiveDelete: Event<LayoutArchive>;
}

/**
 * The layout index over a workspace's `.SC2Layout` documents.
 *
 * `TWs` is the archive/workspace substrate — see `./workspace.js`. It is a type parameter rather
 * than a concrete class because the StarCraft II implementation moved into
 * `extensions/blizzard/starcraft-2` in L4c, and a package may not depend on an extension. A
 * caller that names the richer workspace keeps its extra surface (string tables, font styles)
 * fully typed; a caller that names nothing gets archive tracking and no more.
 */
export class Store<TWs extends LayoutWorkspace = LayoutWorkspace> implements IStoreEvents {
    protected _onDidFileDescCreate = new Emitter<FileDescEventData>();
    protected _onDidFileDescChange = new Emitter<FileDescEventData>();
    protected _onDidFileDescDelete = new Emitter<FileDescEventData>();
    readonly onDidFileDescCreate = this._onDidFileDescCreate.event;
    readonly onDidFileDescChange = this._onDidFileDescChange.event;
    readonly onDidFileDescDelete = this._onDidFileDescDelete.event;

    protected _onDidArchiveAdd = new Emitter<LayoutArchive>();
    protected _onDidArchiveDelete = new Emitter<LayoutArchive>();
    readonly onDidArchiveAdd = this._onDidArchiveAdd.event;
    readonly onDidArchiveDelete = this._onDidArchiveDelete.event;

    readonly s2ws: TWs;
    readonly documents = new Map<string, XMLDocument>();
    readonly index: DescIndex;
    /** Phase-4 instrumentation: cumulative ms in XML parse vs desc bind across updates. */
    parseMs = 0;
    bindMs = 0;

    constructor(
        public readonly schema: sch.SchemaRegistry,
        /**
         * The archive/workspace substrate. Before L4c this parameter was the shared strings
         * instance from a WorkspaceHost (Plan 4e-E E4) and the Store built an SC2 workspace
         * around it; now the caller builds the workspace it wants and hands it over, so the
         * `s2ws.strings === host.strings` identity is arranged by the host rather than here.
         * Omitted ⇒ {@link BasicLayoutWorkspace}: archive tracking, no strings, no font styles.
         */
        workspace?: TWs,
    ) {
        // The fallback satisfies the constraint and nothing beyond it, which is sound because
        // it is only reachable when the caller named no type argument — and then `TWs` IS
        // `LayoutWorkspace`. A caller that names a richer workspace must pass one.
        this.s2ws = workspace ?? (new BasicLayoutWorkspace() as unknown as TWs);
        this.index = new DescIndex(this.schema);
    }

    async clear() {
        for (const sa of this.s2ws.archives) {
            await this.deleteArchive(sa);
        }

        for (const docUri of this.documents.keys()) {
            this.removeDocument(docUri);
        }


        await this.s2ws.clear();
        this.index.clear();
        this.documents.clear();
    }

    async presetArchives(...archives: LayoutArchive[]) {
        this.s2ws.presetArchives(...archives);
        archives.forEach(sa => this._onDidArchiveAdd.fire(sa));
    }

    async addArchive(...archives: LayoutArchive[]) {
        for (const sa of archives) {
            await this.s2ws.addArchive(sa);
            this._onDidArchiveAdd.fire(sa);
        }
    }

    async deleteArchive(...archives: LayoutArchive[]) {
        for (const sa of archives) {
            await this.s2ws.deleteArchive(sa);
            this._onDidArchiveDelete.fire(sa);
        }
    }

    public updateDocument(documentUri: string, text: string, version: number | null = null, forceBind = false) {
        let xDoc = this.documents.get(documentUri);
        let tdoc: TextDocument;
        const alreadyExists = xDoc !== void 0;

        if (xDoc) {
            if (text.length === xDoc.text.length && text.valueOf() === xDoc.text.valueOf()) {
                if (forceBind) {
                    this.index.unbindDocument(xDoc);
                    this.index.bindDocument(xDoc);
                }
                xDoc.lang.tdoc!.version = version ?? 0;
                return xDoc;
            }

            this.index.unbindDocument(xDoc);

            tdoc = xDoc.lang.tdoc!;
            tdoc.updateContent(text, version);
        }
        else {
            tdoc = new TextDocument(documentUri, text);
        }

        let _t = Date.now();
        xDoc = parseDocument(tdoc, {schema: this.schema});
        this.parseMs += Date.now() - _t;
        this.documents.set(documentUri, xDoc);
        _t = Date.now();
        const fDesc = this.index.bindDocument(xDoc);
        this.bindMs += Date.now() - _t;
        const sa = this.s2ws.matchFileWorkspace(URI.parse(xDoc.lang.tdoc!.uri));

        if (sa) {
            if (alreadyExists) {
                this._onDidFileDescChange.fire({
                    archive: sa,
                    fDesc: fDesc,
                    xDoc: xDoc,
                });
            }
            else {
                this._onDidFileDescCreate.fire({
                    archive: sa,
                    fDesc: fDesc,
                    xDoc: xDoc,
                });
            }
        }

        return xDoc;
    }

    public removeDocument(documentUri: string) {
        const xDoc = this.documents.get(documentUri);
        if (!xDoc) return;

        const fDesc = this.index.resolveElementDesc(xDoc);
        if (fDesc) {
            const sa = this.s2ws.matchFileWorkspace(URI.parse(xDoc.lang.tdoc!.uri));
            if (sa) {
                this._onDidFileDescDelete.fire({
                    archive: sa,
                    fDesc: fDesc,
                    xDoc: xDoc,
                });
            }
        }

        this.index.unbindDocument(xDoc);
        this.documents.delete(documentUri);
    }

    public getDocumentsInArchive(sa: LayoutArchive) {
        const docList: XMLDocument[] = [];

        for (const xDoc of this.documents.values()) {
            if (!xDoc.lang.tdoc!.uri.startsWith(sa.uri.toString())) continue;
            docList.push(xDoc);
        }

        return docList;
    }
}
