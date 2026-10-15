// MK2 loaded `setup.ts` through mocha's --require; importing it here gives every consumer the
// cached schema registry without a runner-wide setup file.
import './setup.js';
import * as path from 'path';
import * as fs from 'fs';
import * as util from 'util';
import { Store } from '../../../../shared/layout-engine/sc2-layout-core/index/store.js';
import { SchemaRegistry } from '../../../../shared/layout-engine/sc2-layout-core/schema/base.js';
import { URI } from 'vscode-uri';
import { globify, readFileAsync } from '../../../../shared/layout-engine/sc2-layout-core/common.js';
import { languageExt } from '../../../../shared/layout-engine/sc2-layout-core/types.js';

export function getSchema(): SchemaRegistry {
    if (typeof (<any>global)._cachedSchemaGen === 'undefined') {
        throw new Error('_cachedSchemaGen missing')
    }
    return (<any>global)._cachedSchemaGen();
}

export function getFixturePath(...src: string[]) {
    return path.resolve(import.meta.dirname, 'fixtures', ...src);
}

export interface MockupStoreOptions {
    fprefix?: string;
}

export function buildStore(opts: MockupStoreOptions = {}, ...filenames: string[]) {
    const store = new Store(getSchema());
    opts.fprefix = opts.fprefix ? path.join(getFixturePath(), opts.fprefix) : getFixturePath();
    for (const tmp of filenames) {
        let uri: URI;
        if (path.isAbsolute(tmp)) {
            uri = URI.file(tmp);
        }
        else {
            uri = URI.file(path.join(opts.fprefix, `${tmp}.${languageExt}`));
        }
        store.updateDocument(uri.toString(), fs.readFileSync(uri.fsPath, 'utf8'));
    }
    return store;
}

export async function buildStoreFromDir(srcDir: string) {
    const store = new Store(getSchema());
    if (!path.isAbsolute(srcDir)) {
        srcDir = getFixturePath(srcDir);
    }
    for (const fname of await globify(`**/*.${languageExt}`, {cwd: srcDir, absolute: true})) {
        const uri = URI.file(fname);
        store.updateDocument(uri.toString(), await readFileAsync(fname, 'utf8'));
    }
    return store;
}

export function tlog(d: any, opts: util.InspectOptions | number = {}) {
    if (typeof opts === 'number') opts = {depth: opts};
    console.log(util.inspect(d,
        Object.assign(<util.InspectOptions>{
            colors: true,
            depth: 1,
        }, opts)
    ));
}




