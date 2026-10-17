import ts from 'typescript';

import { createCompilerModuleEvaluationPlan, createCompilerModuleFacadePlan } from '../../compiler-module/src/index.js';
import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type {
  CompilerBackendPackageGraphFinalization,
  CompilerModuleIdentity,
  CompilerModuleLinkDependency,
  CompilerModuleResolutionPlan,
  CompilerRustModuleEvaluationRepresentationPlanInput,
  CompilerRustModuleEvaluationRepresentationPlanningFailure,
  CompilerRustSourceTreePlan,
  IrModule,
} from '../../compiler-types/src/index.js';
import { createCompilerRustModuleConstantPlan } from './rustModuleConstantPlan.js';
import { createCompilerRustModuleEvaluationRepresentationFinalizationState } from './rustModuleEvaluationRepresentationFinalization.js';
import {
  createCompilerRustModuleEvaluationRepresentationPlan,
  isCompilerRustModuleEvaluationRepresentationPlanningFailure,
} from './rustModuleEvaluationRepresentationPlan.js';
import { createCompilerRustModuleStatePlan } from './rustModuleStatePlan.js';
import { createCompilerRustReferenceRepresentationPlan } from './rustReferenceRepresentationPlan.js';
import { createCompilerRustSourceTreePlan } from './rustSourceTreePlan.js';

describe('createCompilerRustModuleEvaluationRepresentationPlan', () => {
  it('preserves authoritative order and evidence while remaining deterministic, immutable, and deeply frozen', () => {
    const provider = lower('@scope/math', 'provider.ts', 'export const first = 1; export const second = 2;');
    const consumer = lower(
      '@scope/math',
      'consumer.ts',
      `import { second } from './provider.js';
       import { first } from './provider.js';
       export const result = first + second;`,
    );
    const dependencies: readonly CompilerModuleLinkDependency[] = [
      {
        importedNames: ['second'],
        importer: identity(consumer),
        specifier: './provider.js',
        target: identity(provider),
      },
      {
        importedNames: ['first'],
        importer: identity(consumer),
        specifier: './provider.js',
        target: identity(provider),
      },
    ];
    const input = createInput([consumer, provider], [consumer], dependencies);
    const snapshot = structuredClone(input);

    const first = createCompilerRustModuleEvaluationRepresentationPlan(input);
    const permuted = structuredClone(input) as Mutable<CompilerRustModuleEvaluationRepresentationPlanInput>;
    permuted.modules.reverse();
    permuted.finalization.moduleFiles.reverse();
    permuted.finalization.facade.modules.reverse();
    permuted.sourceTree.modules.reverse();
    permuted.sourceTree.files.reverse();
    permuted.constantPlan.modules.reverse();
    permuted.statePlan.modules.reverse();
    permuted.referencePlan.modules.reverse();
    const second = createCompilerRustModuleEvaluationRepresentationPlan(permuted);
    const consumerPlan = getModulePlan(first, consumer);

    expect(first.schema).toBe('flight-rust-module-evaluation-representation-plan/1');
    expect(second).toEqual(first);
    expect(input).toEqual(snapshot);
    expect(isDeeplyFrozen(first, new WeakSet())).toBe(true);
    expect(first.entries.map(({ module }) => module.name)).toEqual(['Consumer']);
    expect(consumerPlan.dependencies.map(({ importedNames }) => importedNames)).toEqual([['second'], ['first']]);
    expect(consumerPlan.bindings.map(({ binding }) => binding.name)).toEqual(['second', 'first', 'result']);
    expect(consumerPlan.bindings.slice(0, 2)).toEqual([
      expect.objectContaining({ decision: { outcome: 'erased', reason: 'immutable-primitive-constant' } }),
      expect.objectContaining({ decision: { outcome: 'erased', reason: 'immutable-primitive-constant' } }),
    ]);
    expect(consumerPlan.steps[0]?.provenance).toEqual(
      input.finalization.moduleEvaluation.modules.find(({ module }) => module.name === consumer.name)?.steps[0],
    );
    expect(first.eligibility.refusals[0]?.code).toBe('rust-module-evaluation-entry-invocation-unbound');
  });

  it('preserves split, repeated-target, and type-only dependency evidence without inventing aliases', () => {
    const provider = lower(
      '@scope/math',
      'provider.ts',
      'export const first = 1; export const second = 2; export interface Shape { value: number }',
    );
    const consumer = lower(
      '@scope/math',
      'consumer.ts',
      `import { first } from './provider.js';
       import type { Shape } from './provider.js';
       import { second } from './provider-again.js';
       export function read(_shape: Shape): number { return first + second; }`,
    );
    const dependencies: readonly CompilerModuleLinkDependency[] = [
      {
        importedNames: ['first'],
        importer: identity(consumer),
        specifier: './provider.js',
        target: identity(provider),
      },
      {
        importedNames: ['Shape'],
        importer: identity(consumer),
        specifier: './provider.js',
        target: identity(provider),
      },
      {
        importedNames: ['second'],
        importer: identity(consumer),
        specifier: './provider-again.js',
        target: identity(provider),
      },
    ];

    const plan = createCompilerRustModuleEvaluationRepresentationPlan(
      createInput([consumer, provider], [consumer], dependencies),
    );
    const consumerPlan = getModulePlan(plan, consumer);

    expect(consumerPlan.dependencies).toEqual([
      expect.objectContaining({ evaluation: 'runtime', importedNames: ['first'], specifier: './provider.js' }),
      expect.objectContaining({ evaluation: 'type-only', importedNames: ['Shape'], specifier: './provider.js' }),
      expect.objectContaining({ evaluation: 'runtime', importedNames: ['second'], specifier: './provider-again.js' }),
    ]);
    expect(consumerPlan.bindings.filter(({ kind }) => kind === 'import').map(({ binding }) => binding.name)).toEqual([
      'first',
      'second',
    ]);
    expect(
      consumerPlan.bindings
        .filter((binding) => binding.kind === 'import')
        .map((binding) => [binding.provider.module.name, binding.provider.route.kind]),
    ).toEqual([
      ['Provider', 'binding'],
      ['Provider', 'binding'],
    ]);
  });

  it('classifies function items, proven constants, private scalar state, TDZ storage, and exact step erasure', () => {
    const constants = lower('@scope/math', 'constants.ts', 'export const answer: number = 42;');
    const state = lower(
      '@scope/math',
      'state.ts',
      'let count: number = 0; export function increment(): number { return ++count; }',
    );
    const temporal = lower(
      '@scope/math',
      'temporal.ts',
      'function create(): number { return 1; } export let value: number = create();',
    );
    const references = lower(
      '@scope/math',
      'references.ts',
      'const values = [1]; const alias = values; export function append(): number { alias.push(2); return values.length; }',
    );
    const plan = createCompilerRustModuleEvaluationRepresentationPlan(
      createInput([temporal, references, state, constants], [constants, state, references, temporal], []),
    );
    const constantPlan = getModulePlan(plan, constants);
    const referencePlan = getModulePlan(plan, references);
    const statePlan = getModulePlan(plan, state);
    const temporalPlan = getModulePlan(plan, temporal);

    expect(constantPlan.bindings).toEqual([
      expect.objectContaining({
        decision: { outcome: 'erased', reason: 'primitive-constant' },
        storage: expect.objectContaining({ kind: 'primitive-constant' }),
      }),
    ]);
    expect(constantPlan.steps).toEqual([
      expect.objectContaining({ outcome: expect.objectContaining({ outcome: 'erased' }) }),
    ]);
    expect(statePlan.bindings).toEqual([
      expect.objectContaining({
        decision: { outcome: 'erased', reason: 'private-scalar-state' },
        storage: expect.objectContaining({ kind: 'private-scalar-state' }),
      }),
      expect.objectContaining({
        decision: { outcome: 'erased', reason: 'function-item' },
        storage: { kind: 'function-item' },
      }),
    ]);
    expect(statePlan.steps[0]?.outcome).toMatchObject({ outcome: 'erased' });
    expect(referencePlan.bindings.find(({ binding }) => binding.name === 'values')).toMatchObject({
      decision: {
        outcome: 'refused',
        refusals: expect.arrayContaining([
          expect.objectContaining({ code: 'rust-module-evaluation-binding-carrier-unrepresented' }),
        ]),
      },
      storage: { kind: 'reference-carrier', representation: 'shared-ref-cell-vec' },
    });
    expect(temporalPlan.bindings.find(({ binding }) => binding.name === 'value')).toMatchObject({
      decision: {
        outcome: 'refused',
        refusals: expect.arrayContaining([
          expect.objectContaining({ code: 'rust-module-evaluation-binding-carrier-unrepresented' }),
          expect.objectContaining({ code: 'rust-module-evaluation-tdz-carrier-unrepresented' }),
        ]),
      },
      storage: { kind: 'unrepresented' },
    });
    expect(temporalPlan.steps[0]?.outcome).toMatchObject({
      outcome: 'refused',
      refusals: expect.arrayContaining([
        expect.objectContaining({ code: 'rust-module-evaluation-step-unrepresented' }),
        expect.objectContaining({ code: 'rust-module-evaluation-abrupt-completion-unrepresented' }),
      ]),
    });
  });

  it('refuses mutable live aliases and preserves their exact provider facade evidence', () => {
    const provider = lower('@scope/math', 'provider.ts', 'export let value = 1;');
    const consumer = lower(
      '@scope/math',
      'consumer.ts',
      "import { value } from './provider.js'; export function read(): number { return value; }",
    );
    const dependencies: readonly CompilerModuleLinkDependency[] = [
      { importer: identity(consumer), specifier: './provider.js', target: identity(provider) },
    ];
    const plan = createCompilerRustModuleEvaluationRepresentationPlan(
      createInput([consumer, provider], [consumer], dependencies),
    );
    const alias = getModulePlan(plan, consumer).bindings.find((binding) => binding.kind === 'import');

    expect(alias).toMatchObject({
      decision: {
        outcome: 'refused',
        refusals: [expect.objectContaining({ code: 'rust-module-evaluation-live-alias-unrepresented' })],
      },
      imported: 'value',
      provider: { module: identity(provider), route: { kind: 'binding', module: identity(provider) } },
      request: { module: identity(provider) },
    });
  });

  it('makes placeholder and refusal evidence an all-or-nothing full-output eligibility refusal', () => {
    const retained = lower('@scope/math', 'retained.ts', 'export function keep(): number { return 1; }');
    const placeholder = lower('@scope/math', 'placeholder.ts', 'export const missing = unknownCall();');
    const input = createInput([retained], [retained], [], [placeholder]);
    input.finalization.refusals = [
      { code: 'rust-call-unsupported', message: 'call refused', module: identity(placeholder) },
    ];
    const plan = createCompilerRustModuleEvaluationRepresentationPlan(input);

    expect(plan.eligibility).toMatchObject({ outcome: 'refused', scope: 'full-output' });
    expect(plan.eligibility.refusals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'rust-module-evaluation-output-scope-incomplete' }),
        expect.objectContaining({
          code: 'rust-module-evaluation-salvaged-declaration',
          detailCode: 'rust-call-unsupported',
          module: identity(placeholder),
        }),
      ]),
    );
  });

  it('projects the authoritative evaluation closure while retained output contains unrelated modules', () => {
    const evaluated = lower('@scope/math', 'entry.ts', 'export const value = 1;');
    const unrelated = lower('@scope/math', 'unrelated.ts', 'export const other = 2;');
    const input = createInput([evaluated], [evaluated], []);
    const sourceTree = createCompilerRustSourceTreePlan({
      facade: input.finalization.facade,
      modules: [evaluated, unrelated],
    });
    input.sourceTree = structuredClone(sourceTree) as Mutable<CompilerRustSourceTreePlan>;
    input.finalization.moduleFiles.push({
      file: { contents: '', path: getModuleFilePath(sourceTree, unrelated) },
      module: identity(unrelated),
    });

    const plan = createCompilerRustModuleEvaluationRepresentationPlan(input);

    expect(plan.modules.map(({ module }) => module.name)).toEqual(['Entry']);
    expect(plan.entries.map(({ module }) => module.name)).toEqual(['Entry']);
  });

  it('accepts an empty authoritative evaluation closure beside retained source output', () => {
    const unrelated = lower('@scope/math', 'unrelated.ts', 'export const other = 2;');
    const input = createInput([], [], []);
    const sourceTree = createCompilerRustSourceTreePlan({
      facade: input.finalization.facade,
      modules: [unrelated],
    });
    input.sourceTree = structuredClone(sourceTree) as Mutable<CompilerRustSourceTreePlan>;
    input.finalization.moduleFiles.push({
      file: { contents: '', path: getModuleFilePath(sourceTree, unrelated) },
      module: identity(unrelated),
    });

    const plan = createCompilerRustModuleEvaluationRepresentationPlan(input);

    expect(plan).toMatchObject({ eligibility: { outcome: 'eligible' }, entries: [], groups: [], modules: [] });
  });

  it('represents same-crate SCC lifecycle intent and classifies cross-crate SCCs stably', () => {
    const first = lower(
      '@scope/math',
      'first.ts',
      "import './second.js'; export function first(): number { return 1; }",
    );
    const second = lower(
      '@scope/math',
      'second.ts',
      "import './first.js'; export function second(): number { return 2; }",
    );
    const sameCrateDependencies: readonly CompilerModuleLinkDependency[] = [
      { importer: identity(first), specifier: './second.js', target: identity(second) },
      { importer: identity(second), specifier: './first.js', target: identity(first) },
    ];
    const sameCrate = createCompilerRustModuleEvaluationRepresentationPlan(
      createInput([second, first], [first], sameCrateDependencies),
    );

    expect(sameCrate.groups).toEqual([
      expect.objectContaining({
        cyclic: true,
        representation: { kind: 'same-crate-scc', packageName: '@scope/math' },
      }),
    ]);
    expect(sameCrate.modules[0]?.lifecycle).toEqual({
      evaluate: 'module-private-evaluate-once-function',
      instantiate: 'module-private-instantiate-once-function',
      state: 'module-private-lifecycle-state',
      states: ['uninstantiated', 'instantiating', 'instantiated', 'evaluating', 'evaluated', 'errored'],
    });

    const alpha = lower(
      '@scope/alpha',
      'alpha.ts',
      "import '@scope/beta/beta'; export function alpha(): number { return 1; }",
    );
    const beta = lower(
      '@scope/beta',
      'beta.ts',
      "import '@scope/alpha/alpha'; export function beta(): number { return 2; }",
    );
    const crossCrateDependencies: readonly CompilerModuleLinkDependency[] = [
      { importer: identity(alpha), specifier: '@scope/beta/beta', target: identity(beta) },
      { importer: identity(beta), specifier: '@scope/alpha/alpha', target: identity(alpha) },
    ];
    const crossCrate = createCompilerRustModuleEvaluationRepresentationPlan(
      createInput([alpha, beta], [alpha], crossCrateDependencies),
    );

    expect(crossCrate.groups[0]?.representation).toMatchObject({
      kind: 'refused',
      refusal: { code: 'rust-module-evaluation-cross-crate-cycle-unrepresented' },
    });
  });

  it('fails loudly on projection, file-path, and binding-evidence mismatches', () => {
    const module = lower('@scope/math', 'value.ts', 'export const value = 1;');
    const missingProjection = createInput([module], [module], []);
    missingProjection.finalization.moduleFiles = [];
    expect(captureFailure(missingProjection).code).toBe('rust-module-evaluation-representation-projection-mismatch');

    const pathMismatch = createInput([module], [module], []);
    pathMismatch.finalization.moduleFiles[0]!.file.path = 'wrong.rs';
    expect(captureFailure(pathMismatch).code).toBe('rust-module-evaluation-representation-path-mismatch');

    const bindingMismatch = createInput([module], [module], []);
    bindingMismatch.constantPlan.modules[0]!.bindings[0]!.declarationPath = ['declarations', 99];
    expect(captureFailure(bindingMismatch).code).toBe('rust-module-evaluation-representation-path-mismatch');
  });
});

describe('isCompilerRustModuleEvaluationRepresentationPlanningFailure', () => {
  it('recognizes complete planning failures and rejects lookalikes', () => {
    const failure = Object.assign(new Error('mismatch'), {
      code: 'rust-module-evaluation-representation-projection-mismatch',
      kind: 'rust-module-evaluation-representation-planning',
      subjects: ['module'],
    });

    expect(isCompilerRustModuleEvaluationRepresentationPlanningFailure(failure)).toBe(true);
    expect(isCompilerRustModuleEvaluationRepresentationPlanningFailure(new Error('plain'))).toBe(false);
    expect(isCompilerRustModuleEvaluationRepresentationPlanningFailure({ ...failure })).toBe(false);
    expect(
      isCompilerRustModuleEvaluationRepresentationPlanningFailure(
        Object.assign(new Error('empty'), { ...failure, subjects: [] }),
      ),
    ).toBe(false);
  });
});

describe('createCompilerRustModuleEvaluationRepresentationFinalizationState', () => {
  it('freezes an incomplete output-scope projection without advertising eligibility', () => {
    const retained = lower('@scope/math', 'retained.ts', 'export const value = 1;');
    const placeholder = lower('@scope/math', 'placeholder.ts', 'export const missing = unknownCall();');
    const input = createInput([retained], [retained], [], [placeholder]);
    input.finalization.refusals = [
      { code: 'rust-call-unsupported', message: 'call refused', module: identity(placeholder) },
    ];

    const state = createCompilerRustModuleEvaluationRepresentationFinalizationState(undefined, input);

    expect(state.projection).toMatchObject({
      kind: 'output-scope-incomplete',
      refusal: { code: 'rust-module-evaluation-output-scope-incomplete', subject: 'full-output' },
    });
    expect(state.projection).not.toHaveProperty('eligibility');
    expect(isDeeplyFrozen(state, new WeakSet())).toBe(true);
  });

  it('treats an omitted evaluation file as incomplete instead of semantically refiltering', () => {
    const module = lower('@scope/math', 'entry.ts', 'export const value = 1;');
    const input = createInput([module], [module], []);
    input.finalization.moduleFiles = [];

    const state = createCompilerRustModuleEvaluationRepresentationFinalizationState(undefined, input);

    expect(state.projection).toMatchObject({
      kind: 'output-scope-incomplete',
      subjects: [JSON.stringify([module.packageName, module.source, module.name])],
    });
  });

  it('reuses the first plan by identity and refuses changed finalization provenance', () => {
    const module = lower('@scope/math', 'entry.ts', 'export const value = 1;');
    const input = createInput([module], [module], []);
    const first = createCompilerRustModuleEvaluationRepresentationFinalizationState(undefined, input);
    const repeat = createCompilerRustModuleEvaluationRepresentationFinalizationState(first, input);

    expect(first.projection.kind).toBe('plan');
    expect(repeat).toBe(first);

    input.finalization.refusals = [{ code: 'changed-refusal', message: 'changed', module: identity(module) }];
    let failure: unknown;
    try {
      createCompilerRustModuleEvaluationRepresentationFinalizationState(first, input);
    } catch (error) {
      failure = error;
    }
    expect(isCompilerRustModuleEvaluationRepresentationPlanningFailure(failure)).toBe(true);
    expect(failure).toMatchObject({
      code: 'rust-module-evaluation-representation-finalization-mismatch',
      kind: 'rust-module-evaluation-representation-planning',
    });
    expect(first.projection.kind).toBe('plan');
  });
});

type Mutable<Value> = { -readonly [Key in keyof Value]: Mutable<Value[Key]> };

function captureFailure(
  input: Readonly<CompilerRustModuleEvaluationRepresentationPlanInput>,
): CompilerRustModuleEvaluationRepresentationPlanningFailure {
  try {
    createCompilerRustModuleEvaluationRepresentationPlan(input);
  } catch (error) {
    if (isCompilerRustModuleEvaluationRepresentationPlanningFailure(error)) return error;
    throw error;
  }
  throw new Error('expected Rust module-evaluation representation planning to fail');
}

function createInput(
  modules: readonly Readonly<IrModule>[],
  entries: readonly Readonly<IrModule>[],
  dependencies: readonly Readonly<CompilerModuleLinkDependency>[],
  placeholders: readonly Readonly<IrModule>[] = [],
): Mutable<CompilerRustModuleEvaluationRepresentationPlanInput> {
  const moduleEvaluation = createCompilerModuleEvaluationPlan({
    dependencies,
    entries: entries.map(identity),
    modules,
  });
  const facade = createCompilerModuleFacadePlan({ evaluation: moduleEvaluation, modules });
  const moduleResolution: CompilerModuleResolutionPlan = {
    edges: dependencies,
    schema: 'flight-compiler-module-resolution/1',
  };
  const sourceTree = createCompilerRustSourceTreePlan({
    facade,
    moduleResolution,
    modules,
    ...(placeholders.length === 0 ? {} : { placeholderModules: placeholders }),
  });
  const finalization: CompilerBackendPackageGraphFinalization = {
    facade,
    moduleEvaluation,
    moduleFiles: modules.map((module) => ({
      file: { contents: '', path: getModuleFilePath(sourceTree, module) },
      module: identity(module),
    })),
    ...(placeholders.length === 0 ? {} : { placeholderModules: placeholders }),
  };
  return structuredClone({
    constantPlan: createCompilerRustModuleConstantPlan({ moduleResolution, modules }),
    finalization,
    modules,
    referencePlan: createCompilerRustReferenceRepresentationPlan({ moduleResolution, modules }),
    sourceTree,
    statePlan: createCompilerRustModuleStatePlan({ moduleResolution, modules }),
  }) as Mutable<CompilerRustModuleEvaluationRepresentationPlanInput>;
}

function getModuleFilePath(sourceTree: Readonly<CompilerRustSourceTreePlan>, module: Readonly<IrModule>): string {
  const key = JSON.stringify([module.packageName, module.source, module.name]);
  const planned = sourceTree.modules.find(
    ({ identity: candidate }) => JSON.stringify([candidate.packageName, candidate.source, candidate.name]) === key,
  );
  if (!planned) throw new Error(`missing source-tree module ${key}`);
  return planned.filePath;
}

function getModulePlan(
  plan: ReturnType<typeof createCompilerRustModuleEvaluationRepresentationPlan>,
  module: Readonly<IrModule>,
) {
  const result = plan.modules.find(
    ({ module: candidate }) =>
      candidate.packageName === module.packageName &&
      candidate.source === module.source &&
      candidate.name === module.name,
  );
  if (!result) throw new Error(`missing module plan ${module.packageName}/${module.source}`);
  return result;
}

function identity(module: Readonly<IrModule>): CompilerModuleIdentity {
  return { name: module.name, packageName: module.packageName, source: module.source };
}

function isDeeplyFrozen(value: unknown, seen: WeakSet<object>): boolean {
  if (!value || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((member) => isDeeplyFrozen(member, seen));
}

function lower(packageName: string, file: string, source: string): IrModule {
  const packageLeaf = packageName.slice(packageName.lastIndexOf('/') + 1);
  const sourceFile = ts.createSourceFile(
    `/flight/packages/${packageLeaf}/src/${file}`,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const result = lowerTypeScriptSource(sourceFile, { packageName, upstreamDirectory: '/flight' });
  if (result.diagnostics.length > 0) throw new Error(result.diagnostics.map(({ message }) => message).join('\n'));
  return result.module;
}
