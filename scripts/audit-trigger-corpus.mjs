// Read-only, opt-in corpus audit. Input paths come from a local manifest, never from converter rules.
// Usage: node scripts/audit-trigger-corpus.mjs <manifest.json> <output-directory>
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { resolve, relative, dirname, basename, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { convertTriggersToGalaxy, convertGalaxyToTriggers } from '../starcraft2/dist/modules/triggers/services/galaxy-conversion/index.js';
import { parseGalaxySource } from '../starcraft2/dist/modules/triggers/services/galaxy-conversion/internal/galaxy-to-trigger.js';
import { compareGalaxyPrograms } from '../starcraft2/dist/modules/triggers/services/galaxy-conversion/internal/galaxy-comparison.js';

const [manifestPath, outputPath] = process.argv.slice(2);
if (!manifestPath || !outputPath) throw new Error('Expected manifest path and output directory');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) throw new Error('Audit requires at least one case');
const output = resolve(outputPath);
const within = (root, child) => { const part = relative(root, child); return !isAbsolute(part) && part !== '..' && !part.startsWith('..\\') && !part.startsWith('../'); };
for (const root of manifest.readOnlyRoots ?? []) {
  if (within(await realpath(root), output)) throw new Error('Audit output must be outside every read-only source root');
}
await mkdir(output, { recursive: true });
const actualOutput = await realpath(output);
for (const root of manifest.readOnlyRoots ?? []) {
  if (within(await realpath(root), actualOutput)) throw new Error('Audit output resolves inside a read-only source root');
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const reads = new Map();
const read = async path => {
  const absolute = await realpath(resolve(dirname(manifestPath), path));
  if (within(actualOutput, absolute)) throw new Error('Input cannot be an earlier audit output');
  const bytes = await readFile(absolute);
  reads.set(absolute, { sha256: digest(bytes), bytes: bytes.length });
  return bytes.toString('utf8');
};
const readStringLayers = async value => value === undefined ? undefined
  // The first localization is the selected locale; later entries only fill
  // missing keys. parseTriggerStrings uses last-write-wins, so concatenate the
  // fallback layers first and the selected locale last.
  : (await Promise.all((Array.isArray(value) ? value : [value]).map(read))).reverse().join('\n');
const save = async (name, content) => {
  const path = resolve(actualOutput, name);
  if (!within(actualOutput, path)) throw new Error('Invalid output filename');
  await writeFile(path, content);
};
const summary = result => ({ fidelity: result.fidelity, digest: result.digest, output: {
  libraryId: result.output.libraryId, elements: result.output.elements, typeCounts: result.output.typeCounts,
  generationOptions: result.output.generationOptions, initialization: result.output.initialization,
}, ...(result.output.script === undefined ? {} : { generatedParseErrors: [result.output.script, result.output.header ?? ''].flatMap(text => parseGalaxySource(text).parseDiagnostics.map(({ file, ...diagnostic }) => diagnostic)) }) });
function compare(reference, emitted, options = {}) {
  const expected = parseGalaxySource(reference), actual = parseGalaxySource(emitted);
  const semantic = compareGalaxyPrograms(expected, actual, options);
  const diagnostics = source => source.parseDiagnostics.map(({ file, ...diagnostic }) => diagnostic);
  return { referenceParseErrors: diagnostics(expected), emittedParseErrors: diagnostics(actual),
    referenceFunctions: semantic.functions.expected, emittedFunctions: semantic.functions.actual,
    exactFunctions: semantic.functions.exact.length, missingFunctions: semantic.functions.missing,
    addedFunctions: semantic.functions.added, differingFunctions: semantic.functions.differing,
    semantic };
}
const report = { started: new Date().toISOString(), manifest: resolve(manifestPath), cases: [], inputs: [], unchanged: null };
const checkpoint = () => save('report.json', JSON.stringify(report, null, 2));
const dependencies = await Promise.all((manifest.dependencies ?? []).map(async source => ({
  triggerData: await read(source.triggers), ...(source.strings ? { triggerStrings: await readStringLayers(source.strings) } : {}),
  ...(source.gameStrings ? { gameStrings: await read(source.gameStrings) } : {}),
})));
const declarations = await Promise.all((manifest.galaxyDeclarations ?? []).map(async path => ({ fileName: basename(path), text: await read(path) })));
for (const [index, source] of manifest.cases.entries()) {
  const caseDependencies = [...dependencies, ...await Promise.all((source.dependencies ?? []).map(async dependency => ({ triggerData: await read(dependency.triggers), ...(dependency.strings ? { triggerStrings: await readStringLayers(dependency.strings) } : {}), ...(dependency.gameStrings ? { gameStrings: await read(dependency.gameStrings) } : {}) })))];
  const caseDeclarations = [...declarations, ...await Promise.all((source.galaxyDeclarations ?? []).map(async path => ({ fileName: basename(path), text: await read(path) })))];
  const options = {
    libraryId: source.libraryId,
    dependencyLibraries: caseDependencies,
    galaxyDeclarations: caseDeclarations,
    limits: source.limits ?? manifest.limits,
    ...(source.verification ?? manifest.verification ? { verification: source.verification ?? manifest.verification } : {}),
    ...source.generationOptions,
  };
  const result = { name: source.name, source, phases: {} };
  report.cases.push(result);
  const prefix = `${index + 1}`;
  const script = source.script ? await read(source.script) : '';
  const header = source.header ? await read(source.header) : '';
  const triggers = source.triggers ? await read(source.triggers) : undefined;
  const strings = source.strings ? await readStringLayers(source.strings) : undefined;
  const gameStrings = source.gameStrings ? await read(source.gameStrings) : undefined;
  const run = async (name, action) => {
    console.log(`${source.name}: ${name}`);
    const start = performance.now();
    try {
      const value = await action();
      const parseFailure = value.generatedParseErrors?.length || value.comparison?.emittedParseErrors?.length;
      const semanticFailure = value.fidelity?.verification?.galaxyValidation?.status === 'failed';
      // A function present in the reference and absent from the output is lost work,
      // so it fails the case even when the emitted text parses and validates.
      const missingFailure = value.comparison?.missingFunctions?.length ?? 0;
      const comparisonPolicy = source.comparisonPolicy ?? manifest.comparisonPolicy ?? 'strict';
      const comparisonFailure = value.comparison && comparisonPolicy === 'strict' && !value.comparison.semantic?.exact;
      const valid = !parseFailure && !semanticFailure && !missingFailure && !comparisonFailure;
      const reason = parseFailure ? 'Generated Galaxy has parser errors'
        : semanticFailure ? 'Generated Galaxy has declaration validation errors'
        : missingFailure ? `Generated Galaxy omits ${missingFailure} reference function(s)`
        : 'Generated Galaxy differs from the reference program after semantic AST normalization';
      result.phases[name] = { completed: true, ok: valid, ...value, ...(!valid ? { error: reason } : {}) };
    }
    catch (error) {
      result.phases[name] = {
        ok: false,
        error: String(error),
        context: error.context,
        details: error.details,
        stack: error.stack,
      };
    }
    result.phases[name].milliseconds = Math.round(performance.now() - start);
    console.log(`${source.name}: ${name}: ${result.phases[name].ok ? 'completed' : result.phases[name].error}`);
    await checkpoint();
  };
  let forward;
  if (triggers && source.forward !== false) await run('trigger-to-galaxy', async () => {
    forward = await convertTriggersToGalaxy(triggers, { ...options, triggerStrings: strings, gameStrings });
    await save(`${prefix}-forward.galaxy`, forward.output.script);
    await save(`${prefix}-forward_h.galaxy`, forward.output.header);
    return { ...summary(forward), ...(script ? { comparison: compare(`${header}\n${script}`, `${forward.output.header ?? ''}\n${forward.output.script}`, options) } : {}) };
  });
  if (source.script && source.reverse !== false) await run('galaxy-to-trigger', async () => {
    const reversed = await convertGalaxyToTriggers({ ...options, script, header });
    await save(`${prefix}-reverse.Triggers`, reversed.output.triggerData);
    if (reversed.output.generationOptions) await save(`${prefix}-reverse.generation.json`, JSON.stringify(reversed.output.generationOptions, null, 2));
    const emitted = await convertTriggersToGalaxy(reversed.output.triggerData, { ...options, ...reversed.output.generationOptions });
    await save(`${prefix}-reverse.galaxy`, emitted.output.script);
    await save(`${prefix}-reverse_h.galaxy`, emitted.output.header);
    return { ...summary(reversed), generatedParseErrors: summary(emitted).generatedParseErrors,
      comparison: compare(`${header}\n${script}`, `${emitted.output.header ?? ''}\n${emitted.output.script}`, options) };
  });
  if (forward && source.roundTrip !== false) await run('trigger-roundtrip', async () => {
    const reversed = await convertGalaxyToTriggers({ ...options, script: forward.output.script, header: forward.output.header });
    await save(`${prefix}-roundtrip.Triggers`, reversed.output.triggerData);
    return summary(reversed);
  });
}
for (const [path, before] of reads) {
  const after = digest(await readFile(path));
  report.inputs.push({ path, ...before, sha256After: after, unchanged: before.sha256 === after });
}
report.unchanged = report.inputs.every(input => input.unchanged);
report.finished = new Date().toISOString();
await checkpoint();
console.log(JSON.stringify({ cases: report.cases.length, filesRead: reads.size, unchanged: report.unchanged, report: resolve(actualOutput, 'report.json') }));
if (!report.unchanged || report.cases.some(item => Object.values(item.phases).some(phase => !phase.ok))) process.exitCode = 1;
