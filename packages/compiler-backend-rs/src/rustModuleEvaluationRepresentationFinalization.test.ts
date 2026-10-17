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
  });

  it('keeps placeholder declaration salvage output unchanged', () => {
    const source = `export function broken(value: unknown): { value: number } {
      return value as { value: number };
    }
    export function keep(value: number): number { return value + 1; }`;
    const module = lower('salvage.ts', source);
    const session = createSession([module], emptyModuleEvaluation);
    session.finalizePackageGraph!({
      facade: createFacade([module]),
      moduleEvaluation: emptyModuleEvaluation,
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
): CompilerBackendEmissionSession {
  return createRustCompilerBackend().createEmissionSession!({ moduleEvaluation, modules, options: {} });
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
