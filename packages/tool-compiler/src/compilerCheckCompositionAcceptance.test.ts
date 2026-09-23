import type { CompilerBackend, CompilerPackageCheckReport } from './index.js';
import {
  compareCompilerPackageCheckBaseline,
  compileFlightWorkspace,
  createBackendEmissionFailure,
  createCompilerPackageCheckBaseline,
  createCompilerPackageCheckPolicyResult,
  createCompilerPackageCheckPolicyStrict,
  createCompilerPackageCheckReport,
  createFlightPackageEligibilityPlan,
  createMemoryWorkspaceSource,
  readFlightPackageManifests,
} from './index.js';

interface AcceptanceBackendOptions {
  readonly refusedModuleNames: readonly string[];
}

describe('@flighthq/tool-compiler programmatic check composition', () => {
  it('admits an unchanged direct finding and rejects a newly introduced one without writing the workspace', () => {
    const files = createWorkspaceFiles();
    const snapshot = structuredClone(files);
    const source = createMemoryWorkspaceSource(files);
    const manifests = readFlightPackageManifests({ upstreamDirectory: '/flight' }, source);
    const eligibility = createFlightPackageEligibilityPlan({
      environment: 'web',
      packages: manifests,
      selectedPackageNames: ['@flighthq/app'],
    });
    const observedOptions: string[][] = [];
    const backend: CompilerBackend<AcceptanceBackendOptions> = {
      createEmissionSession({ options }) {
        observedOptions.push([...options.refusedModuleNames]);
        return {
          emitModule(module) {
            if (options.refusedModuleNames.includes(module.name)) {
              throw createBackendEmissionFailure(
                'acceptance',
                module,
                `${module.name} is unsupported by the fixture target`,
                'fixture-unsupported',
              );
            }
            return [
              {
                contents: module.name,
                path: `${module.packageName.slice('@flighthq/'.length)}/${module.name}.txt`,
              },
            ];
          },
        };
      },
      emitModule: () => {
        throw new Error('workspace compilation must use one target backend session');
      },
      name: 'acceptance',
    };
    const compile = (refusedModuleNames: readonly string[]): CompilerPackageCheckReport => {
      const compilation = compileFlightWorkspace({
        backend,
        backendOptions: { refusedModuleNames },
        eligiblePackageNames: eligibility.eligiblePackageNames,
        source,
        upstreamDirectory: '/flight',
      });
      return createCompilerPackageCheckReport(compilation.report, {
        classification: {
          rules: { 'fixture-unsupported': 'compiler-restriction' },
          schema: 'flight-compiler-check-classification/1',
        },
        provenance: {
          compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
          target: { name: 'fixture-target', revision: 'target-revision' },
          upstream: { name: 'flight', revision: 'upstream-revision' },
        },
      });
    };

    const baselineReport = compile(['Bad']);
    const baseline = createCompilerPackageCheckBaseline(baselineReport);
    const unchanged = compareCompilerPackageCheckBaseline(baselineReport, baseline);
    const unchangedPolicy = createCompilerPackageCheckPolicyResult(unchanged, createCompilerPackageCheckPolicyStrict());
    const currentReport = compile(['Bad', 'NewBad']);
    const current = compareCompilerPackageCheckBaseline(currentReport, baseline);
    const currentPolicy = createCompilerPackageCheckPolicyResult(current, createCompilerPackageCheckPolicyStrict());

    expect(manifests.map(({ environment, name }) => ({ environment, name }))).toEqual([
      { environment: 'web', name: '@flighthq/app' },
      { environment: 'web', name: '@flighthq/base' },
    ]);
    expect(eligibility).toEqual({
      eligiblePackageNames: ['@flighthq/app', '@flighthq/base'],
      environment: 'web',
      schema: 'flight-compiler-package-eligibility/1',
    });
    expect(baselineReport.directFindings.map((finding) => finding.module.name)).toEqual(['Bad']);
    expect(baselineReport.cascades).toHaveLength(3);
    expect(
      baselineReport.cascades.every(
        (cascade) =>
          cascade.directFindingIdentities.length === 1 &&
          cascade.directFindingIdentities[0] === baselineReport.directFindings[0]?.identity,
      ),
    ).toBe(true);
    expect(baselineReport.totals.modules).toEqual({
      dependencyRefused: 3,
      directlyRefused: 1,
      emitted: 1,
      total: 5,
    });
    expect(unchanged.introduced).toEqual([]);
    expect(unchanged.unchanged).toHaveLength(1);
    expect(unchangedPolicy).toMatchObject({ failingFindingIdentities: [], passed: true });
    expect(current.unchanged.map((finding) => finding.module.name)).toEqual(['Bad']);
    expect(current.introduced.map((finding) => finding.module.name)).toEqual(['NewBad']);
    expect(currentPolicy).toEqual({
      failingFindingIdentities: current.introduced.map((finding) => finding.identity),
      passed: false,
      policy: createCompilerPackageCheckPolicyStrict(),
      schema: 'flight-compiler-check-policy-result/1',
    });
    expect(observedOptions).toEqual([['Bad'], ['Bad', 'NewBad']]);
    expect(files).toEqual(snapshot);
  });
});

function createPackageManifest(name: string, dependencies: Readonly<Record<string, string>> = {}): string {
  return JSON.stringify({
    dependencies,
    exports: {
      '.': { default: './dist/index.js', types: './dist/index.d.ts' },
    },
    flight: { environment: 'web' },
    name,
    version: '1.0.0',
  });
}

function createWorkspaceFiles(): Record<string, string> {
  return {
    '/flight/packages/app/package.json': createPackageManifest('@flighthq/app', { '@flighthq/base': '*' }),
    '/flight/packages/app/src/consumer.ts': "import { bad } from '@flighthq/base'; export const result = bad;",
    '/flight/packages/app/src/index.ts': "export { result } from './consumer.js';",
    '/flight/packages/base/package.json': createPackageManifest('@flighthq/base'),
    '/flight/packages/base/src/bad.ts': 'export const bad = 1;',
    '/flight/packages/base/src/index.ts': "export { bad } from './bad.js'; export { newBad } from './newBad.js';",
    '/flight/packages/base/src/newBad.ts': 'export const newBad = 2;',
  };
}
