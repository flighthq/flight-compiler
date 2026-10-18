import ts from 'typescript';

import { createCompilerModuleEvaluationPlan } from '../../compiler-module/src/index.js';
import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type {
  CompilerBackendEmissionSession,
  CompilerBackendPackageGraphFinalization,
  CompilerModuleFacadePlan,
  CompilerModuleIdentity,
  IrModule,
} from '../../compiler-types/src/index.js';
import { createRustCompilerBackend } from './rustCompilerBackend.js';

const emptyModuleEvaluation = createCompilerModuleEvaluationPlan({ dependencies: [], entries: [], modules: [] });

describe('createCompilerRustModuleEvaluationRepresentationFinalizationState', () => {
  it('keeps empty-entry package output identical across repeated finalization', () => {
    const module = lower('value.ts', 'export const value = 1;');
    const session = createSession([module], emptyModuleEvaluation);
    const finalization = createFinalization(session, [module], []);

    const first = session.finalizePackageGraph!(finalization);
    const repeat = session.finalizePackageGraph!(finalization);

    expect(repeat).toEqual(first);
    expect(repeat.moduleFileReplacements?.[0]?.file.contents).toBe(first.moduleFileReplacements?.[0]?.file.contents);
  });

  it('injects authoritative module lifecycles and root group hooks with the selected runtime crate', () => {
    const root = lower('index.ts', 'export const root = 1;');
    const nested = lower('item.ts', 'export const item = 2;');
    const moduleEvaluation = createCompilerModuleEvaluationPlan({
      dependencies: [],
      entries: [identity(nested), identity(root)],
      modules: [nested, root],
    });
    const session = createSession([root, nested], moduleEvaluation, 'selected_runtime');
    const finalization: CompilerBackendPackageGraphFinalization = {
      facade: createFacade([nested, root]),
      moduleEvaluation,
      moduleFiles: [root, nested].map((module) => ({
        file: session.emitModule(module)[0]!,
        module: identity(module),
      })),
    };

    const first = session.finalizePackageGraph!(finalization);
    const repeat = session.finalizePackageGraph!(finalization);
    const rootContents = first.moduleFileReplacements?.find(({ file }) => file.path === 'lib.rs')?.file.contents ?? '';
    const nestedContents =
      first.moduleFileReplacements?.find(({ file }) => file.path === 'item.rs')?.file.contents ?? '';

    expect(repeat).toEqual(first);
    expect(rootContents.indexOf('pub mod item;')).toBeLessThan(
      rootContents.indexOf('enum __FlightModuleEvaluationState'),
    );
    expect(countText(rootContents, 'enum __FlightModuleEvaluationState')).toBe(1);
    expect(countText(nestedContents, 'enum __FlightModuleEvaluationState')).toBe(1);
    expect(countText(rootContents, 'pub(crate) fn __flight_instantiate_once()')).toBe(1);
    expect(countText(nestedContents, 'pub(crate) fn __flight_instantiate_once()')).toBe(1);
    expect(countText(rootContents, 'pub fn __flight_instantiate_group_')).toBe(2);
    expect(countText(rootContents, 'pub fn __flight_evaluate_group_')).toBe(2);
    expect(rootContents).toContain('selected_runtime::FlightModuleEvaluationError');
    expect(nestedContents).toContain('selected_runtime::FlightModuleEvaluationError');
    expect(rootContents).toContain(
      'let result: std::result::Result<(), selected_runtime::FlightModuleEvaluationError> = Ok(());',
    );
  });

  it('retains scoped output when an authoritative evaluation module has no file', () => {
    const entry = lower('entry.ts', 'export const value = 1;');
    const retained = lower('retained.ts', 'export const other = 2;');
    const moduleEvaluation = createCompilerModuleEvaluationPlan({
      dependencies: [],
      entries: [identity(entry)],
      modules: [entry],
    });
    const session = createSession([entry, retained], moduleEvaluation);
    const finalization: CompilerBackendPackageGraphFinalization = {
      facade: createFacade([retained]),
      moduleEvaluation,
      moduleFiles: [{ file: session.emitModule(retained)[0]!, module: identity(retained) }],
    };

    const result = session.finalizePackageGraph!(finalization);

    expect(result.moduleFileReplacements?.map(({ file }) => file.path)).toEqual(['retained.rs']);
    expect(collectFinalizedSource(result)).not.toContain('__flight_');
  });

  it('keeps placeholder declaration salvage output unchanged', () => {
    const source = `export function broken(value: unknown): { value: number } {
      return value as { value: number };
    }
    export function keep(value: number): number { return value + 1; }`;
    const module = lower('salvage.ts', source);
    const moduleEvaluation = createCompilerModuleEvaluationPlan({
      dependencies: [],
      entries: [identity(module)],
      modules: [module],
    });
    const session = createSession([module], moduleEvaluation);
    session.finalizePackageGraph!({
      facade: createFacade([module]),
      moduleEvaluation,
      moduleFiles: [],
      placeholderModules: [module],
      refusals: [
        {
          code: 'rust-cast-requires-type-directed-lowering',
          message: 'declaration refused',
          module: identity(module),
        },
      ],
    });
    const emitPlaceholder = session.emitRefusalPlaceholder;
    if (!emitPlaceholder) throw new Error('expected the Rust session to expose a refusal placeholder emitter');

    const placeholder = emitPlaceholder(module, { message: 'declaration refused', sourceText: source });

    expect(placeholder?.contents).toContain('// PARTIAL:');
    expect(placeholder?.contents).toContain('pub fn keep');
    expect(placeholder?.contents).toContain('// NOT GENERATED: function broken -- source line 1');
    expect(placeholder?.contents).not.toContain('__flight_');
  });

  it('wraps changed repeat provenance and preserves the first successful cache', () => {
    const module = lower('value.ts', 'export const value = 1;');
    const session = createSession([module], emptyModuleEvaluation);
    const finalization = createFinalization(session, [module], []);
    const first = session.finalizePackageGraph!(finalization);
    const changed: CompilerBackendPackageGraphFinalization = {
      ...finalization,
      refusals: [{ code: 'changed-refusal', message: 'changed provenance', module: identity(module) }],
    };

    const failure = captureFinalization(() => session.finalizePackageGraph!(changed));

    expect(failure).toMatchObject({
      backend: 'rust',
      code: 'rust-module-evaluation-representation-finalization-mismatch',
      kind: 'compiler-backend-finalization',
      subjects: ['module-evaluation-representation'],
    });
    expect(failure.cause).toMatchObject({ kind: 'rust-module-evaluation-representation-planning' });
    expect(session.finalizePackageGraph!(finalization)).toEqual(first);
  });

  it('publishes representation and placeholder caches only after finalization succeeds', () => {
    const module = lower(
      'failed.ts',
      'export function failed(value: unknown): { value: number } { return value as { value: number }; }',
    );
    const session = createSession([module], emptyModuleEvaluation);

    expect(() =>
      session.finalizePackageGraph!({
        facade: createFacade([]),
        moduleEvaluation: emptyModuleEvaluation,
        moduleFiles: [{ file: { contents: '', path: 'failed.rs' }, module: identity(module) }],
      }),
    ).toThrow();

    expect(() =>
      session.finalizePackageGraph!({
        facade: createFacade([module]),
        moduleEvaluation: emptyModuleEvaluation,
        moduleFiles: [],
        placeholderModules: [module],
        refusals: [{ code: 'rust-cast-requires-type-directed-lowering', message: 'refused', module: identity(module) }],
      }),
    ).not.toThrow();
  });

  it('wraps representation projection failures with their exact cause', () => {
    const module = lower('value.ts', 'export const value = 1;');
    const session = createSession([module], emptyModuleEvaluation);
    const finalization = createFinalization(session, [module], []);
    const duplicate: CompilerBackendPackageGraphFinalization = {
      ...finalization,
      moduleFiles: [finalization.moduleFiles[0]!, finalization.moduleFiles[0]!],
    };

    const failure = captureFinalization(() => session.finalizePackageGraph!(duplicate));

    expect(failure).toMatchObject({
      backend: 'rust',
      code: 'rust-module-evaluation-representation-duplicate-identity',
      kind: 'compiler-backend-finalization',
    });
    expect(failure.cause).toMatchObject({
      code: 'rust-module-evaluation-representation-duplicate-identity',
      kind: 'rust-module-evaluation-representation-planning',
    });
  });

  it('wraps execution planning failures with their exact cause', () => {
    const module = lower('reserved.ts', 'export function __flight_user(): number { return 1; }');
    const moduleEvaluation = createCompilerModuleEvaluationPlan({
      dependencies: [],
      entries: [identity(module)],
      modules: [module],
    });
    const session = createSession([module], moduleEvaluation);
    const finalization: CompilerBackendPackageGraphFinalization = {
      facade: createFacade([module]),
      moduleEvaluation,
      moduleFiles: [{ file: session.emitModule(module)[0]!, module: identity(module) }],
    };

    const failure = captureFinalization(() => session.finalizePackageGraph!(finalization));

    expect(failure).toMatchObject({
      backend: 'rust',
      code: 'rust-module-evaluation-execution-reserved-name-collision',
      kind: 'compiler-backend-finalization',
    });
    expect(failure.cause).toMatchObject({
      code: 'rust-module-evaluation-execution-reserved-name-collision',
      kind: 'rust-module-evaluation-execution-planning',
    });
  });
});

function captureFinalization(run: () => unknown): Readonly<{
  backend?: string;
  cause?: unknown;
  code?: string;
  kind?: string;
  subjects?: readonly string[];
}> {
  try {
    run();
  } catch (error) {
    return error as Readonly<{
      backend?: string;
      cause?: unknown;
      code?: string;
      kind?: string;
      subjects?: readonly string[];
    }>;
  }
  throw new Error('expected finalization to fail and it did not');
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

function createFinalization(
  session: Readonly<CompilerBackendEmissionSession>,
  retainedModules: readonly Readonly<IrModule>[],
  facadeModules: readonly Readonly<IrModule>[],
): CompilerBackendPackageGraphFinalization {
  return {
    facade: createFacade(facadeModules),
    moduleEvaluation: emptyModuleEvaluation,
    moduleFiles: retainedModules.map((module) => ({
      file: session.emitModule(module)[0]!,
      module: identity(module),
    })),
  };
}

function createSession(
  modules: readonly Readonly<IrModule>[],
  moduleEvaluation: Readonly<ReturnType<typeof createCompilerModuleEvaluationPlan>>,
  runtimeCrate?: string,
): CompilerBackendEmissionSession {
  return createRustCompilerBackend().createEmissionSession!({
    moduleEvaluation,
    modules,
    options: runtimeCrate === undefined ? {} : { runtimeCrate },
  });
}

function collectFinalizedSource(
  result: Readonly<ReturnType<NonNullable<CompilerBackendEmissionSession['finalizePackageGraph']>>>,
): string {
  return [
    ...(result.moduleFileReplacements ?? []).map(({ file }) => file.contents),
    ...result.packageFiles.map(({ file }) => file.contents),
  ].join('\n');
}

function countText(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

function identity(module: Readonly<IrModule>): CompilerModuleIdentity {
  return { name: module.name, packageName: module.packageName, source: module.source };
}

function lower(file: string, source: string): IrModule {
  const result = lowerTypeScriptSource(
    ts.createSourceFile(`/flight/packages/math/src/${file}`, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
    { packageName: '@scope/math', upstreamDirectory: '/flight' },
  );
  if (result.diagnostics.length > 0) throw new Error(result.diagnostics.map(({ message }) => message).join('\n'));
  return result.module;
}
