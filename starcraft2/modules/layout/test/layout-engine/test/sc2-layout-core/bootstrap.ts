import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Ensure the compiled schema artifact exists before setup.ts imports it. Uses the
// same tsx compile script as the package build, so tests run after just `pnpm install`.
export const setup = async () => {
    // Run tsx's CLI module through the current node binary rather than spawning the bare
    // `tsx` name. On Windows the bin is `tsx.CMD`, which `spawnSync` cannot execute with
    // `shell: false` — that made the ROOT `pnpm test` die in this globalSetup before a
    // single test ran. Resolving `tsx/cli` keeps the spawn shell-free (no arg-quoting
    // hazard for checkout paths containing spaces) and behaves the same on every platform.
    const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
    const result = spawnSync(
        process.execPath,
        [tsxCli, path.join(pkgRoot, 'scripts/sc2-layout-core/compile-schema.ts'), '--skip-if-exists'],
        {
            cwd: pkgRoot,
            shell: false,
            encoding: 'utf8',
            stdio: 'inherit',
        },
    );
    if (result.status !== 0) {
        throw new Error(
            `[layout-lang bootstrap] compile-schema failed: ${result.error?.message ?? result.status}`,
        );
    }
};

export const teardown = async () => {};


