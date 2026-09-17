import type { CompilerBackend } from './compilerBackendContract.js';
import type { CompilerDiagnostic } from './compilerDiagnosticContract.js';
import type { IrModule } from './compilerModuleIntermediateRepresentation.js';
import type {
  CompileIrModulesOptions,
  CompileIrModulesResult,
  CompilerReport,
} from './compilerOrchestrationContract.js';
import type { CompilerSourceLocation } from './compilerSourceIdentity.js';

describe('compiler orchestration contracts', () => {
  it('tie backend input, patch audit, diagnostics, compilation, and report schemas together', () => {
    const module = createModule();
    const backend: CompilerBackend = { emitModule: () => [], name: 'fixture' };
    const options: CompileIrModulesOptions<Record<string, never>> = {
      backend,
      backendOptions: {},
      modules: [module],
    };
    const report: CompilerReport = {
      backend: 'fixture',
      emittedFiles: 0,
      modules: 1,
      schema: 'flight-compiler-report/1',
    };
    const result: CompileIrModulesResult = {
      compilation: { backend: 'fixture', files: [] },
      diagnostics: [],
      patchAudit: {
        applied: [],
        backend: 'haxe',
        schema: 'flight-compiler-patch-audit/2',
        skipped: [],
        summary: { applied: 0, skipped: 0 },
      },
      report,
    };
    const diagnostic: CompilerDiagnostic = {
      code: 'unsupported-typescript',
      column: 1,
      line: 1,
      message: 'unsupported',
      packageName: '@flighthq/math',
      severity: 'error',
      source: 'packages/math/src/value.ts',
    };

    expect(options.modules[0]).toBe(module);
    expect(result.report).toBe(report);
    // A diagnostic names a module and a message. Its position is optional because lowering follows
    // declarations into imported modules, so the offending syntax is not always in `source`.
    expectTypeOf(diagnostic).toMatchTypeOf<Omit<CompilerSourceLocation, 'column' | 'line'>>();
    expectTypeOf(diagnostic.line).toEqualTypeOf<number | undefined>();
    expectTypeOf(diagnostic.column).toEqualTypeOf<number | undefined>();
  });
});

function createModule(): IrModule {
  return {
    declarations: [],
    exports: [],
    imports: [],
    name: 'Value',
    packageName: '@flighthq/math',
    source: 'packages/math/src/value.ts',
  };
}
