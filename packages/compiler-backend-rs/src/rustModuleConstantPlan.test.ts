import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import ts from 'typescript';

import { isBackendEmissionFailure } from '../../compiler-emission/src/index.js';
import { lowerTypeScriptSource, lowerTypeScriptSources } from '../../compiler-semantic/src/index.js';
import type {
  CompilerModuleFacadePlan,
  CompilerModuleIdentity,
  CompilerModuleResolutionPlan,
  CompilerRustModuleConstantModulePlan,
  IrModule,
} from '../../compiler-types/src/index.js';
import { createRustCompilerBackend, emitIrModuleRust } from './rustCompilerBackend.js';
import { createCompilerRustModuleConstantPlan } from './rustModuleConstantPlan.js';

describe('createCompilerRustModuleConstantPlan', () => {
  it('deeply freezes a deterministic primitive const plan without mutating inputs', () => {
    const module = lower(
      'exact.ts',
      `export const base: number = 1;
       export const total: number = (base + 2) * 3;
       export const enabled: boolean = true;
       export const selected: number = enabled ? total : 0;`,
    );
    const input = { modules: [module] } as const;
    const snapshot = structuredClone(input);

    const first = createCompilerRustModuleConstantPlan(input);
    const second = createCompilerRustModuleConstantPlan({ modules: [structuredClone(module)] });
    const modulePlan = getModulePlan(first.modules, module);

    expect(first.schema).toBe('flight-rust-module-constant-plan/1');
    expect(second).toEqual(first);
    expect(input).toEqual(snapshot);
    expect(isDeeplyFrozen(first, new WeakSet())).toBe(true);
    expect(modulePlan.refusals).toEqual([]);
    expect(modulePlan.bindings).toHaveLength(4);
    expect(modulePlan.bindings.map(({ scalar }) => scalar)).toEqual(['number', 'number', 'boolean', 'number']);
    expect(modulePlan.bindings[1]?.dependencies).toEqual([modulePlan.bindings[0]?.bindingId]);
  });

  it('refuses forward and unsupported local dependencies transitively', () => {
    const module = lower(
      'dependencies.ts',
      `export const forward: number = later + 1;
       export const later: number = 2;
       function seed(): number { return 3; }
       export const runtime: number = seed();
       export const dependent: number = runtime + 1;`,
    );

    const plan = getModulePlan(createCompilerRustModuleConstantPlan({ modules: [module] }).modules, module);

    expect(plan.bindings).toHaveLength(1);
    expect(plan.refusals.map(({ reason }) => reason)).toEqual([
      'dependency-not-earlier',
      'unsupported-expression',
      'dependency-refused',
    ]);
  });

  it('admits only exact primitive operator domains from the closed whitelist', () => {
    const module = lower(
      'operators.ts',
      `export const base: number = 8;
       export const negative: number = -base;
       export const remainder: number = base % 3;
       export const smaller: boolean = remainder < base;
       export const enabled: boolean = !false && smaller;
       export const same: boolean = base === 8;`,
    );
    const plan = getModulePlan(createCompilerRustModuleConstantPlan({ modules: [module] }).modules, module);

    expect(plan.refusals).toEqual([]);
    expect(plan.bindings.map(({ scalar }) => scalar)).toEqual([
      'number',
      'number',
      'number',
      'boolean',
      'boolean',
      'boolean',
    ]);
  });

  it('admits an exact acyclic named imported scalar and rejects the same edge inside a runtime cycle', () => {
    const providerSource = 'export const base: number = 2;';
    const consumerSource = "import { base } from './provider.js'; export const total: number = base + 1;";
    const preliminaryProvider = lower('provider.ts', providerSource);
    const preliminaryConsumer = lower('consumer.ts', consumerSource);
    const acyclicResolution: CompilerModuleResolutionPlan = {
      edges: [edge(preliminaryConsumer, './provider.js', preliminaryProvider, ['base'])],
      schema: 'flight-compiler-module-resolution/1',
    };
    const acyclicModules = lowerProject(
      [
        ['provider.ts', providerSource],
        ['consumer.ts', consumerSource],
      ],
      acyclicResolution,
    );
    const provider = acyclicModules[0]!;
    const consumer = acyclicModules[1]!;

    const forward = createCompilerRustModuleConstantPlan({
      moduleResolution: acyclicResolution,
      modules: [consumer, provider],
    });
    const reversed = createCompilerRustModuleConstantPlan({
      moduleResolution: structuredClone(acyclicResolution),
      modules: [provider, consumer],
    });

    expect(reversed).toEqual(forward);
    expect(getModulePlan(forward.modules, consumer).refusals).toEqual([]);
    expect(getModulePlan(forward.modules, consumer).bindings).toHaveLength(1);
    expect(
      getModulePlan(createCompilerRustModuleConstantPlan({ modules: [provider, consumer] }).modules, consumer).refusals,
    ).toEqual([expect.objectContaining({ reason: 'import-not-exact' })]);
    const emitted = createRustCompilerBackend().createEmissionSession!({
      moduleResolution: acyclicResolution,
      modules: [provider, consumer],
      options: {},
    }).emitModule(consumer)[0]!.contents;
    expect(emitted).toContain('pub const TOTAL: f64 = (base + 1.0);');

    const cyclicProviderSource =
      "import { total } from './consumer.js'; export const base: number = 2; export function observe(): number { return total; }";
    const preliminaryCyclicProvider = lower('provider.ts', cyclicProviderSource);
    const cyclicResolution: CompilerModuleResolutionPlan = {
      edges: [
        edge(preliminaryConsumer, './provider.js', preliminaryCyclicProvider, ['base']),
        edge(preliminaryCyclicProvider, './consumer.js', preliminaryConsumer, ['total']),
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const cyclicModules = lowerProject(
      [
        ['provider.ts', cyclicProviderSource],
        ['consumer.ts', consumerSource],
      ],
      cyclicResolution,
    );
    const cyclicProvider = cyclicModules[0]!;
    const cyclicConsumer = cyclicModules[1]!;
    const cyclicPlan = createCompilerRustModuleConstantPlan({
      moduleResolution: cyclicResolution,
      modules: [cyclicConsumer, cyclicProvider],
    });
    const reversedCyclicPlan = createCompilerRustModuleConstantPlan({
      moduleResolution: { ...cyclicResolution, edges: [...cyclicResolution.edges].reverse() },
      modules: [cyclicProvider, cyclicConsumer],
    });

    expect(reversedCyclicPlan).toEqual(cyclicPlan);
    expect(getModulePlan(cyclicPlan.modules, cyclicConsumer).refusals).toEqual([
      expect.objectContaining({ reason: 'dependency-cycle' }),
    ]);
  });

  it('refuses allocation, identity, calls, closures, and unapproved operators while preserving the array rule', () => {
    const cases = [
      ['string.ts', "export const value: string = 'hello';", 'rust-module-constant-initializer-unsupported'],
      ['template.ts', 'export const value: string = `hello`;', 'rust-module-constant-initializer-unsupported'],
      [
        'object.ts',
        'export const value: { count: number } = { count: 1 };',
        'rust-module-constant-initializer-unsupported',
      ],
      ['array.ts', 'export const value: number[] = [1, 2];', 'rust-module-array-value-unrepresented'],
      ['tuple.ts', 'export const value: [number, number] = [1, 2];', 'rust-module-array-value-unrepresented'],
      [
        'new.ts',
        'class Box { value: number = 1; } export const value: Box = new Box();',
        'rust-module-constant-initializer-unsupported',
      ],
      [
        'call.ts',
        'function seed(): number { return 1; } export const value: number = seed();',
        'rust-module-constant-initializer-unsupported',
      ],
      ['closure.ts', 'export const value: () => number = () => 1;', 'rust-module-constant-initializer-unsupported'],
      ['power.ts', 'export const value: number = 2 ** 3;', 'rust-module-constant-initializer-unsupported'],
      ['unary-plus.ts', 'export const value: number = +1;', 'rust-module-constant-initializer-unsupported'],
    ] as const;

    for (const [file, source, code] of cases) {
      const module = lower(file, source);
      expect(
        getModulePlan(createCompilerRustModuleConstantPlan({ modules: [module] }).modules, module).refusals,
      ).toEqual([expect.objectContaining({ code })]);
      expect(captureEmissionFailure(() => emitIrModuleRust(module)).rule).toBe(code);
    }
  });

  it('attributes refusal to the declaration and salvages independent declarations without dangling constants', () => {
    const source = `export const keep: number = 1;
function seed(): number { return 2; }
export const runtime: number = seed();
export const dependent: number = runtime + 1;
export function readKeep(): number { return keep; }
export function readRuntime(): number { return runtime; }`;
    const module = lower('salvage.ts', source);
    const failure = captureEmissionFailure(() => emitIrModuleRust(module));

    expect(failure.rule).toBe('rust-module-constant-initializer-unsupported');
    expect(failure.classification).toBe('compiler-restriction');
    expect(failure.line).toBe(3);

    const session = createRustCompilerBackend().createEmissionSession!({ modules: [module], options: {} });
    session.finalizePackageGraph!({
      facade: createFacade([module]),
      moduleFiles: [],
      placeholderModules: [module],
      refusals: [{ code: failure.rule!, message: failure.message, module: identity(module) }],
    });
    const emitPlaceholder = session.emitRefusalPlaceholder;
    if (!emitPlaceholder) throw new Error('expected the Rust session to expose a refusal placeholder emitter');
    const placeholder = emitPlaceholder(module, { message: failure.message, sourceText: source });
    if (!placeholder) throw new Error('expected a partial Rust source file');

    expect(placeholder.contents).toContain('pub const KEEP: f64 = 1.0;');
    expect(placeholder.contents).toContain('pub fn read_keep() -> f64');
    expect(placeholder.contents).toContain('// NOT GENERATED: variable (binding) -- source line 3');
    expect(placeholder.contents).toContain('// NOT GENERATED: variable (binding) -- source line 4');
    expect(placeholder.contents).toContain('// NOT GENERATED: function readRuntime -- source line 6');
    expect(placeholder.contents).not.toContain('pub const RUNTIME');
    expect(placeholder.contents).not.toContain('pub const DEPENDENT');
    expect(placeholder.contents).not.toContain('pub fn read_runtime()');
  });

  it('removes an import used only by a refused constant from salvaged Rust', () => {
    const source = `import { seed } from 'some-lib';
export const runtime: number = seed();
export function keep(): number { return 1; }`;
    const module = lower('salvage-import.ts', source);
    const session = createRustCompilerBackend().createEmissionSession!({ modules: [module], options: {} });
    session.finalizePackageGraph!({
      facade: createFacade([module]),
      moduleFiles: [],
      placeholderModules: [module],
      refusals: [
        { code: 'rust-external-import-unsupported', message: 'external import refused', module: identity(module) },
      ],
    });
    const emitPlaceholder = session.emitRefusalPlaceholder;
    if (!emitPlaceholder) throw new Error('expected the Rust session to expose a refusal placeholder emitter');
    const placeholder = emitPlaceholder(module, { message: 'external import refused', sourceText: source });
    if (!placeholder) throw new Error('expected a partial Rust source file');

    expect(placeholder.contents).toContain('// NOT GENERATED: variable (binding) -- source line 2');
    expect(placeholder.contents).toContain('pub fn keep() -> f64');
    expect(placeholder.contents).not.toContain('some-lib');
    expect(placeholder.contents).not.toContain('some_lib');
  });

  it('reuses the accepted constant plan during finalized source-tree emission', () => {
    const module = lower('reuse.ts', 'export const base = 2; export const total = base * 3;');
    const session = createRustCompilerBackend().createEmissionSession!({ modules: [module], options: {} });
    const initial = session.emitModule(module)[0]!;
    const finalized = session.finalizePackageGraph!({
      facade: createFacade([module]),
      moduleFiles: [{ file: initial, module: identity(module) }],
    });
    const replacement = finalized.moduleFileReplacements?.find(({ module: owner }) => owner.name === module.name)?.file;

    expect(replacement?.contents.trimEnd()).toBe(initial.contents.trimEnd());
    expect(replacement?.contents).toContain('pub const BASE: f64 = 2.0;');
    expect(replacement?.contents).toContain('pub const TOTAL: f64 = (BASE * 3.0);');
  });

  it('defensively refuses a module whose declaration no longer matches the session plan', () => {
    const original = lower('mismatch.ts', 'export function keep(): number { return 1; }');
    const changed = lower('mismatch.ts', 'export const added: number = 1;');
    const session = createRustCompilerBackend().createEmissionSession!({ modules: [original], options: {} });
    const failure = captureEmissionFailure(() => session.emitModule(changed));

    expect(failure.rule).toBe('rust-module-constant-initializer-unsupported');
    expect(failure.message).toContain('has no matching primitive Rust const-expression proof');
  });

  it.skipIf(process.env.FLIGHT_RUN_RUST_MODULE_CONSTANT_CHECKPOINT !== '1')(
    'passes the explicit Rust compile checkpoint for accepted primitive const expressions',
    () => {
      const module = lower(
        'checkpoint.ts',
        'export const base = 2; export const enabled = true; export const total = enabled ? base * 3 : 0;',
      );
      runRustCheckpoint(emitIrModuleRust(module).contents);
    },
  );
});

function captureEmissionFailure(run: () => unknown) {
  try {
    run();
  } catch (error) {
    if (isBackendEmissionFailure(error)) return error;
    throw error;
  }
  throw new Error('expected Rust emission to refuse and it did not');
}

function createFacade(modules: readonly Readonly<IrModule>[]): CompilerModuleFacadePlan {
  return {
    modules: modules.map((module) => ({ module: identity(module), slots: [] })),
    schema: 'flight-compiler-module-facade/1',
    semantics: {
      bindingAccess: 'live',
      explicitPrecedence: 'named-over-star',
      starAmbiguity: 'refuse-distinct-resolutions',
      starDefault: 'excluded',
      typeValueLanes: 'independent',
    },
  };
}

function edge(
  importer: Readonly<IrModule>,
  specifier: string,
  target: Readonly<IrModule>,
  importedNames: readonly string[],
): CompilerModuleResolutionPlan['edges'][number] {
  return { importedNames, importer: identity(importer), specifier, target: identity(target) };
}

function getModulePlan(
  plans: readonly Readonly<CompilerRustModuleConstantModulePlan>[],
  module: Readonly<IrModule>,
): Readonly<CompilerRustModuleConstantModulePlan> {
  const plan = plans.find(({ module: candidate }) => candidate.name === module.name);
  if (!plan) throw new Error(`missing module-constant plan for ${module.name}`);
  return plan;
}

function identity(module: Readonly<IrModule>): CompilerModuleIdentity {
  return { name: module.name, packageName: module.packageName, source: module.source };
}

function isDeeplyFrozen(value: unknown, seen: WeakSet<object>): boolean {
  if (!value || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((child) => isDeeplyFrozen(child, seen));
}

function lower(file: string, source: string): IrModule {
  const sourceFile = createSourceFile(file, source);
  const result = lowerTypeScriptSource(sourceFile, {
    packageName: '@fixture/module-constant',
    upstreamDirectory: '/flight',
  });
  expect(result.diagnostics).toEqual([]);
  return result.module;
}

function lowerProject(
  sources: readonly (readonly [file: string, source: string])[],
  moduleResolution: Readonly<CompilerModuleResolutionPlan>,
): readonly IrModule[] {
  const results = lowerTypeScriptSources(
    sources.map(([file, source]) => ({
      packageName: '@fixture/module-constant',
      sourceFile: createSourceFile(file, source),
      upstreamDirectory: '/flight',
    })),
    moduleResolution,
  );
  for (const result of results) expect(result.diagnostics).toEqual([]);
  return results.map((result) => result.module);
}

function createSourceFile(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(`/flight/packages/module-constant/src/${file}`, source, ts.ScriptTarget.Latest, true);
}

function runRustCheckpoint(contents: string): void {
  const directory = mkdtempSync(path.join(tmpdir(), 'flight-rust-module-constant-'));
  try {
    const source = path.join(directory, 'subject.rs');
    writeFileSync(source, contents);
    const build = spawnSync('rustc', ['--crate-type', 'lib', '--edition', '2021', source], {
      cwd: directory,
      encoding: 'utf8',
    });
    if (build.status !== 0) throw new Error(`${build.stdout ?? ''}${build.stderr ?? ''}`.trim());
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}
