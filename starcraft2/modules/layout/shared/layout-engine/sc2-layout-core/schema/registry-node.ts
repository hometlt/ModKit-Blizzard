/*
 * The schema registry's filesystem half, split out of `registry.ts` (MK3 port note).
 *
 * Reading a schema directory needs `path` and `node:fs/promises`; a browser worker cannot load
 * either, and before this split their presence at the top of `registry.ts` took the pure registry
 * down with them. Node callers import this module and get both halves.
 */
import * as path from 'path';
import * as fsp from 'node:fs/promises';
import * as sch from './base.js';
import { readSchemaModel } from './reader.js';
import { readMdStorage } from './localization.js';
import { globify } from '../common.js';
import { createRegistry } from './registry.js';
import type { SchemaData, SchemaDirReadOptions } from './registry.js';

export * from './registry.js';

export async function readSchemaDataDir(src: string, opts: SchemaDirReadOptions = {}): Promise<SchemaData> {
    opts = Object.assign({
        includeLocalization: true,
    }, opts);

    const sfProvider = createDefaultSchemaFileProvider(src);
    const sdata: SchemaData = {
        dEntries: await readSchemaModel(sfProvider),
    };

    if (opts.includeLocalization) {
        sdata.mdStorage = await readMdStorage(sfProvider);
    }

    return sdata;
}

export async function createRegistryFromDir(src: string, opts: SchemaDirReadOptions = {}) {
    return createRegistry(await readSchemaDataDir(src, opts));
}

export function createDefaultSchemaFileProvider(schDir: string): sch.SchemaFileProvider {
    function readFile(filename: string) {
        schDir = path.resolve(schDir);
        if (!path.join(schDir, filename).startsWith(schDir)) {
            throw new Error(`Attempting to read file "${filename}" outside designated directory ${schDir}`);
        }
        return fsp.readFile(path.join(schDir, filename), 'utf8');
    }

    function listDir(pattern: string) {
        return globify(pattern, {
            cwd: schDir,
        });
    }

    return {
        readFile,
        listDir,
    };
}
