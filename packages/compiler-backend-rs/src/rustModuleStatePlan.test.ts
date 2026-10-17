import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import ts from 'typescript';

import { isBackendEmissionFailure } from '../../compiler-emission/src/index.js';
import {
  createCompilerModuleEvaluationPlan,
  filterCompilerModuleEvaluationPlan,
} from '../../compiler-module/src/index.js';
import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type {
  CompilerModuleFacadePlan,
  CompilerModuleIdentity,
  CompilerModuleResolutionPlan,
  CompilerRustModuleStateModulePlan,
  IrModule,
} from '../../compiler-types/src/index.js';
import { createRustCompilerBackend, emitIrModuleRust } from './rustCompilerBackend.js';
import { createCompilerRustModuleStatePlan } from './rustModuleStatePlan.js';

describe('createCompilerRustModuleStatePlan', () => {
  it('plans one private literal Copy scalar deterministically without mutating its inputs', () => {
    const module = lower(
      'counter.ts',
      `let counter: number = 1;
       const step: number = 2;
       export function read(): number { return counter; }
       export function advance(): number { counter = counter + step; return counter; }`,
    );
    const input = { modules: [module] } as const;
    const snapshot = structuredClone(input);

    const first = createCompilerRustModuleStatePlan(input);
    const second = createCompilerRustModuleStatePlan({ modules: [structuredClone(module)] });

    expect(first.schema).toBe('flight-rust-module-state-plan/1');
    expect(second).toEqual(first);
    expect(input).toEqual(snapshot);
    expect(isDeeplyFrozen(first, new WeakSet())).toBe(true);
    expect(getModulePlan(first.modules, module).bindings).toEqual([
      expect.objectContaining({ initializer: 1, scalar: 'number', update: 'none' }),
    ]);
  });

  it('plans direct numeric prefix and postfix increments and decrements as an explicit capability', () => {
    const module = lower(
      'updates.ts',
      `let counter = 1;
       export function postfixIncrement(): number { return counter++; }
       export function prefixIncrement(): number { return ++counter; }
       export function postfixDecrement(): number { return counter--; }
       export function prefixDecrement(): number { return --counter; }`,
    );

    expect(getModulePlan(createCompilerRustModuleStatePlan({ modules: [module] }).modules, module).bindings).toEqual([
      expect.objectContaining({ initializer: 1, scalar: 'number', update: 'number-increment-decrement' }),
    ]);
  });

  it('keeps exports, wider state, effects, captures, async access, and unsupported operators out of the plan', () => {
    const sources = [
      'export let state = 0; export function read(): number { return state; }',
      'let first = 0; let second = false; export function read(): number { return first; }',
      'let state: number[] = [0]; export function read(): number { return state[0]!; }',
      'function seed(): number { return 0; } let state = seed(); export function read(): number { return state; }',
      'const seed = 0; let state = seed; export function read(): number { return state; }',
      'let state = 0; state = 1; export function read(): number { return state; }',
      'let state = 0; export function add(value: number): number { state += value; return state; }',
      'let state = 0; export function indirect(): number { return (state as number)++; }',
      'let state = false; export function invalid(): number { return state++; }',
      'let state = 0; export async function read(): Promise<number> { return state; }',
      'let state = 0; export function capture(): () => number { return () => state; }',
      "export { helper } from './helper.js'; let state = 0; export function read(): number { return state; }",
    ];

    for (const [index, source] of sources.entries()) {
      const module = lower(`refused-${String(index)}.ts`, source);
      expect(getModulePlan(createCompilerRustModuleStatePlan({ modules: [module] }).modules, module).bindings).toEqual(
        [],
      );
    }
  });

  it('plans the same exact private slice for a boolean literal', () => {
    const module = lower(
      'flag.ts',
      'let enabled: boolean = false; export function toggle(): boolean { enabled = true; return enabled; }',
    );

    expect(getModulePlan(createCompilerRustModuleStatePlan({ modules: [module] }).modules, module).bindings).toEqual([
      expect.objectContaining({ initializer: false, scalar: 'boolean', update: 'none' }),
    ]);
    expect(emitIrModuleRust(module).contents).toContain(
      'static MODULE_STATE_ENABLED: std::sync::Mutex<bool> = std::sync::Mutex::new(false);',
    );
  });

  it('rejects runtime dependency edges while permitting an unrelated type-only module', () => {
    const provider = lower('provider.ts', 'let state = 0; export function read(): number { return state; }');
    const consumer = lower(
      'consumer.ts',
      "import { read } from './provider.js'; export function use(): number { return read(); }",
    );
    const types = lower('types.ts', 'export interface Shape { value: number }');
    const resolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          importer: identity(consumer),
          specifier: './provider.js',
          target: identity(provider),
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };

    const plan = createCompilerRustModuleStatePlan({
      moduleResolution: resolution,
      modules: [types, consumer, provider],
    });

    expect(getModulePlan(plan.modules, provider).bindings).toEqual([]);
  });

  it('emits private Mutex helpers, copies reads, and stages an assignment call before locking', () => {
    const module = lower(
      'counter.ts',
      `let counter = 1;
       function next(): number { return counter + 1; }
       export function advance(): number { counter = next(); return counter; }
       export function current(): number { return counter; }`,
    );

    const output = emitIrModuleRust(module).contents;

    expect(output).toContain('static MODULE_STATE_COUNTER: std::sync::Mutex<f64> = std::sync::Mutex::new(1.0);');
    expect(output).toContain('fn read_module_state_counter() -> f64 {');
    expect(output).toContain('*MODULE_STATE_COUNTER.lock().unwrap_or_else(|poisoned| poisoned.into_inner())');
    expect(output).toContain('fn write_module_state_counter(value: f64) -> f64 {');
    expect(output).toContain('return read_module_state_counter();');
    expect(output).toContain('{ let module_state_value = next(); write_module_state_counter(module_state_value) }');
    expect(output).not.toContain('pub static MODULE_STATE_COUNTER');
    expect(output).not.toContain('pub fn read_module_state_counter');
    expect(output).not.toContain('update_module_state_counter');
    expect(output.indexOf('let module_state_value = next()')).toBeLessThan(
      output.indexOf('write_module_state_counter(module_state_value)'),
    );
  });

  it('emits one collision-safe locked update helper and projects source result ordering without rereading', () => {
    const module = lower(
      'update-counter.ts',
      `let counter = 1;
       function update_module_state_counter(value: number): number { return value; }
       export function postfixIncrement(): number { return counter++; }
       export function prefixIncrement(): number { return ++counter; }
       export function postfixDecrement(): number { return counter--; }
       export function prefixDecrement(): number { return --counter; }
       export function preserveCollision(): number { return update_module_state_counter(counter); }`,
    );

    const output = emitIrModuleRust(module).contents;
    const helper = output.match(/fn (update_module_state_counter(?:_\d+)?)\(increment: bool\) -> \(f64, f64\)/u)?.[1];

    expect(helper).toBeDefined();
    if (!helper) throw new Error('expected a module-state update helper');
    const helperBody = output.match(
      new RegExp(`fn ${helper}\\(increment: bool\\) -> \\(f64, f64\\) \\{([\\s\\S]*?)\\n\\}`, 'u'),
    )?.[1];
    expect(helperBody).toBeDefined();
    expect(helper).not.toBe('update_module_state_counter');
    expect(output.match(/fn update_module_state_counter(?:_\d+)?\(increment: bool\)/gu)).toHaveLength(1);
    expect(helperBody?.match(/\.lock\(\)/gu)).toHaveLength(1);
    expect(helperBody).not.toContain('read_module_state_counter');
    expect(output).toContain(
      'let mut guard = MODULE_STATE_COUNTER.lock().unwrap_or_else(|poisoned| poisoned.into_inner());',
    );
    expect(output).toContain('let previous = *guard;');
    expect(output).toContain('let updated = if increment { previous + 1.0 } else { previous - 1.0 };');
    expect(output).toContain('*guard = updated;');
    expect(output).toContain('(previous, updated)');
    expect(output).not.toContain(`pub fn ${helper}`);
    expect(output).toContain(`return ${helper}(true).0;`);
    expect(output).toContain(`return ${helper}(true).1;`);
    expect(output).toContain(`return ${helper}(false).0;`);
    expect(output).toContain(`return ${helper}(false).1;`);
    expect(output).not.toContain(`${helper}(true).0; read_module_state_counter()`);
    expect(output).not.toContain(`${helper}(true).1; read_module_state_counter()`);
  });

  it('keeps unsupported updates on the synchronization refusal and out of salvage', () => {
    const source = `let enabled = false;
export function invalid(): number { return enabled++; }
export function keep(value: number): number { return value + 1; }`;
    const module = lower('unsupported-update.ts', source);
    const failure = captureEmissionFailure(() => emitIrModuleRust(module));

    expect(failure.rule).toBe('rust-module-variable-synchronization-unsupported');
    expect(failure.line).toBe(1);
    const moduleEvaluation = createEvaluation([module]);
    const session = createRustCompilerBackend().createEmissionSession!({
      moduleEvaluation,
      modules: [module],
      options: {},
    });
    session.finalizePackageGraph!({
      facade: createFacade([module]),
      moduleEvaluation: filterCompilerModuleEvaluationPlan(moduleEvaluation, []),
      moduleFiles: [],
      placeholderModules: [module],
      refusals: [
        {
          code: 'rust-module-variable-synchronization-unsupported',
          message: 'unsupported update refused for the witness',
          module: identity(module),
        },
      ],
    });
    const emitPlaceholder = session.emitRefusalPlaceholder;
    if (!emitPlaceholder) throw new Error('expected the Rust session to expose a refusal placeholder emitter');
    const placeholder = emitPlaceholder(module, {
      message: 'unsupported update refused for the witness',
      sourceText: source,
    });
    if (!placeholder) throw new Error('expected a partial Rust source file');

    expect(placeholder.contents).toContain('// NOT GENERATED: variable (binding) -- source line 1');
    expect(placeholder.contents).toContain('pub fn keep(value: f64) -> f64');
    expect(placeholder.contents).not.toContain('MODULE_STATE_ENABLED');
    expect(placeholder.contents).not.toContain('update_module_state_enabled');
  });

  it('keeps near misses on the declaration-attributed synchronization refusal', () => {
    const module = lower(
      'exported-state.ts',
      'export let state = false; export function read(): boolean { return state; }',
    );
    const first = captureEmissionFailure(() => emitIrModuleRust(module));
    const second = captureEmissionFailure(() => emitIrModuleRust(structuredClone(module)));

    expect(first.rule).toBe('rust-module-variable-synchronization-unsupported');
    expect(first.classification).toBe('compiler-restriction');
    expect(first.line).toBe(1);
    expect(first.column).toBe(12);
    expect(second.line).toBe(first.line);
    expect(second.column).toBe(first.column);
    expect(second.message).toBe(first.message);
  });

  it('reuses the accepted plan during source-tree re-emission', () => {
    const module = lower('counter.ts', 'let counter = 0; export function increment(): number { return ++counter; }');
    const moduleEvaluation = createEvaluation([module]);
    const session = createRustCompilerBackend().createEmissionSession!({
      moduleEvaluation,
      modules: [module],
      options: {},
    });
    const initial = session.emitModule(module)[0]!;
    const finalized = session.finalizePackageGraph!({
      facade: createFacade([module]),
      moduleEvaluation,
      moduleFiles: [{ file: initial, module: identity(module) }],
    });
    const replacement = finalized.moduleFileReplacements?.find(({ module: owner }) => owner.name === module.name)?.file;

    expect(replacement?.contents.trimEnd()).toBe(initial.contents.trimEnd());
    expect(replacement?.contents).toContain('static MODULE_STATE_COUNTER: std::sync::Mutex<f64>');
    expect(replacement?.contents).toContain('fn update_module_state_counter(increment: bool) -> (f64, f64)');
    expect(replacement?.contents).toContain('return update_module_state_counter(true).1;');

    expect(() =>
      session.finalizePackageGraph!({
        facade: createFacade([module]),
        moduleEvaluation: { ...moduleEvaluation, entries: [] },
        moduleFiles: [{ file: initial, module: identity(module) }],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'rust-module-evaluation-finalization-mismatch',
        kind: 'compiler-backend-finalization',
      }),
    );
  });

  it('accepts one whole cyclic evaluation candidate during finalization', () => {
    const first = lower('first.ts', "import './second.js'; export function first(): number { return 1; }");
    const second = lower('second.ts', "import './first.js'; export function second(): number { return 2; }");
    const firstIdentity = identity(first);
    const secondIdentity = identity(second);
    const dependencies = [
      { importer: firstIdentity, specifier: './second.js', target: secondIdentity },
      { importer: secondIdentity, specifier: './first.js', target: firstIdentity },
    ];
    const moduleEvaluation = createCompilerModuleEvaluationPlan({
      dependencies,
      entries: [firstIdentity],
      modules: [first, second],
    });
    const session = createRustCompilerBackend().createEmissionSession!({
      moduleEvaluation,
      moduleResolution: { edges: dependencies, schema: 'flight-compiler-module-resolution/1' },
      modules: [first, second],
      options: {},
    });

    expect(moduleEvaluation.groups).toEqual([
      expect.objectContaining({ cyclic: true, modules: expect.arrayContaining([firstIdentity, secondIdentity]) }),
    ]);
    expect(
      session.finalizePackageGraph!({
        facade: createFacade([]),
        moduleEvaluation,
        moduleFiles: [],
      }),
    ).toEqual({ moduleFileReplacements: [], packageFiles: [] });
  });

  it('preserves declaration-local salvage attribution for an unsupported mutable binding', () => {
    const source = `export let counter = 0;
export function keep(value: number): number { return value + 1; }`;
    const module = lower('salvage.ts', source);
    const moduleEvaluation = createEvaluation([module]);
    const session = createRustCompilerBackend().createEmissionSession!({
      moduleEvaluation,
      modules: [module],
      options: {},
    });
    session.finalizePackageGraph!({
      facade: createFacade([module]),
      moduleEvaluation: filterCompilerModuleEvaluationPlan(moduleEvaluation, []),
      moduleFiles: [],
      placeholderModules: [module],
      refusals: [
        {
          code: 'rust-module-variable-synchronization-unsupported',
          message: 'mutable module state refused for the witness',
          module: identity(module),
        },
      ],
    });
    const emitPlaceholder = session.emitRefusalPlaceholder;
    if (!emitPlaceholder) throw new Error('expected the Rust session to expose a refusal placeholder emitter');
    const placeholder = emitPlaceholder(module, {
      message: 'mutable module state refused for the witness',
      sourceText: source,
    });
    if (!placeholder) throw new Error('expected a partial Rust source file');

    expect(placeholder.contents).toContain('// NOT GENERATED: variable (binding) -- source line 1');
    expect(placeholder.contents).toContain('// refusal: rust-module-variable-synchronization-unsupported');
    expect(placeholder.contents).toContain('pub fn keep(value: f64) -> f64');
    expect(placeholder.contents).not.toContain('MODULE_STATE_COUNTER');
  });

  it('retains accepted module state when a sibling declaration is salvaged', () => {
    const source = `let counter = 0;
export function broken(value: unknown): { value: number } { return value as { value: number }; }
export function keep(): number { return counter++; }`;
    const module = lower('state-salvage.ts', source);
    const moduleEvaluation = createEvaluation([module]);
    const session = createRustCompilerBackend().createEmissionSession!({
      moduleEvaluation,
      modules: [module],
      options: {},
    });
    session.finalizePackageGraph!({
      facade: createFacade([module]),
      moduleEvaluation: filterCompilerModuleEvaluationPlan(moduleEvaluation, []),
      moduleFiles: [],
      placeholderModules: [module],
      refusals: [
        { code: 'rust-cast-requires-type-directed-lowering', message: 'cast refused', module: identity(module) },
      ],
    });
    const emitPlaceholder = session.emitRefusalPlaceholder;
    if (!emitPlaceholder) throw new Error('expected the Rust session to expose a refusal placeholder emitter');
    const placeholder = emitPlaceholder(module, { message: 'cast refused', sourceText: source });
    if (!placeholder) throw new Error('expected a partial Rust source file');

    expect(placeholder.contents).toContain('static MODULE_STATE_COUNTER: std::sync::Mutex<f64>');
    expect(placeholder.contents).toContain('// NOT GENERATED: function broken -- source line 2');
    expect(placeholder.contents).toContain('pub fn keep() -> f64');
    expect(placeholder.contents).toContain('fn update_module_state_counter(increment: bool) -> (f64, f64)');
    expect(placeholder.contents).toContain('return update_module_state_counter(true).0;');
  });

  it.skipIf(process.env.FLIGHT_RUN_RUST_MODULE_STATE_CHECKPOINT !== '1')(
    'passes the explicit Rust runtime checkpoint for sequential update results and state',
    () => {
      const module = lower(
        'runtime-counter.ts',
        `let counter = 1;
         export function postfixIncrement(): number { return counter++; }
         export function prefixIncrement(): number { return ++counter; }
         export function postfixDecrement(): number { return counter--; }
         export function prefixDecrement(): number { return --counter; }
         export function current(): number { return counter; }`,
      );
      runRustCheckpoint(
        emitIrModuleRust(module).contents,
        `assert_eq!(current(), 1.0);
         assert_eq!(postfix_increment(), 1.0); assert_eq!(current(), 2.0);
         assert_eq!(prefix_increment(), 3.0); assert_eq!(current(), 3.0);
         assert_eq!(postfix_decrement(), 3.0); assert_eq!(current(), 2.0);
         assert_eq!(prefix_decrement(), 1.0); assert_eq!(current(), 1.0);`,
      );
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

function createEvaluation(modules: readonly Readonly<IrModule>[]) {
  return createCompilerModuleEvaluationPlan({ dependencies: [], entries: modules, modules });
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

function getModulePlan(
  plans: readonly Readonly<CompilerRustModuleStateModulePlan>[],
  module: Readonly<IrModule>,
): Readonly<CompilerRustModuleStateModulePlan> {
  const plan = plans.find(({ module: candidate }) => candidate.name === module.name);
  if (!plan) throw new Error(`missing module-state plan for ${module.name}`);
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
  const sourceFile = ts.createSourceFile(
    `/flight/packages/module-state/src/${file}`,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const result = lowerTypeScriptSource(sourceFile, {
    packageName: '@fixture/module-state',
    upstreamDirectory: '/flight',
  });
  expect(result.diagnostics).toEqual([]);
  return result.module;
}

function runRustCheckpoint(contents: string, assertions: string): void {
  const directory = mkdtempSync(path.join(tmpdir(), 'flight-rust-module-state-'));
  try {
    const source = path.join(directory, 'subject.rs');
    const executable = path.join(directory, 'subject');
    writeFileSync(source, `${contents}\nfn main() { ${assertions} }\n`);
    const build = spawnSync('rustc', ['--edition', '2021', '-o', executable, source], { encoding: 'utf8' });
    if (build.status !== 0) throw new Error(`${build.stdout ?? ''}${build.stderr ?? ''}`.trim());
    const run = spawnSync(executable, [], { encoding: 'utf8' });
    if (run.status !== 0) throw new Error(`${run.stdout ?? ''}${run.stderr ?? ''}`.trim());
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}
