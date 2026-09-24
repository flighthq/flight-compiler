import type {
  CompilerModuleIdentity,
  CompilerPackageCheckComparison,
  CompilerPackageCheckFinding,
  CompilerPackageCheckPolicyClass,
  CompilerPackageCompilationModuleReport,
  CompilerPackageCompilationRefusal,
  CompilerPackageCompilationReport,
} from '../../compiler-types/src/index.js';
import {
  compareCompilerPackageCheckBaseline,
  createCompilerPackageCheckBaseline,
  createCompilerPackageCheckPolicyStrict,
  createCompilerPackageCheckReport,
  createCompilerPackageCheckPolicyResult,
  getCompilerPackageCheckReportText,
  getCompilerPackageCheckReportJson,
} from './compilerPackageCheck.js';

describe('compareCompilerPackageCheckBaseline', () => {
  it('keeps relocated findings unchanged and separates introduced findings from stale resolved identities', () => {
    const baselineReport = createCompilerPackageCheckReport(createCompilation(createModules()), createOptions());
    const baseline = createCompilerPackageCheckBaseline(baselineReport);
    const resolvedUnknown = baselineReport.directFindings.find((finding) => finding.rule === 'unknown-rule');
    if (!resolvedUnknown) throw new Error('Expected unknown-rule baseline finding');
    const movedPortable = directModule('@flight/a', 'src/alpha.ts', 'alpha', [
      refusal('portable-call', 'moved message', 70, 12),
    ]);
    const introduced = directModule('@flight/b', 'src/new.ts', 'newValue', [
      refusal('restricted-call', 'new restriction', 1, 1),
    ]);
    const current = createCompilerPackageCheckReport(
      createCompilation([movedPortable, introduced, emittedModule('@flight/a', 'src/value.ts', 'value')]),
      createOptions({ 'restricted-call': 'compiler-restriction' }),
    );
    const baselineSnapshot = JSON.stringify(baseline);
    const currentSnapshot = JSON.stringify(current);

    const comparison = compareCompilerPackageCheckBaseline(current, baseline);

    expect(comparison.schema).toBe('flight-compiler-check-comparison/1');
    expect(comparison.unchanged).toHaveLength(1);
    expect(comparison.unchanged[0]?.rule).toBe('portable-call');
    expect(comparison.unchanged[0]?.occurrences).toEqual([{ column: 12, line: 70, message: 'moved message' }]);
    expect(comparison.introduced.map((finding) => finding.rule)).toEqual(['restricted-call']);
    expect(comparison.resolvedFindingIdentities).toEqual([resolvedUnknown.identity]);
    expect(JSON.stringify(baseline)).toBe(baselineSnapshot);
    expect(JSON.stringify(current)).toBe(currentSnapshot);
  });

  it('refuses a report that is not a check report rather than comparing against it', () => {
    const report = createCompilerPackageCheckReport(createCompilation(createModules()), createOptions());
    const foreign = { ...report, schema: 'flight-compiler-check-report/2' } as unknown as typeof report;

    expect(() => compareCompilerPackageCheckBaseline(foreign, createCompilerPackageCheckBaseline(report))).toThrow(
      'Unsupported check report flight-compiler-check-report/2',
    );
  });

  it('refuses a baseline that is not a check baseline rather than treating it as empty', () => {
    const report = createCompilerPackageCheckReport(createCompilation(createModules()), createOptions());
    const foreign = {
      findingIdentities: [],
      schema: 'flight-compiler-check-baseline/2',
    } as unknown as Parameters<typeof compareCompilerPackageCheckBaseline>[1];

    expect(() => compareCompilerPackageCheckBaseline(report, foreign)).toThrow(
      'Unsupported check baseline flight-compiler-check-baseline/2',
    );
  });
});

describe('createCompilerPackageCheckBaseline', () => {
  it('stores only stable sorted direct-finding identities in a versioned baseline', () => {
    const report = createCompilerPackageCheckReport(createCompilation(createModules()), createOptions());
    const snapshot = JSON.stringify(report);

    const baseline = createCompilerPackageCheckBaseline(report);

    expect(baseline).toEqual({
      findingIdentities: [...report.directFindings.map((finding) => finding.identity)].sort(),
      schema: 'flight-compiler-check-baseline/1',
    });
    expect(baseline.findingIdentities.some((identity) => identity.includes('dependency-refused'))).toBe(false);
    expect(JSON.stringify(report)).toBe(snapshot);
  });

  it('refuses a report that is not a check report rather than recording identities from it', () => {
    const report = createCompilerPackageCheckReport(createCompilation(createModules()), createOptions());
    const foreign = { ...report, schema: 'flight-compiler-check-report/2' } as unknown as typeof report;

    expect(() => createCompilerPackageCheckBaseline(foreign)).toThrow(
      'Unsupported check report flight-compiler-check-report/2',
    );
  });
});

describe('createCompilerPackageCheckPolicyResult', () => {
  it('fails only caller-selected introduced classes and keeps compiler and runtime findings visible', () => {
    const introduced = [
      finding('compiler-defect'),
      finding('compiler-restriction'),
      finding('source-portability'),
      finding('target-runtime'),
      finding('unclassified'),
    ];
    const comparison: CompilerPackageCheckComparison = {
      introduced,
      resolvedFindingIdentities: [],
      schema: 'flight-compiler-check-comparison/1',
      unchanged: [],
    };
    const snapshot = JSON.stringify(comparison);

    const strict = createCompilerPackageCheckPolicyResult(comparison, createCompilerPackageCheckPolicyStrict());
    const runtimeOnly = createCompilerPackageCheckPolicyResult(comparison, {
      failOnIntroduced: ['target-runtime'],
      id: 'runtime-owned-v1',
      schema: 'flight-compiler-check-policy/1',
    });

    expect(strict.passed).toBe(false);
    expect(strict.failingFindingIdentities).toEqual(['compiler-restriction', 'source-portability', 'unclassified']);
    expect(strict.failingFindingIdentities).not.toContain('compiler-defect');
    expect(strict.failingFindingIdentities).not.toContain('target-runtime');
    expect(runtimeOnly.failingFindingIdentities).toEqual(['target-runtime']);
    expect(JSON.stringify(comparison)).toBe(snapshot);
  });

  it('refuses a comparison or policy that is not the versioned record it reads', () => {
    const comparison: CompilerPackageCheckComparison = {
      introduced: [],
      resolvedFindingIdentities: [],
      schema: 'flight-compiler-check-comparison/1',
      unchanged: [],
    };
    const strict = createCompilerPackageCheckPolicyStrict();

    expect(() =>
      createCompilerPackageCheckPolicyResult(
        { ...comparison, schema: 'flight-compiler-check-comparison/2' } as unknown as typeof comparison,
        strict,
      ),
    ).toThrow('Unsupported check comparison flight-compiler-check-comparison/2');
    expect(() =>
      createCompilerPackageCheckPolicyResult(comparison, {
        ...strict,
        schema: 'flight-compiler-check-policy/2',
      } as unknown as typeof strict),
    ).toThrow('Unsupported check policy flight-compiler-check-policy/2');
  });
});

describe('createCompilerPackageCheckPolicyStrict', () => {
  it('attributes newly introduced source, restriction, and unknown findings to the strict Flight policy', () => {
    const first = createCompilerPackageCheckPolicyStrict();
    const second = createCompilerPackageCheckPolicyStrict();

    expect(first).toEqual({
      failOnIntroduced: ['compiler-restriction', 'source-portability', 'unclassified'],
      id: 'strict-flight-attribution-v1',
      schema: 'flight-compiler-check-policy/1',
    });
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second.failOnIntroduced).not.toBe(first.failOnIntroduced);
  });
});

describe('createCompilerPackageCheckReport', () => {
  it('uses producer classifications by default while strict policy ignores runtime findings and cascades', () => {
    const provenance = createOptions().provenance;
    const runtime = directModule('@flight/a', 'src/runtime.ts', 'runtime', [
      {
        classification: 'target-runtime',
        code: 'unsupported-ir',
        message: 'runtime profile lacks a binding',
        rule: 'rust-runtime-profile-incomplete',
        stage: 'emission',
      },
    ]);
    const report = createCompilerPackageCheckReport(
      createCompilation([
        directModule('@flight/a', 'src/restriction.ts', 'restriction', [
          {
            classification: 'compiler-restriction',
            code: 'unsupported-ir',
            message: 'backend cannot lower the construct',
            rule: 'future-backend-capability',
            stage: 'emission',
          },
        ]),
        runtime,
        directModule('@flight/a', 'src/defect.ts', 'defect', [
          { code: 'unsafe-emitted-path', message: 'backend emitted ../value.cpp', stage: 'emission' },
        ]),
        directModule('@flight/a', 'src/unknown.ts', 'unknown', [
          {
            code: 'unsupported-ir',
            message: 'a future producer omitted ownership',
            rule: 'future-unowned-rule',
            stage: 'emission',
          },
        ]),
        cascadeModule('@flight/a', 'src/dependent.ts', 'dependent', ['@flight/a/src/runtime.ts']),
      ]),
      { provenance },
    );

    expect(
      Object.fromEntries(report.directFindings.map((finding) => [finding.module.name, finding.policyClass])),
    ).toEqual({
      defect: 'compiler-defect',
      restriction: 'compiler-restriction',
      runtime: 'target-runtime',
      unknown: 'unclassified',
    });
    expect(report.cascades).toHaveLength(1);
    expect(report.cascades[0]?.directFindingIdentities).toEqual([
      report.directFindings.find((finding) => finding.module.name === 'runtime')?.identity,
    ]);
    const emptyBaseline = createCompilerPackageCheckBaseline(
      createCompilerPackageCheckReport(createCompilation([]), { provenance }),
    );
    const strict = createCompilerPackageCheckPolicyResult(
      compareCompilerPackageCheckBaseline(report, emptyBaseline),
      createCompilerPackageCheckPolicyStrict(),
    );
    const failingClasses = strict.failingFindingIdentities.map(
      (identity) => report.directFindings.find((finding) => finding.identity === identity)?.policyClass,
    );
    expect(failingClasses).toEqual(['compiler-restriction', 'unclassified']);
  });

  it('lets an exact caller rule override producer-owned defaults', () => {
    const module = directModule('@flight/a', 'src/value.ts', 'value', [
      {
        classification: 'compiler-restriction',
        code: 'unsupported-ir',
        message: 'portable source change requested',
        rule: 'portable-call',
        stage: 'emission',
      },
    ]);

    const report = createCompilerPackageCheckReport(createCompilation([module]), createOptions());

    expect(report.directFindings[0]?.policyClass).toBe('source-portability');
  });

  it('is reorder-independent, deduplicates occurrences, and resolves cascades to direct findings', () => {
    const compilation = createCompilation(createModules());
    const options = createOptions();
    const compilationSnapshot = JSON.stringify(compilation);
    const optionsSnapshot = JSON.stringify(options);

    const report = createCompilerPackageCheckReport(compilation, options);
    const reordered = createCompilerPackageCheckReport(
      {
        ...compilation,
        modules: [...compilation.modules]
          .reverse()
          .map((module) => ({ ...module, refusals: [...module.refusals].reverse() })),
        packages: [...compilation.packages].reverse(),
      },
      options,
    );

    expect(reordered).toEqual(report);
    expect(report.schema).toBe('flight-compiler-check-report/1');
    expect(report.provenance).toEqual(createOptions().provenance);
    expect(report.totals).toEqual({
      dependencyCascades: 2,
      directFindings: 2,
      directOccurrences: 3,
      modules: { dependencyRefused: 2, directlyRefused: 2, emitted: 1, total: 5 },
      packages: 2,
    });
    const portable = report.directFindings.find((finding) => finding.rule === 'portable-call');
    const unknown = report.directFindings.find((finding) => finding.rule === 'unknown-rule');
    expect(portable?.policyClass).toBe('source-portability');
    expect(portable?.occurrences).toEqual([
      { column: 4, line: 10, message: 'first spelling' },
      { column: 8, line: 11, message: 'second spelling' },
    ]);
    expect(unknown?.policyClass).toBe('unclassified');
    expect(report.cascades).toHaveLength(2);
    expect(report.cascades.every((cascade) => cascade.directFindingIdentities.length === 1)).toBe(true);
    expect(report.cascades.map((cascade) => cascade.directFindingIdentities[0])).toEqual([
      portable?.identity,
      portable?.identity,
    ]);
    expect(report.packages).toEqual([
      {
        dependencyCascades: 2,
        directFindings: 1,
        directOccurrences: 2,
        findingsByPolicy: {
          'compiler-defect': 0,
          'compiler-restriction': 0,
          'source-portability': 1,
          'target-runtime': 0,
          unclassified: 0,
        },
        modules: { dependencyRefused: 2, directlyRefused: 1, emitted: 1, total: 4 },
        name: '@flight/a',
      },
      {
        dependencyCascades: 0,
        directFindings: 1,
        directOccurrences: 1,
        findingsByPolicy: {
          'compiler-defect': 0,
          'compiler-restriction': 0,
          'source-portability': 0,
          'target-runtime': 0,
          unclassified: 1,
        },
        modules: { dependencyRefused: 0, directlyRefused: 1, emitted: 0, total: 1 },
        name: '@flight/b',
      },
    ]);
    expect(JSON.stringify(compilation)).toBe(compilationSnapshot);
    expect(JSON.stringify(options)).toBe(optionsSnapshot);
  });

  it('refuses an unresolved dependency cascade instead of inferring identity from its message', () => {
    const orphan = cascadeModule('@flight/a', 'src/orphan.ts', 'orphan', ['@flight/a/src/missing.ts']);

    expect(() => createCompilerPackageCheckReport(createCompilation([orphan]), createOptions())).toThrow(
      'unknown module @flight/a/src/missing.ts',
    );
  });

  it('refuses a compilation report that is not the versioned record it reads', () => {
    const compilation = createCompilation(createModules());

    expect(() =>
      createCompilerPackageCheckReport(
        { ...compilation, schema: 'flight-compiler-package-report/2' } as unknown as typeof compilation,
        createOptions(),
      ),
    ).toThrow('Unsupported package compilation report flight-compiler-package-report/2');
  });

  // A report is a summary of exactly one outcome per module and exactly one identity per finding, so the
  // shapes that would make it ambiguous are refused rather than averaged into the counts.
  it('refuses a compilation whose modules or refusals cannot be read as one outcome each', () => {
    const duplicateSubject = [
      directModule('@flight/a', 'src/alpha.ts', 'alpha', [refusal('portable-call', 'one', 1, 1)]),
      emittedModule('@flight/a', 'src/alpha.ts', 'ignored'),
    ];
    const mixedRefusals = [
      {
        ...directModule('@flight/a', 'src/alpha.ts', 'alpha', [refusal('portable-call', 'one', 1, 1)]),
        refusals: [
          refusal('portable-call', 'one', 1, 1),
          {
            code: 'dependency-refused' as const,
            message: 'blocked',
            refusedDependencies: ['@flight/b/src/b.ts'],
            stage: 'dependency' as const,
          },
        ],
      },
    ];
    const refusalWithDependencyStage = [
      directModule('@flight/a', 'src/alpha.ts', 'alpha', [
        { ...refusal('portable-call', 'one', 1, 1), stage: 'dependency' },
      ]),
    ];
    const emittedWithRefusals = [
      { ...emittedModule('@flight/a', 'src/alpha.ts', 'alpha'), refusals: [refusal('portable-call', 'one', 1, 1)] },
    ];
    const refusedWithoutRefusals = [
      {
        module: { name: 'alpha', packageName: '@flight/a', source: 'src/alpha.ts' },
        outputFiles: [],
        refusals: [],
        status: 'refused' as const,
      },
    ];

    expect(() => createCompilerPackageCheckReport(createCompilation(duplicateSubject), createOptions())).toThrow(
      'Duplicate compiler package module @flight/a/src/alpha.ts',
    );
    expect(() => createCompilerPackageCheckReport(createCompilation(mixedRefusals), createOptions())).toThrow(
      'mixes direct and dependency refusals',
    );
    expect(() =>
      createCompilerPackageCheckReport(createCompilation(refusalWithDependencyStage), createOptions()),
    ).toThrow('uses dependency stage');
    expect(() => createCompilerPackageCheckReport(createCompilation(emittedWithRefusals), createOptions())).toThrow(
      'has refusals',
    );
    expect(() => createCompilerPackageCheckReport(createCompilation(refusedWithoutRefusals), createOptions())).toThrow(
      'has no refusals',
    );
  });

  it('refuses a cascade that cannot be resolved to the findings that blocked it', () => {
    const unknownModule = [cascadeModule('@flight/a', 'src/beta.ts', 'beta', ['@flight/a/src/absent.ts'])];
    const throughEmitted = [
      emittedModule('@flight/a', 'src/alpha.ts', 'alpha'),
      cascadeModule('@flight/a', 'src/beta.ts', 'beta', ['@flight/a/src/alpha.ts']),
    ];
    const cycle = [
      cascadeModule('@flight/a', 'src/beta.ts', 'beta', ['@flight/a/src/gamma.ts']),
      cascadeModule('@flight/a', 'src/gamma.ts', 'gamma', ['@flight/a/src/beta.ts']),
    ];
    const withoutDependencies = [
      {
        ...cascadeModule('@flight/a', 'src/beta.ts', 'beta', ['@flight/a/src/alpha.ts']),
        refusals: [{ code: 'dependency-refused' as const, message: 'blocked', stage: 'dependency' as const }],
      },
    ];

    expect(() => createCompilerPackageCheckReport(createCompilation(unknownModule), createOptions())).toThrow(
      'references unknown module @flight/a/src/absent.ts',
    );
    expect(() => createCompilerPackageCheckReport(createCompilation(throughEmitted), createOptions())).toThrow(
      'references emitted module @flight/a/src/alpha.ts',
    );
    expect(() => createCompilerPackageCheckReport(createCompilation(cycle), createOptions())).toThrow(
      'Dependency refusal cycle at @flight/a/src/beta.ts',
    );
    expect(() => createCompilerPackageCheckReport(createCompilation(withoutDependencies), createOptions())).toThrow(
      'has no refused dependencies',
    );
  });

  it('resolves mutual, self, and long refusal cycles through their reachable direct finding', () => {
    const bad = directModule('@flighthq/types', 'packages/types/src/Bad.ts', 'Bad', [
      refusal('unsupported-interface', 'unsupported interface', 1, 1),
    ]);
    const modules = [
      bad,
      cascadeModule('@flighthq/types', 'packages/types/src/App.ts', 'App', [
        '@flighthq/types/packages/types/src/Bad.ts',
        '@flighthq/types/packages/types/src/Child.ts',
      ]),
      cascadeModule('@flighthq/types', 'packages/types/src/Child.ts', 'Child', [
        '@flighthq/types/packages/types/src/App.ts',
      ]),
      cascadeModule('@flighthq/types', 'packages/types/src/Self.ts', 'Self', [
        '@flighthq/types/packages/types/src/Bad.ts',
        '@flighthq/types/packages/types/src/Self.ts',
      ]),
      cascadeModule('@flighthq/types', 'packages/types/src/LongA.ts', 'LongA', [
        '@flighthq/types/packages/types/src/LongB.ts',
      ]),
      cascadeModule('@flighthq/types', 'packages/types/src/LongB.ts', 'LongB', [
        '@flighthq/types/packages/types/src/LongC.ts',
      ]),
      cascadeModule('@flighthq/types', 'packages/types/src/LongC.ts', 'LongC', [
        '@flighthq/types/packages/types/src/Bad.ts',
        '@flighthq/types/packages/types/src/LongA.ts',
      ]),
    ];

    const report = createCompilerPackageCheckReport(createCompilation(modules), createOptions());
    const directIdentity = report.directFindings[0]?.identity;

    expect(report.directFindings.map((finding) => finding.module.name)).toEqual(['Bad']);
    expect(report.cascades.map((cascade) => cascade.module.name)).toEqual([
      'App',
      'Child',
      'LongA',
      'LongB',
      'LongC',
      'Self',
    ]);
    expect(report.cascades.every((cascade) => cascade.directFindingIdentities[0] === directIdentity)).toBe(true);
  });

  it('refuses a classification table it cannot read or reconcile', () => {
    const compilation = createCompilation(createModules());

    expect(() =>
      createCompilerPackageCheckReport(compilation, {
        classification: { codes: {}, rules: {}, schema: 'flight-compiler-check-classification/2' } as never,
        provenance: createOptions().provenance,
      }),
    ).toThrow('Unsupported check classification flight-compiler-check-classification/2');
    expect(() =>
      createCompilerPackageCheckReport(compilation, {
        classification: {
          codes: {},
          rules: { 'portable-call': 'not-a-class' as never },
          schema: 'flight-compiler-check-classification/1',
        },
        provenance: createOptions().provenance,
      }),
    ).toThrow('Unknown compiler check policy class not-a-class');
    // Two spellings a canonical form reads as one rule may not disagree about who owns it.
    expect(() =>
      createCompilerPackageCheckReport(compilation, {
        classification: {
          codes: {},
          rules: { 'caf\u00e9': 'source-portability', 'cafe\u0301': 'compiler-defect' },
          schema: 'flight-compiler-check-classification/1',
        },
        provenance: createOptions().provenance,
      }),
    ).toThrow('Conflicting classifications for caf\u00e9');
  });
});

describe('getCompilerPackageCheckReportJson', () => {
  it('serializes the versioned report as stable indented JSON with a final newline', () => {
    const modules = createModules();
    const report = createCompilerPackageCheckReport(createCompilation(modules), createOptions());
    const reordered = createCompilerPackageCheckReport(createCompilation([...modules].reverse()), createOptions());

    const serialized = getCompilerPackageCheckReportJson(report);

    expect(serialized).toBe(getCompilerPackageCheckReportJson(reordered));
    expect(serialized.endsWith('\n')).toBe(true);
    expect(JSON.parse(serialized)).toEqual(report);
    expect(JSON.parse(serialized).schema).toBe('flight-compiler-check-report/1');
  });
});

describe('getCompilerPackageCheckReportText', () => {
  it('renders deterministic policy, rule, package, and cascade groups with provenance', () => {
    const report = createCompilerPackageCheckReport(createCompilation(createModules()), createOptions());
    const rendered = getCompilerPackageCheckReportText(report);

    expect(rendered).toContain(
      'Provenance: compiler=flight-compiler@compiler-revision target=flight-cpp@target-revision upstream=flight@upstream-revision backend=cpp typescript=5.9.3',
    );
    expect(rendered).toContain('Policy: source-portability\n  Rule: portable-call\n    Package: @flight/a');
    expect(rendered).toContain('Policy: unclassified\n  Rule: unknown-rule\n    Package: @flight/b');
    expect(rendered).toContain('Dependency cascades: 2\n  Package: @flight/a');
    expect(rendered.indexOf('Policy: source-portability')).toBeLessThan(rendered.indexOf('Policy: unclassified'));
    expect(rendered.endsWith('\n')).toBe(true);
  });

  it('refuses a report that is not a check report rather than serializing it', () => {
    const report = createCompilerPackageCheckReport(createCompilation(createModules()), createOptions());
    const foreign = { ...report, schema: 'flight-compiler-check-report/2' } as unknown as typeof report;

    expect(() => getCompilerPackageCheckReportJson(foreign)).toThrow(
      'Unsupported check report flight-compiler-check-report/2',
    );
    expect(() => getCompilerPackageCheckReportText(foreign)).toThrow(
      'Unsupported check report flight-compiler-check-report/2',
    );
  });

  // A finding with no rule is identified by its code, and an occurrence without a position prints none:
  // both are the renderer's own decisions, not gaps in the data.
  it('prints a finding by code when it carries no rule and an occurrence without a position', () => {
    const report = createCompilerPackageCheckReport(
      createCompilation([
        directModule('@flight/a', 'src/alpha.ts', 'alpha', [
          { code: 'unsupported-ir', message: 'no rule to group by', stage: 'emission' },
        ]),
      ]),
      createOptions(),
    );

    const rendered = getCompilerPackageCheckReportText(report);

    expect(rendered).toContain('Code: unsupported-ir');
    expect(rendered).toContain('no rule to group by');
    expect(rendered).not.toContain('Rule: undefined');
  });
});

function cascadeModule(
  packageName: string,
  source: string,
  name: string,
  refusedDependencies: readonly string[],
): CompilerPackageCompilationModuleReport {
  return {
    module: { name, packageName, source },
    outputFiles: [],
    refusals: [
      {
        code: 'dependency-refused',
        message: `Dependency ${refusedDependencies[0] ?? 'unknown'} refused`,
        refusedDependencies,
        stage: 'dependency',
      },
    ],
    status: 'refused',
  };
}

function createCompilation(
  modules: readonly CompilerPackageCompilationModuleReport[],
): CompilerPackageCompilationReport {
  const packageNames = [...new Set(modules.map((module) => module.module.packageName))].reverse();
  return {
    backend: 'cpp',
    entries: [],
    exports: {} as CompilerPackageCompilationReport['exports'],
    files: [],
    initialization: {} as CompilerPackageCompilationReport['initialization'],
    modules,
    packages: packageNames.map((name) => ({
      dependencies: [],
      modules: modules.filter((module) => module.module.packageName === name),
      name,
      outputFiles: [],
    })),
    schema: 'flight-compiler-package-report/1',
    typescript: {
      checkerMode: 'package-graph-program',
      compilerOptions: {
        module: 'ESNext',
        moduleResolution: 'compiler-graph-with-typescript-fallback',
        noImplicitAny: true,
        standardLibrary: 'typescript-bundled',
        strictNullChecks: true,
        target: 'ESNext',
      },
      schema: 'flight-compiler-typescript-analysis/1',
      typescriptVersion: '5.9.3',
    },
  };
}

function createModules(): CompilerPackageCompilationModuleReport[] {
  return [
    directModule('@flight/a', 'src\\alpha.ts', 'alpha', [
      refusal('portable-call', 'second spelling', 11, 8),
      refusal('portable-call', 'first spelling', 10, 4),
      refusal('portable-call', 'first spelling', 10, 4),
    ]),
    cascadeModule('@flight/a', 'src/beta.ts', 'beta', ['@flight/a/src\\alpha.ts']),
    cascadeModule('@flight/a', 'src/gamma.ts', 'gamma', ['@flight/a/src/beta.ts']),
    emittedModule('@flight/a', 'src/value.ts', 'value'),
    directModule('@flight/b', 'src/unknown.ts', 'unknown', [refusal('unknown-rule', 'unknown owner', 2, 3)]),
  ];
}

function createOptions(extraRules: Readonly<Record<string, CompilerPackageCheckPolicyClass>> = {}) {
  return {
    classification: {
      codes: { 'internal-error': 'compiler-defect' as const },
      rules: { 'portable-call': 'source-portability' as const, ...extraRules },
      schema: 'flight-compiler-check-classification/1' as const,
    },
    provenance: {
      compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
      target: { name: 'flight-cpp', revision: 'target-revision' },
      upstream: { name: 'flight', revision: 'upstream-revision' },
    },
  };
}

function directModule(
  packageName: string,
  source: string,
  name: string,
  refusals: readonly CompilerPackageCompilationRefusal[],
): CompilerPackageCompilationModuleReport {
  return { module: { name, packageName, source }, outputFiles: [], refusals, status: 'refused' };
}

function emittedModule(packageName: string, source: string, name: string): CompilerPackageCompilationModuleReport {
  return { module: { name, packageName, source }, outputFiles: [`${name}.hpp`], refusals: [], status: 'emitted' };
}

function finding(policyClass: CompilerPackageCheckPolicyClass): CompilerPackageCheckFinding {
  const module: CompilerModuleIdentity = { name: 'value', packageName: '@flight/test', source: 'src/value.ts' };
  return {
    code: 'internal-error',
    identity: policyClass,
    module,
    occurrences: [{ message: policyClass }],
    policyClass,
    rule: policyClass,
    stage: 'lowering',
  };
}

function refusal(rule: string, message: string, line: number, column: number): CompilerPackageCompilationRefusal {
  return { code: 'internal-error', column, line, message, rule, stage: 'lowering' };
}
