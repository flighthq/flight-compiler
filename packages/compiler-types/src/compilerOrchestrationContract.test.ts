import type {
  CompileIrModulesOptions,
  CompileIrModulesResult,
  CompilerReport,
} from './compilerOrchestrationContract.js';
import type { CompilerBackend } from './compilerBackendContract.js';
import type { CompilerDiagnostic } from './compilerDiagnosticContract.js';
import type { IrModule } from './compilerIntermediateRepresentation.js';
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
      patchAudit: { applied: [], schema: 'flight-compiler-patch-audit/1', summary: { applied: 0, skipped: 0 } },
      report,
    };
    const diagnostic: CompilerDiagnostic = {
      code: 'unsupported-typescript',
      column: 1,
      line: 1,
      message: 'unsupported',
      packageName: '@flighthq/math',
      source: 'packages/math/src/value.ts',
    };

    expect(options.modules[0]).toBe(module);
    expect(result.report).toBe(report);
    expectTypeOf(diagnostic).toMatchTypeOf<CompilerSourceLocation>();
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
