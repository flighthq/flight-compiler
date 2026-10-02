import type { CompilerBackend, CompilerPackageCheckReport } from './index.js';
import {
  analyzeTypeScriptSourcePortability,
  compareCompilerPackageCheckBaseline,
  compileFlightWorkspace,
  compileTypeScriptPackageGraph,
  createBackendEmissionFailure,
  createCompilerPackageCheckBaseline,
  createCompilerPackageCheckPolicyResult,
  createCompilerPackageCheckPolicyStrict,
  createCompilerPackageCheckReport,
  createFlightPackageEligibilityPlan,
  createFlightWorkspaceCompilationInput,
  createMemoryWorkspaceSource,
  readFlightPackageManifests,
} from './index.js';

interface AcceptanceBackendOptions {
  readonly refusedModuleNames: readonly string[];
}

describe('@flighthq/tool-compiler programmatic check composition', () => {
  it('composes source portability analysis into a check without changing compilation status', () => {
    const source = createMemoryWorkspaceSource({
      '/flight/packages/app/package.json': createPackageManifest('@flighthq/app'),
      '/flight/packages/app/src/index.ts':
        'export function coerce(value: number): number { return value as unknown as number; }',
    });
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/app'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const comparison = compareCompilerPackageCheckBaseline(report, {
      findingIdentities: [],
      schema: 'flight-compiler-check-baseline/1',
    });

    expect(compilation.report.modules).toMatchObject([{ refusals: [], status: 'emitted' }]);
    expect(sourcePortability.findings).toHaveLength(1);
    expect(report.directFindings).toMatchObject([
      {
        code: 'source-portability',
        policyClass: 'source-portability',
        rule: 'unchecked-double-assertion',
        stage: 'source',
      },
    ]);
    expect(createCompilerPackageCheckPolicyResult(comparison, createCompilerPackageCheckPolicyStrict())).toMatchObject({
      failingFindingIdentities: [report.directFindings[0]?.identity],
      passed: false,
    });
  });

  it('keeps conventional test tooling out of checks without dropping similarly named production sources', () => {
    const source = createMemoryWorkspaceSource({
      '/flight/packages/app/package.json': createPackageManifest('@flighthq/app'),
      '/flight/packages/app/src/gl.test.ts': "import { expectReady } from './glTestHelper.js'; expectReady({});",
      '/flight/packages/app/src/glTestHelper.ts':
        "import { expect } from 'vitest'; export function expectReady(value: unknown): void { expect(value as unknown as number); }",
      '/flight/packages/app/src/glTestHelpers.ts':
        'export function coerce(value: number): number { return value as unknown as number; }',
      '/flight/packages/app/src/index.ts': "export { coerce } from './glTestHelpers.js';",
    });
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/app'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });

    expect(input.sources.map(({ sourceFile }) => sourceFile.fileName)).toEqual([
      '/flight/packages/app/src/glTestHelpers.ts',
      '/flight/packages/app/src/index.ts',
    ]);
    expect(compilation.report.modules).toMatchObject([
      { module: { source: 'packages/app/src/glTestHelpers.ts' }, refusals: [], status: 'emitted' },
      { module: { source: 'packages/app/src/index.ts' }, refusals: [], status: 'emitted' },
    ]);
    expect(report.directFindings).toMatchObject([
      {
        code: 'source-portability',
        module: { source: 'packages/app/src/glTestHelpers.ts' },
        rule: 'unchecked-double-assertion',
        stage: 'source',
      },
    ]);
    expect(report.totals).toMatchObject({
      directFindings: 1,
      directOccurrences: 1,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
    });
    expect(JSON.stringify(report)).not.toContain('gl.test.ts');
    expect(JSON.stringify(report)).not.toContain('glTestHelper.ts');
  });

  it('keeps initializeNode runtime-slot erasure source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createNodeRuntimeSlotWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/node'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const sourceIdentity =
      'flight-compiler-source-portability-finding/1:["@flighthq/node","packages/node/src/node.ts","opaque-value-domain","function:initializeNode/property:computed","sha256:794589e3154ffe26647ea1f207580ad7f23b97d2516ec656585965fff272bd85"]:0';
    const checkIdentity = `flight-compiler-check-finding/1:${JSON.stringify([
      '@flighthq/node',
      'packages/node/src/node.ts',
      'Node',
      'source',
      'source-portability',
      'opaque-value-domain',
      sourceIdentity,
    ])}`;

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings).toMatchObject([
      {
        identity: sourceIdentity,
        rule: 'opaque-value-domain',
        subject: 'function:initializeNode/property:computed',
      },
    ]);
    expect(sourcePortability.findings).toHaveLength(1);
    expect(sourcePortability.findings[0]?.message).toContain(
      'exact writable relation already retained by EntityConstruction<Node<Traits>>',
    );
    expect(sourcePortability.findings[0]?.message).toContain(
      'finishEntity returns the same owner without copying or replacing its runtime',
    );
    expect(sourcePortability.findings[0]?.message).toContain('neighboring unchecked default-factory assertion');
    expect(sourcePortability.findings[0]?.message).toContain("createNodeRuntime's base-owner assertion");
    expect(sourcePortability.findings[0]?.message).toContain('Do not whitelist the opaque view');
    expect(report.directFindings).toMatchObject([
      {
        code: 'source-portability',
        identity: checkIdentity,
        policyClass: 'source-portability',
        rule: 'opaque-value-domain',
        sourceFindingIdentity: sourceIdentity,
        sourceFindingSubject: 'function:initializeNode/property:computed',
        stage: 'source',
      },
    ]);
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 1,
      directOccurrences: 1,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });
    const introduced = compareCompilerPackageCheckBaseline(report, {
      findingIdentities: [],
      schema: 'flight-compiler-check-baseline/1',
    });
    expect(createCompilerPackageCheckPolicyResult(introduced, createCompilerPackageCheckPolicyStrict())).toMatchObject({
      failingFindingIdentities: [checkIdentity],
      passed: false,
    });

    const portableSource = createMemoryWorkspaceSource(createNodeRuntimeSlotWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/node'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources)).toMatchObject({
      acceptedExceptions: [],
      findings: [],
    });
  });

  it('keeps specialized runtime-factory findings policy-owned and baseline-stable by source identity', () => {
    const source = createMemoryWorkspaceSource(createRuntimeFactoryWorkspaceFiles());
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/node', '@flighthq/scene2d'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const options = {
      classification: {
        rules: { 'unchecked-double-assertion': 'compiler-defect' as const },
        schema: 'flight-compiler-check-classification/1' as const,
      },
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    };
    const report = createCompilerPackageCheckReport(compilation.report, options);
    const expectedSourceIdentities = [
      'flight-compiler-source-portability-finding/1:["@flighthq/node","packages/node/src/node.ts","unchecked-double-assertion","function:initializeNode","sha256:20ecf28d83c3b5f39eb276b8e51ea488f2f250c45ecec11670c6ceb2d77c15e9"]:0',
      'flight-compiler-source-portability-finding/1:["@flighthq/scene2d","packages/scene2d/src/displayObject.ts","unchecked-double-assertion","function:createNode2D","sha256:6c0582712563f9f4e004869b450578118a9dc3a585c7b4a88561ab5f01b4aba3"]:0',
    ];
    const expectedCheckIdentities = [
      ['@flighthq/node', 'packages/node/src/node.ts', 'Node', expectedSourceIdentities[0]],
      ['@flighthq/scene2d', 'packages/scene2d/src/displayObject.ts', 'DisplayObject', expectedSourceIdentities[1]],
    ].map(
      ([packageName, sourceName, moduleName, sourceIdentity]) =>
        `flight-compiler-check-finding/1:${JSON.stringify([
          packageName,
          sourceName,
          moduleName,
          'source',
          'source-portability',
          'unchecked-double-assertion',
          sourceIdentity,
        ])}`,
    );

    expect(compilation.report.modules).toHaveLength(4);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings.map(({ identity }) => identity)).toEqual(expectedSourceIdentities);
    expect(sourcePortability.findings[0]?.message).toContain('Runtime is a caller-selected subtype');
    expect(sourcePortability.findings[1]?.message).toContain(
      'base createNode2DRuntime fallback as NodeRuntimeFactory<R>',
    );
    expect(report.directFindings.map(({ identity }) => identity)).toEqual(expectedCheckIdentities);
    expect(report.directFindings.map(({ sourceFindingIdentity }) => sourceFindingIdentity)).toEqual(
      expectedSourceIdentities,
    );
    expect(
      report.directFindings.map(({ code, policyClass, rule, stage }) => ({ code, policyClass, rule, stage })),
    ).toEqual([
      {
        code: 'source-portability',
        policyClass: 'source-portability',
        rule: 'unchecked-double-assertion',
        stage: 'source',
      },
      {
        code: 'source-portability',
        policyClass: 'source-portability',
        rule: 'unchecked-double-assertion',
        stage: 'source',
      },
    ]);
    expect(report.totals).toMatchObject({ directFindings: 2, directOccurrences: 2 });
    expect(
      report.packages.map(({ directFindings, directOccurrences, findingsByPolicy, name }) => ({
        directFindings,
        directOccurrences,
        findingsByPolicy,
        name,
      })),
    ).toEqual([
      {
        directFindings: 1,
        directOccurrences: 1,
        findingsByPolicy: {
          'compiler-defect': 0,
          'compiler-restriction': 0,
          'source-portability': 1,
          'target-runtime': 0,
          unclassified: 0,
        },
        name: '@flighthq/node',
      },
      {
        directFindings: 1,
        directOccurrences: 1,
        findingsByPolicy: {
          'compiler-defect': 0,
          'compiler-restriction': 0,
          'source-portability': 1,
          'target-runtime': 0,
          unclassified: 0,
        },
        name: '@flighthq/scene2d',
      },
    ]);

    const baseline = createCompilerPackageCheckBaseline(report);
    const revisedMessages = ['revised initializeNode guidance', 'revised createNode2D guidance'];
    const revisedReport = createCompilerPackageCheckReport(compilation.report, {
      ...options,
      sourcePortability: {
        ...sourcePortability,
        findings: sourcePortability.findings.map((finding, index) => ({
          ...finding,
          message: revisedMessages[index] ?? finding.message,
        })),
      },
    });
    const comparison = compareCompilerPackageCheckBaseline(revisedReport, baseline);

    expect(baseline.findingIdentities).toEqual(expectedCheckIdentities);
    expect(comparison.introduced).toEqual([]);
    expect(comparison.resolvedFindingIdentities).toEqual([]);
    expect(comparison.unchanged.map(({ identity }) => identity)).toEqual(expectedCheckIdentities);
    expect(comparison.unchanged.map(({ occurrences }) => occurrences[0]?.message)).toEqual(revisedMessages);
    expect(createCompilerPackageCheckPolicyResult(comparison, createCompilerPackageCheckPolicyStrict())).toMatchObject({
      failingFindingIdentities: [],
      passed: true,
    });
  });

  it('keeps the bounds runtime owner and both parent-space assertions source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createNodeBoundsWorkspaceFiles());
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/node'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule(module) {
          if (module.source === 'packages/node/src/boundsRectangle.ts') {
            throw createBackendEmissionFailure(
              'acceptance',
              module,
              'the readonly entity runtime boundary does not prove the writable bounds runtime owner',
              'cpp-structural-assertion-writable-capability-unproven',
              { classification: 'source-portability' },
            );
          }
          return [{ contents: module.name, path: `${module.name}.txt` }];
        },
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const options = {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    };
    const report = createCompilerPackageCheckReport(compilation.report, options);

    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual([
      { rule: 'unchecked-double-assertion', subject: 'function:getNodeHeight' },
      { rule: 'unchecked-double-assertion', subject: 'function:getNodeWidth' },
    ]);
    expect(sourcePortability.findings.every(({ message }) => message.includes('parent-space axis-aligned box'))).toBe(
      true,
    );
    expect(sourcePortability.findings.every(({ message }) => message.includes('Do not whitelist'))).toBe(true);
    expect(compilation.report.modules.map(({ module, status }) => ({ source: module.source, status }))).toEqual([
      { source: 'packages/node/src/boundsRectangle.ts', status: 'refused' },
      { source: 'packages/node/src/index.ts', status: 'refused' },
    ]);
    expect(
      report.directFindings.map(({ policyClass, rule, sourceFindingSubject, stage }) => ({
        policyClass,
        rule,
        sourceFindingSubject,
        stage,
      })),
    ).toEqual([
      {
        policyClass: 'source-portability',
        rule: 'cpp-structural-assertion-writable-capability-unproven',
        sourceFindingSubject: undefined,
        stage: 'emission',
      },
      {
        policyClass: 'source-portability',
        rule: 'unchecked-double-assertion',
        sourceFindingSubject: 'function:getNodeHeight',
        stage: 'source',
      },
      {
        policyClass: 'source-portability',
        rule: 'unchecked-double-assertion',
        sourceFindingSubject: 'function:getNodeWidth',
        stage: 'source',
      },
    ]);
    expect(report.totals).toEqual({
      dependencyCascades: 1,
      directFindings: 3,
      directOccurrences: 3,
      modules: { dependencyRefused: 1, directlyRefused: 1, emitted: 0, total: 2 },
      packages: 1,
    });

    const baseline = createCompilerPackageCheckBaseline(report);
    const revisedReport = createCompilerPackageCheckReport(compilation.report, {
      ...options,
      sourcePortability: {
        ...sourcePortability,
        findings: sourcePortability.findings.map((finding) => ({
          ...finding,
          message: `revised ${finding.subject} guidance`,
        })),
      },
    });
    const comparison = compareCompilerPackageCheckBaseline(revisedReport, baseline);

    expect(comparison.introduced).toEqual([]);
    expect(comparison.resolvedFindingIdentities).toEqual([]);
    expect(comparison.unchanged).toHaveLength(3);
    expect(createCompilerPackageCheckPolicyResult(comparison, createCompilerPackageCheckPolicyStrict())).toMatchObject({
      failingFindingIdentities: [],
      passed: true,
    });
  });

  it('keeps the 2D transform runtime owner refusal source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createNodeTransform2dWorkspaceFiles());
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/node'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule(module) {
          if (module.source === 'packages/node/src/nodeTransform2d.ts') {
            throw createBackendEmissionFailure(
              'acceptance',
              module,
              'the readonly entity runtime boundary does not prove the writable 2D transform cache owner',
              'cpp-structural-assertion-writable-capability-unproven',
              { classification: 'source-portability' },
            );
          }
          return [{ contents: module.name, path: `${module.name}.txt` }];
        },
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });

    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings).toEqual([]);
    expect(report.directFindings).toMatchObject([
      {
        module: { source: 'packages/node/src/nodeTransform2d.ts' },
        policyClass: 'source-portability',
        rule: 'cpp-structural-assertion-writable-capability-unproven',
        stage: 'emission',
      },
    ]);
    expect(report.totals).toEqual({
      dependencyCascades: 1,
      directFindings: 1,
      directOccurrences: 1,
      modules: { dependencyRefused: 1, directlyRefused: 1, emitted: 0, total: 2 },
      packages: 1,
    });
    const comparison = compareCompilerPackageCheckBaseline(report, createCompilerPackageCheckBaseline(report));
    expect(comparison.introduced).toEqual([]);
    expect(comparison.resolvedFindingIdentities).toEqual([]);
    expect(comparison.unchanged).toHaveLength(1);
    expect(createCompilerPackageCheckPolicyResult(comparison, createCompilerPackageCheckPolicyStrict())).toMatchObject({
      failingFindingIdentities: [],
      passed: true,
    });
  });

  it('keeps the 3D detached-matrix runtime owner refusal source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createNodeTransform3dWorkspaceFiles());
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/node'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule(module) {
          if (module.source === 'packages/node/src/nodeTransform3d.ts') {
            throw createBackendEmissionFailure(
              'acceptance',
              module,
              'the readonly entity runtime boundary does not prove the writable 3D detached-matrix owner',
              'cpp-structural-assertion-writable-capability-unproven',
              { classification: 'source-portability' },
            );
          }
          return [{ contents: module.name, path: `${module.name}.txt` }];
        },
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });

    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings).toEqual([]);
    expect(report.directFindings).toMatchObject([
      {
        module: { source: 'packages/node/src/nodeTransform3d.ts' },
        policyClass: 'source-portability',
        rule: 'cpp-structural-assertion-writable-capability-unproven',
        stage: 'emission',
      },
    ]);
    expect(report.totals).toEqual({
      dependencyCascades: 1,
      directFindings: 1,
      directOccurrences: 1,
      modules: { dependencyRefused: 1, directlyRefused: 1, emitted: 0, total: 2 },
      packages: 1,
    });
    const comparison = compareCompilerPackageCheckBaseline(report, createCompilerPackageCheckBaseline(report));
    expect(comparison.introduced).toEqual([]);
    expect(comparison.resolvedFindingIdentities).toEqual([]);
    expect(comparison.unchanged).toHaveLength(1);
    expect(createCompilerPackageCheckPolicyResult(comparison, createCompilerPackageCheckPolicyStrict())).toMatchObject({
      failingFindingIdentities: [],
      passed: true,
    });
  });

  it('keeps the hierarchy writable-capability refusal source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createNodeHierarchyWorkspaceFiles());
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/node'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule(module) {
          if (module.source === 'packages/node/src/hierarchy.ts') {
            throw createBackendEmissionFailure(
              'acceptance',
              module,
              'the readonly hierarchy boundary does not prove writable parent and child authority',
              'cpp-structural-assertion-writable-capability-unproven',
              { classification: 'source-portability' },
            );
          }
          return [{ contents: module.name, path: `${module.name}.txt` }];
        },
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });

    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings).toEqual([]);
    expect(report.directFindings).toMatchObject([
      {
        identity:
          'flight-compiler-check-finding/1:["@flighthq/node","packages/node/src/hierarchy.ts","Hierarchy","emission","unsupported-ir","cpp-structural-assertion-writable-capability-unproven"]',
        module: { source: 'packages/node/src/hierarchy.ts' },
        policyClass: 'source-portability',
        rule: 'cpp-structural-assertion-writable-capability-unproven',
        stage: 'emission',
      },
    ]);
    expect(report.totals).toEqual({
      dependencyCascades: 1,
      directFindings: 1,
      directOccurrences: 1,
      modules: { dependencyRefused: 1, directlyRefused: 1, emitted: 0, total: 2 },
      packages: 1,
    });
    const comparison = compareCompilerPackageCheckBaseline(report, createCompilerPackageCheckBaseline(report));
    expect(comparison.introduced).toEqual([]);
    expect(comparison.resolvedFindingIdentities).toEqual([]);
    expect(comparison.unchanged).toHaveLength(1);
    expect(createCompilerPackageCheckPolicyResult(comparison, createCompilerPackageCheckPolicyStrict())).toMatchObject({
      failingFindingIdentities: [],
      passed: true,
    });
  });

  it('keeps the traversal writable-authority refusal source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createNodeTraversalWorkspaceFiles());
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/node'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule(module) {
          if (module.source === 'packages/node/src/traversal.ts') {
            throw createBackendEmissionFailure(
              'acceptance',
              module,
              'the readonly traversal root does not grant writable descendant authority',
              'cpp-structural-assertion-writable-capability-unproven',
              { classification: 'source-portability' },
            );
          }
          return [{ contents: module.name, path: `${module.name}.txt` }];
        },
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });

    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings).toEqual([]);
    expect(report.directFindings).toMatchObject([
      {
        identity:
          'flight-compiler-check-finding/1:["@flighthq/node","packages/node/src/traversal.ts","Traversal","emission","unsupported-ir","cpp-structural-assertion-writable-capability-unproven"]',
        module: { source: 'packages/node/src/traversal.ts' },
        policyClass: 'source-portability',
        rule: 'cpp-structural-assertion-writable-capability-unproven',
        stage: 'emission',
      },
    ]);
    expect(report.totals).toEqual({
      dependencyCascades: 1,
      directFindings: 1,
      directOccurrences: 1,
      modules: { dependencyRefused: 1, directlyRefused: 1, emitted: 0, total: 2 },
      packages: 1,
    });
    const comparison = compareCompilerPackageCheckBaseline(report, createCompilerPackageCheckBaseline(report));
    expect(comparison.introduced).toEqual([]);
    expect(comparison.resolvedFindingIdentities).toEqual([]);
    expect(comparison.unchanged).toHaveLength(1);
    expect(createCompilerPackageCheckPolicyResult(comparison, createCompilerPackageCheckPolicyStrict())).toMatchObject({
      failingFindingIdentities: [],
      passed: true,
    });
  });

  it('keeps the node-order scratch owner refusal source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createNodeOrderListWorkspaceFiles());
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/node'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule(module) {
          if (module.source === 'packages/node/src/nodeOrderList.ts') {
            throw createBackendEmissionFailure(
              'acceptance',
              module,
              'the NodeAny scratch does not retain the trait-specialized node-order owner',
              'cpp-structural-assertion-owner-unproven',
              { classification: 'source-portability' },
            );
          }
          return [{ contents: module.name, path: `${module.name}.txt` }];
        },
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });

    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings).toEqual([]);
    expect(report.directFindings).toMatchObject([
      {
        identity:
          'flight-compiler-check-finding/1:["@flighthq/node","packages/node/src/nodeOrderList.ts","NodeOrderList","emission","unsupported-ir","cpp-structural-assertion-owner-unproven"]',
        module: { source: 'packages/node/src/nodeOrderList.ts' },
        policyClass: 'source-portability',
        rule: 'cpp-structural-assertion-owner-unproven',
        stage: 'emission',
      },
    ]);
    expect(report.totals).toEqual({
      dependencyCascades: 1,
      directFindings: 1,
      directOccurrences: 1,
      modules: { dependencyRefused: 1, directlyRefused: 1, emitted: 0, total: 2 },
      packages: 1,
    });
    const comparison = compareCompilerPackageCheckBaseline(report, createCompilerPackageCheckBaseline(report));
    expect(comparison.introduced).toEqual([]);
    expect(comparison.resolvedFindingIdentities).toEqual([]);
    expect(comparison.unchanged).toHaveLength(1);
    expect(createCompilerPackageCheckPolicyResult(comparison, createCompilerPackageCheckPolicyStrict())).toMatchObject({
      failingFindingIdentities: [],
      passed: true,
    });
  });

  it('keeps the scene2d stage-fit bounds-capability refusal source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createNodeStageFitWorkspaceFiles());
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/node'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule(module) {
          if (module.source === 'packages/node/src/stageFit.ts') {
            throw createBackendEmissionFailure(
              'acceptance',
              module,
              'the readonly base node runtime does not retain the scene2d root bounds capability',
              'cpp-structural-assertion-writable-capability-unproven',
              { classification: 'source-portability' },
            );
          }
          return [{ contents: module.name, path: `${module.name}.txt` }];
        },
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });

    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings).toEqual([]);
    expect(report.directFindings).toMatchObject([
      {
        identity:
          'flight-compiler-check-finding/1:["@flighthq/node","packages/node/src/stageFit.ts","StageFit","emission","unsupported-ir","cpp-structural-assertion-writable-capability-unproven"]',
        module: { source: 'packages/node/src/stageFit.ts' },
        policyClass: 'source-portability',
        rule: 'cpp-structural-assertion-writable-capability-unproven',
        stage: 'emission',
      },
    ]);
    expect(report.totals).toEqual({
      dependencyCascades: 1,
      directFindings: 1,
      directOccurrences: 1,
      modules: { dependencyRefused: 1, directlyRefused: 1, emitted: 0, total: 2 },
      packages: 1,
    });
    const comparison = compareCompilerPackageCheckBaseline(report, createCompilerPackageCheckBaseline(report));
    expect(comparison.introduced).toEqual([]);
    expect(comparison.resolvedFindingIdentities).toEqual([]);
    expect(comparison.unchanged).toHaveLength(1);
    expect(createCompilerPackageCheckPolicyResult(comparison, createCompilerPackageCheckPolicyStrict())).toMatchObject({
      failingFindingIdentities: [],
      passed: true,
    });
  });

  it('keeps the specialized GL color-adjustment absence finding stable through check mode', () => {
    const source = createMemoryWorkspaceSource(createColorAdjustmentWorkspaceFiles());
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const options = {
      classification: {
        rules: { 'mixed-absence': 'compiler-defect' as const },
        schema: 'flight-compiler-check-classification/1' as const,
      },
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    };
    const report = createCompilerPackageCheckReport(compilation.report, options);
    const expectedSourceIdentity =
      'flight-compiler-source-portability-finding/1:["@flighthq/types","packages/types/src/GlRenderStateOptions.ts","mixed-absence","interface:GlRenderStateOptions/property:colorAdjustmentFeature","sha256:3c9d4fdec43c82aae0973667da88dcdc8f10291078992d37f226cce06fc6fee4"]:0';
    const expectedCheckIdentity = `flight-compiler-check-finding/1:${JSON.stringify([
      '@flighthq/types',
      'packages/types/src/GlRenderStateOptions.ts',
      'GlRenderStateOptions',
      'source',
      'source-portability',
      'mixed-absence',
      expectedSourceIdentity,
    ])}`;

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings).toHaveLength(1);
    expect(sourcePortability.findings[0]).toMatchObject({
      identity: expectedSourceIdentity,
      rule: 'mixed-absence',
      subject: 'interface:GlRenderStateOptions/property:colorAdjustmentFeature',
    });
    expect(sourcePortability.findings[0]?.message).toContain(
      'GL color-adjustment material feature construction option both omission and explicit null',
    );
    expect(sourcePortability.findings[0]?.message).toContain(
      'the represented opt-in feature contract has one disabled state',
    );
    expect(report.directFindings).toMatchObject([
      {
        code: 'source-portability',
        identity: expectedCheckIdentity,
        policyClass: 'source-portability',
        rule: 'mixed-absence',
        sourceFindingIdentity: expectedSourceIdentity,
        sourceFindingSubject: 'interface:GlRenderStateOptions/property:colorAdjustmentFeature',
        stage: 'source',
      },
    ]);
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 1,
      directOccurrences: 1,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });
    expect(report.packages).toEqual([
      {
        dependencyCascades: 0,
        directFindings: 1,
        directOccurrences: 1,
        findingsByPolicy: {
          'compiler-defect': 0,
          'compiler-restriction': 0,
          'source-portability': 1,
          'target-runtime': 0,
          unclassified: 0,
        },
        modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
        name: '@flighthq/types',
      },
    ]);

    const baseline = createCompilerPackageCheckBaseline(report);
    const revisedMessage = 'revised GL color-adjustment feature guidance';
    const revisedReport = createCompilerPackageCheckReport(compilation.report, {
      ...options,
      sourcePortability: {
        ...sourcePortability,
        findings: sourcePortability.findings.map((finding) => ({ ...finding, message: revisedMessage })),
      },
    });
    const comparison = compareCompilerPackageCheckBaseline(revisedReport, baseline);

    expect(baseline.findingIdentities).toEqual([expectedCheckIdentity]);
    expect(comparison.introduced).toEqual([]);
    expect(comparison.resolvedFindingIdentities).toEqual([]);
    expect(comparison.unchanged).toMatchObject([
      {
        identity: expectedCheckIdentity,
        occurrences: [{ message: revisedMessage }],
        policyClass: 'source-portability',
        sourceFindingIdentity: expectedSourceIdentity,
        sourceFindingSubject: 'interface:GlRenderStateOptions/property:colorAdjustmentFeature',
      },
    ]);
    expect(createCompilerPackageCheckPolicyResult(comparison, createCompilerPackageCheckPolicyStrict())).toMatchObject({
      failingFindingIdentities: [],
      passed: true,
    });
  });

  it('keeps all fourteen GlMeshProgram absence findings source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createGlMeshProgramWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const lazyFields = [
      'locAlphaIsCoverage',
      'locColorBias',
      'locColorMatrix0',
      'locColorMatrix1',
      'locColorMatrix2',
      'locColorMatrix3',
      'locColorMatrixOffset',
      'locColorScale',
      'locInstanceColorPalette',
      'locInstancePalette',
      'locObjectAlpha',
      'locUvTransform',
    ];
    const requiredNullableFields = ['locJointNormalTexture', 'locJointTexture'];
    const expectedSubjects = [...lazyFields, ...requiredNullableFields]
      .sort()
      .map((field) => `interface:GlMeshProgram/property:${field}`);

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      expectedSubjects.map((subject) => ({ rule: 'mixed-absence', subject })),
    );
    for (const finding of sourcePortability.findings) {
      const field = finding.subject.slice(finding.subject.lastIndexOf(':') + 1);
      expect(finding.message).toContain('Do not whitelist');
      expect(finding.message).not.toContain('reviewed source-portability exception');
      if (requiredNullableFields.includes(field)) {
        expect(finding.message).toContain('construction-time skin-sampler location');
        expect(finding.message).toContain(
          'Make locJointTexture and locJointNormalTexture required WebGLUniformLocation | null fields',
        );
        expect(finding.message).toContain('does not make the duplicate unusable sentinel a source contract');
      } else {
        expect(lazyFields).toContain(field);
        expect(finding.message).toContain('three observed states');
        expect(finding.message).toContain('Preserve that query-once contract');
        expect(finding.message).toContain('require the named cache arms above');
        expect(finding.message).toContain("representation support does not replace the source's named cache state");
      }
    }
    expect(
      report.directFindings.map(({ policyClass, rule, sourceFindingSubject }) => ({
        policyClass,
        rule,
        sourceFindingSubject,
      })),
    ).toEqual(
      expectedSubjects.map((sourceFindingSubject) => ({
        policyClass: 'source-portability',
        rule: 'mixed-absence',
        sourceFindingSubject,
      })),
    );
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 14,
      directOccurrences: 14,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });
    const introduced = compareCompilerPackageCheckBaseline(report, {
      findingIdentities: [],
      schema: 'flight-compiler-check-baseline/1',
    });
    expect(createCompilerPackageCheckPolicyResult(introduced, createCompilerPackageCheckPolicyStrict())).toMatchObject({
      failingFindingIdentities: report.directFindings.map(({ identity }) => identity),
      passed: false,
    });

    const portableSource = createMemoryWorkspaceSource(createGlMeshProgramWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources).findings).toEqual([]);
  });

  it('keeps all five GlRenderState runtime absence findings source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createGlRenderStateWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const expectedFields = [
      'currentRenderTarget',
      'currentScissorRect',
      'flushPendingDraws',
      'glRenderTextureGuard',
      'quadBatchWriterUniformColorScaleBias',
    ];
    const expectedSubjects = expectedFields.map((field) => `interface:GlRenderStateRuntime/property:${field}`);

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      expectedSubjects.map((subject) => ({ rule: 'mixed-absence', subject })),
    );
    const messages = new Map(
      sourcePortability.findings.map(({ message, subject }) => [subject.slice(subject.lastIndexOf(':') + 1), message]),
    );
    expect(messages.get('currentRenderTarget')).toContain('active GL render-pass tracking slot');
    expect(messages.get('currentScissorRect')).toContain('active GL render-pass tracking slot');
    expect(messages.get('flushPendingDraws')).toContain('lazily installed GL pending-draw seam');
    expect(messages.get('glRenderTextureGuard')).toContain('opt-in GL render-texture diagnostic guard');
    expect(messages.get('quadBatchWriterUniformColorScaleBias')).toContain(
      "GL quad batch's uniform color-adjustment scratch slot",
    );
    expect(sourcePortability.findings.every(({ message }) => message.includes('Do not whitelist'))).toBe(true);
    expect(
      sourcePortability.findings.every(({ message }) => !message.includes('reviewed source-portability exception')),
    ).toBe(true);
    expect(
      report.directFindings.map(({ policyClass, rule, sourceFindingSubject }) => ({
        policyClass,
        rule,
        sourceFindingSubject,
      })),
    ).toEqual(
      expectedSubjects.map((sourceFindingSubject) => ({
        policyClass: 'source-portability',
        rule: 'mixed-absence',
        sourceFindingSubject,
      })),
    );
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 5,
      directOccurrences: 5,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });
    const introduced = compareCompilerPackageCheckBaseline(report, {
      findingIdentities: [],
      schema: 'flight-compiler-check-baseline/1',
    });
    expect(createCompilerPackageCheckPolicyResult(introduced, createCompilerPackageCheckPolicyStrict())).toMatchObject({
      failingFindingIdentities: report.directFindings.map(({ identity }) => identity),
      passed: false,
    });

    const portableSource = createMemoryWorkspaceSource(createGlRenderStateWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources).findings).toEqual([]);
  });

  it('keeps both GlContextRuntime absence findings source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createGlContextRuntimeWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const expectedSubjects = ['anisotropyExt', 'sceneMeshUploadCache'].map(
      (field) => `interface:GlContextRuntime/property:${field}`,
    );

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      expectedSubjects.map((subject) => ({ rule: 'mixed-absence', subject })),
    );
    expect(sourcePortability.findings[0]?.message).toContain('one required GlAnisotropyCapability closed state');
    expect(sourcePortability.findings[1]?.message).toContain('required WeakMap<object, object> | null field');
    expect(sourcePortability.findings.every(({ message }) => message.includes('Do not whitelist'))).toBe(true);
    expect(
      report.directFindings.map(({ policyClass, rule, sourceFindingSubject }) => ({
        policyClass,
        rule,
        sourceFindingSubject,
      })),
    ).toEqual(
      expectedSubjects.map((sourceFindingSubject) => ({
        policyClass: 'source-portability',
        rule: 'mixed-absence',
        sourceFindingSubject,
      })),
    );
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 2,
      directOccurrences: 2,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });

    const portableSource = createMemoryWorkspaceSource(createGlContextRuntimeWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources)).toMatchObject({
      acceptedExceptions: [],
      findings: [],
    });
  });

  it('keeps the WgpuDeviceRuntime mesh-cache finding source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createWgpuDeviceRuntimeWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const subject = 'interface:WgpuDeviceRuntime/property:sceneMeshUploadCache';

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings).toHaveLength(1);
    expect(sourcePortability.findings[0]).toMatchObject({ rule: 'mixed-absence', subject });
    expect(sourcePortability.findings[0]?.message).toContain(
      'createMinimalDeviceRuntime is the sole WgpuDeviceRuntime constructor',
    );
    expect(sourcePortability.findings[0]?.message).toContain('required WeakMap<object, object> | null field');
    expect(sourcePortability.findings[0]?.message).toContain('Do not whitelist the redundant live-storage spelling');
    expect(report.directFindings).toMatchObject([
      {
        policyClass: 'source-portability',
        rule: 'mixed-absence',
        sourceFindingSubject: subject,
      },
    ]);
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 1,
      directOccurrences: 1,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });

    const portableSource = createMemoryWorkspaceSource(createWgpuDeviceRuntimeWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources)).toMatchObject({
      acceptedExceptions: [],
      findings: [],
    });
  });

  it('keeps the Scene3DDocument mesh morph finding source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createScene3DDocumentMeshWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const subject = 'interface:Scene3DDocumentMesh/property:morph';

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings).toHaveLength(1);
    expect(sourcePortability.findings[0]).toMatchObject({ rule: 'mixed-absence', subject });
    expect(sourcePortability.findings[0]?.message).toContain(
      'glTF, COLLADA, and MD2 producers attach morph only after building a non-null MeshMorph',
    );
    expect(sourcePortability.findings[0]?.message).toContain(
      'Make Scene3DDocumentMesh.morph an optional non-null MeshMorph field',
    );
    expect(sourcePortability.findings[0]?.message).toContain('Do not whitelist the redundant document spelling');
    expect(report.directFindings).toMatchObject([
      {
        policyClass: 'source-portability',
        rule: 'mixed-absence',
        sourceFindingSubject: subject,
      },
    ]);
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 1,
      directOccurrences: 1,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });

    const portableSource = createMemoryWorkspaceSource(createScene3DDocumentMeshWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources)).toMatchObject({
      acceptedExceptions: [],
      findings: [],
    });
  });

  it('keeps the Skeleton3D names finding source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createSkeleton3DNamesWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const subject = 'interface:Skeleton3D/property:names';

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings).toHaveLength(1);
    expect(sourcePortability.findings[0]).toMatchObject({ rule: 'mixed-absence', subject });
    expect(sourcePortability.findings[0]?.message).toContain('applyDocumentSkins is the only other production builder');
    expect(sourcePortability.findings[0]?.message).toContain(
      'Make Skeleton3D.names a required readonly string[] | null field',
    );
    expect(sourcePortability.findings[0]?.message).toContain('Do not whitelist the redundant live-storage spelling');
    expect(report.directFindings).toMatchObject([
      {
        policyClass: 'source-portability',
        rule: 'mixed-absence',
        sourceFindingSubject: subject,
      },
    ]);
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 1,
      directOccurrences: 1,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });

    const portableSource = createMemoryWorkspaceSource(createSkeleton3DNamesWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources)).toMatchObject({
      acceptedExceptions: [],
      findings: [],
    });
  });

  it('keeps the Skeleton2D import draw-order finding source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createSkeleton2DImportDrawOrderWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const subject = 'interface:Skeleton2DImportAnimation/property:drawOrder';

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings).toHaveLength(1);
    expect(sourcePortability.findings[0]).toMatchObject({ rule: 'mixed-absence', subject });
    expect(sourcePortability.findings[0]?.message).toContain(
      'Spine JSON and binary animation importers now always assign drawOrder',
    );
    expect(sourcePortability.findings[0]?.message).toContain('DragonBones recognizes zOrder as unsupported');
    expect(sourcePortability.findings[0]?.message).toContain('createSkeleton2DDrawOrderChannel');
    expect(sourcePortability.findings[0]?.message).toContain('retains the exact times and orderings arrays');
    expect(sourcePortability.findings[0]?.message).toContain(
      'Make Skeleton2DImportAnimation.drawOrder a required Skeleton2DDrawOrderTimeline | null field',
    );
    expect(sourcePortability.findings[0]?.message).toContain('empty timeline as a third no-draw-order sentinel');
    expect(sourcePortability.findings[0]?.message).toContain('Do not whitelist the redundant import-result spelling');
    expect(report.directFindings).toMatchObject([
      {
        policyClass: 'source-portability',
        rule: 'mixed-absence',
        sourceFindingSubject: subject,
      },
    ]);
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 1,
      directOccurrences: 1,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });
    const introduced = compareCompilerPackageCheckBaseline(report, {
      findingIdentities: [],
      schema: 'flight-compiler-check-baseline/1',
    });
    expect(createCompilerPackageCheckPolicyResult(introduced, createCompilerPackageCheckPolicyStrict())).toMatchObject({
      failingFindingIdentities: [report.directFindings[0]?.identity],
      passed: false,
    });

    const portableSource = createMemoryWorkspaceSource(createSkeleton2DImportDrawOrderWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources)).toMatchObject({
      acceptedExceptions: [],
      findings: [],
    });
  });

  it('keeps both Skeleton2D live-collection findings source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createSkeleton2DWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const expectedSubjects = ['skins', 'slots'].map((name) => `interface:Skeleton2D/property:${name}`);

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      expectedSubjects.map((subject) => ({ rule: 'mixed-absence', subject })),
    );
    expect(sourcePortability.findings.map(({ message }) => message)).toMatchObject([
      expect.stringContaining('disposeSkeleton2D clears bones and slots but leaves skins retained'),
      expect.stringContaining('No built-in renderer enumerates Skeleton2D.slots'),
    ]);
    expect(
      sourcePortability.findings.every(({ message }) =>
        message.includes('Do not whitelist the redundant live-storage spelling'),
      ),
    ).toBe(true);
    expect(
      report.directFindings.map(({ policyClass, rule, sourceFindingSubject }) => ({
        policyClass,
        rule,
        sourceFindingSubject,
      })),
    ).toEqual(
      expectedSubjects.map((sourceFindingSubject) => ({
        policyClass: 'source-portability',
        rule: 'mixed-absence',
        sourceFindingSubject,
      })),
    );
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 2,
      directOccurrences: 2,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });
    const introduced = compareCompilerPackageCheckBaseline(report, {
      findingIdentities: [],
      schema: 'flight-compiler-check-baseline/1',
    });
    expect(createCompilerPackageCheckPolicyResult(introduced, createCompilerPackageCheckPolicyStrict())).toMatchObject({
      failingFindingIdentities: report.directFindings.map(({ identity }) => identity),
      passed: false,
    });

    const portableSource = createMemoryWorkspaceSource(createSkeleton2DWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources)).toMatchObject({
      acceptedExceptions: [],
      findings: [],
    });
  });

  it('keeps the MorphShape gradient endpoint matrix finding source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createMorphShapeGradientEndpointWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const subject = 'interface:MorphShapeGradientEndpoint/property:matrix';

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings).toHaveLength(1);
    expect(sourcePortability.findings[0]).toMatchObject({ rule: 'mixed-absence', subject });
    expect(sourcePortability.findings[0]?.message).toContain(
      'readSwfMorphFillStyle is the only production endpoint builder',
    );
    expect(sourcePortability.findings[0]?.message).toContain(
      'Declare MorphShapeGradientEndpoint.matrix as optional Readonly<Matrix> without null',
    );
    expect(sourcePortability.findings[0]?.message).toContain(
      "binding's startMatrix and endMatrix fields required Readonly<Matrix> | null",
    );
    expect(sourcePortability.findings[0]?.message).toContain('Do not whitelist the redundant authoring spelling');
    expect(report.directFindings).toMatchObject([
      {
        policyClass: 'source-portability',
        rule: 'mixed-absence',
        sourceFindingSubject: subject,
      },
    ]);
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 1,
      directOccurrences: 1,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });

    const portableSource = createMemoryWorkspaceSource(createMorphShapeGradientEndpointWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources)).toMatchObject({
      acceptedExceptions: [],
      findings: [],
    });
  });

  it('keeps the six anchor-layout absence findings source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createAnchorLayoutWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const expectedSubjects = ['bottom', 'height', 'left', 'right', 'top', 'width'].map(
      (name) => `interface:AnchorLayoutItemStyle/property:${name}`,
    );

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      expectedSubjects.map((subject) => ({ rule: 'mixed-absence', subject })),
    );
    expect(
      sourcePortability.findings.every(({ message }) =>
        message.includes('FlightDocument read, write, and clone paths may preserve an explicit null'),
      ),
    ).toBe(true);
    expect(
      sourcePortability.findings.every(({ message }) => message.includes('will not whitelist a redundant spelling')),
    ).toBe(true);
    expect(
      report.directFindings.map(({ policyClass, rule, sourceFindingSubject }) => ({
        policyClass,
        rule,
        sourceFindingSubject,
      })),
    ).toEqual(
      expectedSubjects.map((sourceFindingSubject) => ({
        policyClass: 'source-portability',
        rule: 'mixed-absence',
        sourceFindingSubject,
      })),
    );
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 6,
      directOccurrences: 6,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });

    const portableSource = createMemoryWorkspaceSource(createAnchorLayoutWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources).findings).toEqual([]);
  });

  it('keeps all six Scene3D render-proxy absence findings source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createScene3DRenderProxyWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const expectedSubjects = [
      'colorMatrix',
      'colorScaleBias',
      'instanceColors',
      'instanceMatrices',
      'jointMatrices',
      'normalMatrices',
    ].map((name) => `interface:Scene3DRenderProxy/property:${name}`);

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      expectedSubjects.map((subject) => ({ rule: 'mixed-absence', subject })),
    );
    expect(
      sourcePortability.findings.every(({ message }) =>
        message.includes('Production owns three module-local scratch records and never clones them'),
      ),
    ).toBe(true);
    expect(
      sourcePortability.findings.every(({ message }) =>
        message.includes('The WebGPU shadow producer assigns jointMatrices to a palette or null for every caster'),
      ),
    ).toBe(true);
    expect(
      sourcePortability.findings.every(({ message }) =>
        message.includes('Do not whitelist the redundant live-storage spelling'),
      ),
    ).toBe(true);
    expect(
      report.directFindings.map(({ policyClass, rule, sourceFindingSubject }) => ({
        policyClass,
        rule,
        sourceFindingSubject,
      })),
    ).toEqual(
      expectedSubjects.map((sourceFindingSubject) => ({
        policyClass: 'source-portability',
        rule: 'mixed-absence',
        sourceFindingSubject,
      })),
    );
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 6,
      directOccurrences: 6,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });

    const portableSource = createMemoryWorkspaceSource(createScene3DRenderProxyWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources)).toMatchObject({
      acceptedExceptions: [],
      findings: [],
    });
  });

  it('keeps the three Mesh deformation absence findings source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createMeshDeformationWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const expectedSubjects = [
      'interface:Mesh/property:morph',
      'interface:Mesh/property:skin',
      'interface:MeshDeformRuntime/property:deformedLocalBounds',
    ];

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      expectedSubjects.map((subject) => ({ rule: 'mixed-absence', subject })),
    );
    expect(sourcePortability.findings.map(({ message }) => message)).toMatchObject([
      expect.stringContaining("preserving the clone's target sharing, weight copy, and detached geometry"),
      expect.stringContaining('the WebGPU skin adapter returns false for skin == null'),
      expect.stringContaining('cloneMesh constructs a fresh node runtime without copying'),
    ]);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(
      sourcePortability.findings.every(({ message }) =>
        message.includes('Do not whitelist the redundant live-storage spelling'),
      ),
    ).toBe(true);
    expect(
      report.directFindings.map(({ policyClass, rule, sourceFindingSubject }) => ({
        policyClass,
        rule,
        sourceFindingSubject,
      })),
    ).toEqual(
      expectedSubjects.map((sourceFindingSubject) => ({
        policyClass: 'source-portability',
        rule: 'mixed-absence',
        sourceFindingSubject,
      })),
    );
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 3,
      directOccurrences: 3,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });

    const portableSource = createMemoryWorkspaceSource(createMeshDeformationWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources).findings).toEqual([]);
  });

  it('keeps the three Slot2D absence findings source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createSlot2DWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const expectedSubjects = ['attachment', 'deform', 'name'].map((name) => `interface:Slot2D/property:${name}`);

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      expectedSubjects.map((subject) => ({ rule: 'mixed-absence', subject })),
    );
    expect(sourcePortability.findings.map(({ message }) => message)).toMatchObject([
      expect.stringContaining('Make Slot2D.attachment a required Attachment2D | null field'),
      expect.stringContaining('Make Slot2D.deform a required Skeleton2DSlotDeform | null field'),
      expect.stringContaining('Make Slot2D.name a required string | null field'),
    ]);
    expect(sourcePortability.findings.every(({ message }) => message.includes('will not whitelist'))).toBe(true);
    expect(
      report.directFindings.map(({ policyClass, rule, sourceFindingSubject }) => ({
        policyClass,
        rule,
        sourceFindingSubject,
      })),
    ).toEqual(
      expectedSubjects.map((sourceFindingSubject) => ({
        policyClass: 'source-portability',
        rule: 'mixed-absence',
        sourceFindingSubject,
      })),
    );
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 3,
      directOccurrences: 3,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });

    const portableSource = createMemoryWorkspaceSource(createSlot2DWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources).findings).toEqual([]);
  });

  it('keeps the slot-animation attachment-table absence finding source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createSkeleton2DSlotAnimationTargetWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const subject = 'interface:Skeleton2DSlotAnimationTarget/property:attachments';

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(
      sourcePortability.findings.map(({ rule, subject: findingSubject }) => ({
        rule,
        subject: findingSubject,
      })),
    ).toEqual([{ rule: 'mixed-absence', subject }]);
    expect(sourcePortability.findings[0]?.message).toContain(
      'Make Skeleton2DSlotAnimationTarget.attachments a required readonly (Attachment2D | null)[] | null field',
    );
    expect(sourcePortability.findings[0]?.message).toContain('present empty table and every positional null entry');
    expect(sourcePortability.findings[0]?.message).toContain('Do not whitelist');
    expect(sourcePortability.findings[0]?.message).not.toContain('reviewed source-portability exception');
    expect(report.directFindings).toMatchObject([
      {
        policyClass: 'source-portability',
        rule: 'mixed-absence',
        sourceFindingSubject: subject,
      },
    ]);
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 1,
      directOccurrences: 1,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });
    const introduced = compareCompilerPackageCheckBaseline(report, {
      findingIdentities: [],
      schema: 'flight-compiler-check-baseline/1',
    });
    expect(createCompilerPackageCheckPolicyResult(introduced, createCompilerPackageCheckPolicyStrict())).toMatchObject({
      failingFindingIdentities: [report.directFindings[0]?.identity],
      passed: false,
    });

    const portableSource = createMemoryWorkspaceSource(createSkeleton2DSlotAnimationTargetWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources)).toMatchObject({
      acceptedExceptions: [],
      findings: [],
    });
  });

  it('keeps the three mesh attribute input absence findings source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createMeshGeometryFromAttributesWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const expectedSubjects = ['indices', 'normals', 'uvs'].map(
      (field) => `interface:MeshGeometryFromAttributesOptions/property:${field}`,
    );

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      expectedSubjects.map((subject) => ({ rule: 'mixed-absence', subject })),
    );
    expect(
      sourcePortability.findings.every(({ message }) =>
        message.includes('createMeshGeometryFromAttributes has one not-supplied state'),
      ),
    ).toBe(true);
    expect(
      sourcePortability.findings.every(({ message }) =>
        message.includes('Do not whitelist the redundant construction spelling'),
      ),
    ).toBe(true);
    expect(
      report.directFindings.map(({ policyClass, rule, sourceFindingSubject }) => ({
        policyClass,
        rule,
        sourceFindingSubject,
      })),
    ).toEqual(
      expectedSubjects.map((sourceFindingSubject) => ({
        policyClass: 'source-portability',
        rule: 'mixed-absence',
        sourceFindingSubject,
      })),
    );
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 3,
      directOccurrences: 3,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });

    const portableSource = createMemoryWorkspaceSource(createMeshGeometryFromAttributesWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources).findings).toEqual([]);
  });

  it('keeps the MeshGeometryOptions index absence finding source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createMeshGeometryOptionsWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const expectedSubject = 'interface:MeshGeometryOptions/property:indices';

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual([
      { rule: 'mixed-absence', subject: expectedSubject },
    ]);
    expect(sourcePortability.findings[0]?.message).toContain('tests options.indices by truthiness');
    expect(sourcePortability.findings[0]?.message).toContain(
      'Make MeshGeometryOptions.indices optional Readonly<Uint16Array<ArrayBuffer>> | Readonly<Uint32Array<ArrayBuffer>> without null',
    );
    expect(sourcePortability.findings[0]?.message).toContain('keeping MeshGeometry.indices required nullable');
    expect(sourcePortability.findings[0]?.message).toContain('Do not whitelist the redundant construction spelling');
    expect(
      report.directFindings.map(({ policyClass, rule, sourceFindingSubject }) => ({
        policyClass,
        rule,
        sourceFindingSubject,
      })),
    ).toEqual([
      {
        policyClass: 'source-portability',
        rule: 'mixed-absence',
        sourceFindingSubject: expectedSubject,
      },
    ]);
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 1,
      directOccurrences: 1,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });

    const portableSource = createMemoryWorkspaceSource(createMeshGeometryOptionsWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources).findings).toEqual([]);
  });

  it('keeps the three notification open-domain findings source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createNotificationWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const expectedSubjects = [
      'interface:NotificationRequest/property:data',
      'interface:WebNotificationOptions/property:data',
      'interface:WebServiceWorkerNotificationInstance/property:data',
    ];

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      expectedSubjects.map((subject) => ({ rule: 'opaque-value-domain', subject })),
    );
    expect(sourcePortability.findings.map(({ message }) => message)).toMatchObject([
      expect.stringContaining('Electron, Tauri, and Capacitor instead enumerate the request'),
      expect.stringContaining('same recursive closed NotificationData scalar'),
      expect.stringContaining('Remove data from WebServiceWorkerNotificationInstance'),
    ]);
    expect(sourcePortability.findings.every(({ message }) => message.includes('Do not whitelist'))).toBe(true);
    expect(
      sourcePortability.findings.every(({ message }) => !message.includes('reviewed source-portability exception')),
    ).toBe(true);
    expect(
      report.directFindings.map(({ policyClass, rule, sourceFindingSubject }) => ({
        policyClass,
        rule,
        sourceFindingSubject,
      })),
    ).toEqual(
      expectedSubjects.map((sourceFindingSubject) => ({
        policyClass: 'source-portability',
        rule: 'opaque-value-domain',
        sourceFindingSubject,
      })),
    );
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 3,
      directOccurrences: 3,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });

    const portableSource = createMemoryWorkspaceSource(createNotificationWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources).findings).toEqual([]);
  });

  it('keeps the dialog close-value domain finding source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createGuiDialogCloseResultWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const expectedSubject = 'interface:GuiDialogCloseResult/property:value';

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual([
      { rule: 'opaque-value-domain', subject: expectedSubject },
    ]);
    expect(sourcePortability.findings[0]?.message).toContain(
      'built-in backdrop producer closes the active entry as dismissed with no value',
    );
    expect(sourcePortability.findings[0]?.message).toContain(
      'synchronously emits the exact result object through onClose',
    );
    expect(sourcePortability.findings[0]?.message).toContain('reason-discriminated arms');
    expect(sourcePortability.findings[0]?.message).toContain('recursive closed GuiDialogCloseValue');
    expect(sourcePortability.findings[0]?.message).toContain('cancelled and dismissed arm must have no value property');
    expect(sourcePortability.findings[0]?.message).toContain('stable string handle');
    expect(sourcePortability.findings[0]?.message).toContain('Do not whitelist');
    expect(sourcePortability.findings[0]?.message).not.toContain('reviewed source-portability exception');
    expect(
      report.directFindings.map(({ policyClass, rule, sourceFindingSubject }) => ({
        policyClass,
        rule,
        sourceFindingSubject,
      })),
    ).toEqual([
      {
        policyClass: 'source-portability',
        rule: 'opaque-value-domain',
        sourceFindingSubject: expectedSubject,
      },
    ]);
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 1,
      directOccurrences: 1,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });
    const introduced = compareCompilerPackageCheckBaseline(report, {
      findingIdentities: [],
      schema: 'flight-compiler-check-baseline/1',
    });
    expect(createCompilerPackageCheckPolicyResult(introduced, createCompilerPackageCheckPolicyStrict())).toMatchObject({
      failingFindingIdentities: [report.directFindings[0]?.identity],
      passed: false,
    });

    const portableSource = createMemoryWorkspaceSource(createGuiDialogCloseResultWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources)).toMatchObject({
      acceptedExceptions: [],
      findings: [],
    });
  });

  it('keeps the Net response-body open-domain finding source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createNetResponseBodyWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const subject = 'type:NetResponseBody';

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings).toHaveLength(1);
    expect(sourcePortability.findings[0]).toMatchObject({ rule: 'opaque-value-domain', subject });
    expect(sourcePortability.findings[0]?.message).toContain('createWebNetBackend is the only production NetBackend');
    expect(sourcePortability.findings[0]?.message).toContain('recursive closed NetJsonValue and NetJsonObject');
    expect(sourcePortability.findings[0]?.message).toContain('successful JSON null currently shares');
    expect(sourcePortability.findings[0]?.message).toContain('Do not whitelist the public transport domain');
    expect(report.directFindings).toMatchObject([
      {
        policyClass: 'source-portability',
        rule: 'opaque-value-domain',
        sourceFindingSubject: subject,
      },
    ]);
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 1,
      directOccurrences: 1,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });

    const portableSource = createMemoryWorkspaceSource(createNetResponseBodyWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources)).toMatchObject({
      acceptedExceptions: [],
      findings: [],
    });
  });

  it('keeps the unresolved Tray creation error domains source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createTrayCreateResultWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const expectedSubjects = [
      'type:TrayCreateProviderResult/arm:outcome=invalid-icon/property:error',
      'type:TrayCreateProviderResult/arm:outcome=runtime-api-unavailable/property:error',
      'type:TrayCreateProviderResult/arm:outcome=tray-create-failed/property:error',
    ];

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      expectedSubjects.map((subject) => ({ rule: 'opaque-value-domain', subject })),
    );
    expect(sourcePortability.findings.every(({ message }) => message.includes('representation is not the gap'))).toBe(
      true,
    );
    expect(
      sourcePortability.findings.every(({ message }) =>
        message.includes('unguarded member access across a Tray result union is a separate source-narrowing issue'),
      ),
    ).toBe(true);
    expect(sourcePortability.findings.every(({ message }) => message.includes('Do not whitelist'))).toBe(true);
    expect(
      report.directFindings.map(({ policyClass, rule, sourceFindingSubject }) => ({
        policyClass,
        rule,
        sourceFindingSubject,
      })),
    ).toEqual(
      expectedSubjects.map((sourceFindingSubject) => ({
        policyClass: 'source-portability',
        rule: 'opaque-value-domain',
        sourceFindingSubject,
      })),
    );
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 3,
      directOccurrences: 3,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });

    const portableSource = createMemoryWorkspaceSource(createTrayCreateResultWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources)).toMatchObject({
      acceptedExceptions: [],
      findings: [],
    });
  });

  it('keeps unused Lottie JSON fields source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createLottieDocumentWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const expectedSubjects = [
      'interface:LottieDocument/property:chars',
      'interface:LottieTextData/property:a',
      'interface:LottieTextData/property:m',
      'interface:LottieTextData/property:p',
    ];

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      expectedSubjects.map((subject) => ({ rule: 'opaque-value-domain', subject })),
    );
    expect(sourcePortability.findings[0]?.message).toContain('caller-owned shallow Readonly<LottieDocument>');
    expect(sourcePortability.findings[0]?.message).toContain('neither retained nor serialized');
    for (const [index, property] of ['a', 'm', 'p'].entries()) {
      const message = sourcePortability.findings[index + 1]?.message;
      expect(message).toContain('appendLottieText is the only production consumer of LottieTextData');
      expect(message).toContain(`never reads or diagnoses ${property}`);
      expect(message).toContain(`Remove ${property} from the portable LottieTextData projection`);
    }
    expect(sourcePortability.findings.every(({ message }) => message.includes('Do not whitelist'))).toBe(true);
    expect(sourcePortability.findings.every(({ message }) => message.includes('representation is not the gap'))).toBe(
      true,
    );
    expect(
      sourcePortability.findings.every(({ message }) => !message.includes('reviewed source-portability exception')),
    ).toBe(true);
    expect(
      report.directFindings.map(({ policyClass, rule, sourceFindingSubject }) => ({
        policyClass,
        rule,
        sourceFindingSubject,
      })),
    ).toEqual(
      expectedSubjects.map((sourceFindingSubject) => ({
        policyClass: 'source-portability',
        rule: 'opaque-value-domain',
        sourceFindingSubject,
      })),
    );
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 4,
      directOccurrences: 4,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });

    const portableSource = createMemoryWorkspaceSource(createLottieDocumentWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources)).toMatchObject({
      acceptedExceptions: [],
      findings: [],
    });
  });

  it('keeps the exact HostAppLoop numeric handle source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createHostAppLoopWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const expectedSubjects = [
      'interface:HostAppLoopCapability/method:cancelFrame.parameter:handle',
      'interface:HostAppLoopCapability/method:requestFrame.return',
    ];

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      expectedSubjects.map((subject) => ({ rule: 'opaque-value-domain', subject })),
    );
    expect(sourcePortability.findings[0]?.message).toContain('js.Browser.window.cancelAnimationFrame');
    expect(sourcePortability.findings[0]?.message).toContain('flight::host_sdl::cancel_animation_frame');
    expect(sourcePortability.findings[1]?.message).toContain('webHostLoop is the sole TypeScript production provider');
    expect(sourcePortability.findings[1]?.message).toContain('flight::host_sdl::request_animation_frame');
    expect(sourcePortability.findings.every(({ message }) => message.includes('AppLoopFrameHandle = number'))).toBe(
      true,
    );
    expect(sourcePortability.findings.every(({ message }) => message.includes('AnimationFrameHandle = double'))).toBe(
      true,
    );
    expect(sourcePortability.findings.every(({ message }) => message.includes('Do not whitelist'))).toBe(true);
    expect(
      sourcePortability.findings.every(({ message }) => !message.includes('reviewed source-portability exception')),
    ).toBe(true);
    expect(
      report.directFindings.map(({ policyClass, rule, sourceFindingSubject }) => ({
        policyClass,
        rule,
        sourceFindingSubject,
      })),
    ).toEqual(
      expectedSubjects.map((sourceFindingSubject) => ({
        policyClass: 'source-portability',
        rule: 'opaque-value-domain',
        sourceFindingSubject,
      })),
    );
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 2,
      directOccurrences: 2,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });

    const portableSource = createMemoryWorkspaceSource(createHostAppLoopWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources)).toMatchObject({
      acceptedExceptions: [],
      findings: [],
    });
  });

  it('keeps the obsolete HostVideo stream erasure source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createHostVideoStreamWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const subject = 'interface:HostVideoCapability/method:attachStream.parameter:stream';

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings).toMatchObject([{ rule: 'opaque-value-domain', subject }]);
    expect(sourcePortability.findings).toHaveLength(1);
    expect(sourcePortability.findings[0]?.message).toContain('exactly MediaStream at this web-only entry');
    expect(sourcePortability.findings[0]?.message).toContain(
      'not an open cross-host token or a request for unknown or Any representation',
    );
    expect(sourcePortability.findings[0]?.message).toContain('bind MediaStream as an exact external host type');
    expect(sourcePortability.findings[0]?.message).toContain(
      'Electron, Tauri, Capacitor, Node, and other native hosts',
    );
    expect(sourcePortability.findings[0]?.message).toContain('rather than inventing a HostVideoStreamHandle');
    expect(sourcePortability.findings[0]?.message).toContain('HostVideo.ts and attachStream are gone');
    expect(sourcePortability.findings[0]?.message).toContain('Do not whitelist');
    expect(report.directFindings).toMatchObject([
      {
        policyClass: 'source-portability',
        rule: 'opaque-value-domain',
        sourceFindingSubject: subject,
      },
    ]);
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 1,
      directOccurrences: 1,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });

    const portableSource = createMemoryWorkspaceSource(createHostVideoStreamWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources)).toMatchObject({
      acceptedExceptions: [],
      findings: [],
    });
  });

  it('keeps the native window handle finding source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createNativeWindowHandleWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const subject = 'type:NativeWindowHandle';

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings).toMatchObject([{ rule: 'opaque-value-domain', subject }]);
    expect(sourcePortability.findings).toHaveLength(1);
    expect(sourcePortability.findings[0]?.message).toContain('public existing-window adoption boundary');
    expect(sourcePortability.findings[0]?.message).toContain('external callers are the only raw-handle producers');
    expect(sourcePortability.findings[0]?.message).toContain('paired HostWindowLifecycleCapability');
    expect(sourcePortability.findings[0]?.message).toContain('ApplicationWindow.ts');
    expect(sourcePortability.findings[0]?.message).toContain('no path copies or replaces the owner');
    expect(sourcePortability.findings[0]?.message).toContain('reference-shaped target-token contract');
    expect(sourcePortability.findings[0]?.message).toContain("Entity & { readonly __brand: 'NativeWindowHandle' }");
    expect(sourcePortability.findings[0]?.message).toContain('provider-private WeakMap');
    expect(sourcePortability.findings[0]?.message).toContain('return false for an unknown or foreign token');
    expect(sourcePortability.findings[0]?.message).toContain('flight::Any');
    expect(sourcePortability.findings[0]?.message).toContain('ReferenceEnabled structs passed as flight::Ref');
    expect(sourcePortability.findings[0]?.message).toContain('Do not whitelist either exact erased alias');
    expect(sourcePortability.findings[0]?.message).not.toContain('reviewed source-portability exception');
    expect(report.directFindings).toMatchObject([
      {
        policyClass: 'source-portability',
        rule: 'opaque-value-domain',
        sourceFindingSubject: subject,
      },
    ]);
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 1,
      directOccurrences: 1,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });
    const introduced = compareCompilerPackageCheckBaseline(report, {
      findingIdentities: [],
      schema: 'flight-compiler-check-baseline/1',
    });
    expect(createCompilerPackageCheckPolicyResult(introduced, createCompilerPackageCheckPolicyStrict())).toMatchObject({
      failingFindingIdentities: [report.directFindings[0]?.identity],
      passed: false,
    });

    const portableSource = createMemoryWorkspaceSource(createNativeWindowHandleWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources)).toMatchObject({
      acceptedExceptions: [],
      findings: [],
    });
  });

  it('keeps the native surface handle finding source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createNativeSurfaceHandleWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const subject = 'type:NativeSurfaceHandle';

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings).toMatchObject([{ rule: 'opaque-value-domain', subject }]);
    expect(sourcePortability.findings).toHaveLength(1);
    expect(sourcePortability.findings[0]?.message).toContain(
      'public capability returns and surface-adoption parameters',
    );
    expect(sourcePortability.findings[0]?.message).toContain('required package-private SurfaceRuntime.handle');
    expect(sourcePortability.findings[0]?.message).toContain('fresh HTMLCanvasElement');
    expect(sourcePortability.findings[0]?.message).toContain('unknown absorbs null');
    expect(sourcePortability.findings[0]?.message).toContain('reference-shaped target-token contract');
    expect(sourcePortability.findings[0]?.message).toContain("Entity & { readonly __brand: 'NativeSurfaceHandle' }");
    expect(sourcePortability.findings[0]?.message).toContain('provider-private WeakMap');
    expect(sourcePortability.findings[0]?.message).toContain('null an unambiguous allocation-failure sentinel');
    expect(sourcePortability.findings[0]?.message).toContain('Unknown or foreign tokens resolve to null');
    expect(sourcePortability.findings[0]?.message).toContain('token-to-pointer, object, or integer table');
    expect(sourcePortability.findings[0]?.message).toContain('Do not whitelist');
    expect(sourcePortability.findings[0]?.message).not.toContain('reviewed source-portability exception');
    expect(report.directFindings).toMatchObject([
      {
        policyClass: 'source-portability',
        rule: 'opaque-value-domain',
        sourceFindingSubject: subject,
      },
    ]);
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 1,
      directOccurrences: 1,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });
    const introduced = compareCompilerPackageCheckBaseline(report, {
      findingIdentities: [],
      schema: 'flight-compiler-check-baseline/1',
    });
    expect(createCompilerPackageCheckPolicyResult(introduced, createCompilerPackageCheckPolicyStrict())).toMatchObject({
      failingFindingIdentities: [report.directFindings[0]?.identity],
      passed: false,
    });

    const portableSource = createMemoryWorkspaceSource(createNativeSurfaceHandleWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources)).toMatchObject({
      acceptedExceptions: [],
      findings: [],
    });
  });

  it('keeps the three log transport domains source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createLogWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const expectedSubjects = [
      'interface:LogContext/property:fields',
      'interface:LogSpan/property:fields',
      'type:LogData',
    ];

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      expectedSubjects.map((subject) => ({ rule: 'opaque-value-domain', subject })),
    );
    expect(sourcePortability.findings.map(({ message }) => message)).toMatchObject([
      expect.stringContaining('createLogContext and createChildLogContext'),
      expect.stringContaining('active-span stack'),
      expect.stringContaining('every sink and LogSignals receive the raw LogEntry'),
    ]);
    expect(
      sourcePortability.findings.every(({ message }) =>
        message.includes('recursive named closed LogFieldValue domain'),
      ),
    ).toBe(true);
    expect(sourcePortability.findings.every(({ message }) => message.includes('Do not whitelist'))).toBe(true);
    expect(
      sourcePortability.findings.every(({ message }) => !message.includes('reviewed source-portability exception')),
    ).toBe(true);
    expect(
      report.directFindings.map(({ policyClass, rule, sourceFindingSubject }) => ({
        policyClass,
        rule,
        sourceFindingSubject,
      })),
    ).toEqual(
      expectedSubjects.map((sourceFindingSubject) => ({
        policyClass: 'source-portability',
        rule: 'opaque-value-domain',
        sourceFindingSubject,
      })),
    );
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 3,
      directOccurrences: 3,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });
    const introduced = compareCompilerPackageCheckBaseline(report, {
      findingIdentities: [],
      schema: 'flight-compiler-check-baseline/1',
    });
    expect(createCompilerPackageCheckPolicyResult(introduced, createCompilerPackageCheckPolicyStrict())).toMatchObject({
      failingFindingIdentities: report.directFindings.map(({ identity }) => identity),
      passed: false,
    });

    const portableSource = createMemoryWorkspaceSource(createLogWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources).findings).toEqual([]);
  });

  it('keeps the animation clip-event payload finding source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createAnimationClipEventWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const subject = 'interface:AnimationClipEvent/property:payload';

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings).toMatchObject([{ rule: 'opaque-value-domain', subject }]);
    expect(sourcePortability.findings).toHaveLength(1);
    expect(sourcePortability.findings[0]?.message).toContain(
      'cloneAnimationClip allocates new markers while reusing the exact payload reference',
    );
    expect(sourcePortability.findings[0]?.message).toContain(
      'only production non-default producer is the Lottie importer',
    );
    expect(sourcePortability.findings[0]?.message).toContain('recursive named closed AnimationClipEventPayload domain');
    expect(sourcePortability.findings[0]?.message).toContain('stable string handle');
    expect(sourcePortability.findings[0]?.message).toContain('Do not whitelist');
    expect(sourcePortability.findings[0]?.message).not.toContain('reviewed source-portability exception');
    expect(report.directFindings).toMatchObject([
      {
        policyClass: 'source-portability',
        rule: 'opaque-value-domain',
        sourceFindingSubject: subject,
      },
    ]);
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 1,
      directOccurrences: 1,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });
    const introduced = compareCompilerPackageCheckBaseline(report, {
      findingIdentities: [],
      schema: 'flight-compiler-check-baseline/1',
    });
    expect(createCompilerPackageCheckPolicyResult(introduced, createCompilerPackageCheckPolicyStrict())).toMatchObject({
      failingFindingIdentities: [report.directFindings[0]?.identity],
      passed: false,
    });

    const portableSource = createMemoryWorkspaceSource(createAnimationClipEventWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources)).toMatchObject({
      acceptedExceptions: [],
      findings: [],
    });
  });

  it('keeps the three AnimationPlayer signal-absence findings source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createAnimationPlayerSignalWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const expectedSubjects = [
      'interface:AnimationPlayer/property:onEvent',
      'interface:AnimationPlayer/property:onFinished',
      'interface:AnimationPlayer/property:onLooped',
    ];

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      expectedSubjects.map((subject) => ({ rule: 'mixed-absence', subject })),
    );
    expect(
      sourcePortability.findings.every(({ message }) =>
        message.includes('Optionality belongs to construction inputs, not the live player signal state'),
      ),
    ).toBe(true);
    expect(
      sourcePortability.findings.every(({ message }) =>
        message.includes('required fields with their exact callable-bearing Signal type | null'),
      ),
    ).toBe(true);
    expect(sourcePortability.findings.every(({ message }) => message.includes('Do not whitelist'))).toBe(true);
    expect(
      sourcePortability.findings.every(({ message }) => !message.includes('reviewed source-portability exception')),
    ).toBe(true);
    expect(
      report.directFindings.map(({ policyClass, rule, sourceFindingSubject }) => ({
        policyClass,
        rule,
        sourceFindingSubject,
      })),
    ).toEqual(
      expectedSubjects.map((sourceFindingSubject) => ({
        policyClass: 'source-portability',
        rule: 'mixed-absence',
        sourceFindingSubject,
      })),
    );
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 3,
      directOccurrences: 3,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });
    const introduced = compareCompilerPackageCheckBaseline(report, {
      findingIdentities: [],
      schema: 'flight-compiler-check-baseline/1',
    });
    expect(createCompilerPackageCheckPolicyResult(introduced, createCompilerPackageCheckPolicyStrict())).toMatchObject({
      failingFindingIdentities: report.directFindings.map(({ identity }) => identity),
      passed: false,
    });

    const portableSource = createMemoryWorkspaceSource(createAnimationPlayerSignalWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources)).toMatchObject({
      acceptedExceptions: [],
      findings: [],
    });
  });

  it('keeps both open command-property slots source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createCommandPropertyWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const expectedSubjects = [
      'interface:CommandPropertyEntry/property:after',
      'interface:CommandPropertyEntry/property:before',
    ];

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      expectedSubjects.map((subject) => ({ rule: 'opaque-value-domain', subject })),
    );
    expect(sourcePortability.findings[0]?.message).toContain('capture the caller-supplied value');
    expect(sourcePortability.findings[0]?.message).toContain('initial execute and redo');
    expect(sourcePortability.findings[1]?.message).toContain('read the current node property');
    expect(sourcePortability.findings[1]?.message).toContain('on undo');
    for (const finding of sourcePortability.findings) {
      expect(finding.message).toContain('binding before any history retention');
      expect(finding.message).toContain('absent a merge it pushes the exact live command reference');
      expect(finding.message).toContain('getCommandHistoryEntries exposes those same references');
      expect(finding.message).toContain('test over numeric x or y');
      expect(finding.message).toContain('including live entity or collection values');
      expect(finding.message).toContain('no command serializer, parser, persistent history store, or command codec');
      expect(finding.message).toContain(
        'recursive JSON-shaped value union would neither make this command serializable',
      );
      expect(finding.message).toContain('Remove CommandPropertyEntry, SetNodePropertyCommand');
      expect(finding.message).toContain('command-kind-specific data interface');
      expect(finding.message).toContain('separate validated serialized form with a stable node key or path');
      expect(finding.message).toContain('Do not replace unknown with a guessed scalar or recursive value union');
      expect(finding.message).toContain('do not whitelist');
      expect(finding.message).not.toContain('reviewed source-portability exception');
    }
    expect(
      report.directFindings.map(({ policyClass, rule, sourceFindingSubject }) => ({
        policyClass,
        rule,
        sourceFindingSubject,
      })),
    ).toEqual(
      expectedSubjects.map((sourceFindingSubject) => ({
        policyClass: 'source-portability',
        rule: 'opaque-value-domain',
        sourceFindingSubject,
      })),
    );
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 2,
      directOccurrences: 2,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });
    const introduced = compareCompilerPackageCheckBaseline(report, {
      findingIdentities: [],
      schema: 'flight-compiler-check-baseline/1',
    });
    expect(createCompilerPackageCheckPolicyResult(introduced, createCompilerPackageCheckPolicyStrict())).toMatchObject({
      failingFindingIdentities: report.directFindings.map(({ identity }) => identity),
      passed: false,
    });

    const portableSource = createMemoryWorkspaceSource(createCommandPropertyWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources)).toMatchObject({
      acceptedExceptions: [],
      findings: [],
    });
  });

  it('keeps both FlightDocument node interaction absence findings source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createFlightDocumentWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const expectedSubjects = [
      'interface:FlightDocumentNode/property:interactiveStates',
      'interface:FlightDocumentNode/property:transition',
    ];

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      expectedSubjects.map((subject) => ({ rule: 'mixed-absence', subject })),
    );
    expect(
      sourcePortability.findings.every(({ message }) =>
        message.includes('Make interactiveStates and transition required nullable fields on FlightDocumentNode'),
      ),
    ).toBe(true);
    expect(sourcePortability.findings.every(({ message }) => message.includes('Do not whitelist'))).toBe(true);
    expect(
      sourcePortability.findings.every(({ message }) => !message.includes('reviewed source-portability exception')),
    ).toBe(true);
    expect(
      report.directFindings.map(({ policyClass, rule, sourceFindingSubject }) => ({
        policyClass,
        rule,
        sourceFindingSubject,
      })),
    ).toEqual(
      expectedSubjects.map((sourceFindingSubject) => ({
        policyClass: 'source-portability',
        rule: 'mixed-absence',
        sourceFindingSubject,
      })),
    );
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 2,
      directOccurrences: 2,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });

    const portableSource = createMemoryWorkspaceSource(createFlightDocumentWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources).findings).toEqual([]);
  });

  it('keeps both Scene2D resource input absence findings source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createScene2DResourceWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const expectedSubjects = [
      'interface:LoadScene2DAudioResourcesOptions/property:context',
      'interface:Scene2DDocumentLoadOptions/property:mimeType',
    ];

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      expectedSubjects.map((subject) => ({ rule: 'mixed-absence', subject })),
    );
    expect(sourcePortability.findings.map(({ message }) => message)).toMatchObject([
      expect.stringContaining('disable only the platform decode fallback'),
      expect.stringContaining('passes that context unchanged to each registry matcher and the selected importer'),
    ]);
    expect(sourcePortability.findings.every(({ message }) => message.includes('Do not whitelist'))).toBe(true);
    expect(
      sourcePortability.findings.every(({ message }) => !message.includes('reviewed source-portability exception')),
    ).toBe(true);
    expect(
      report.directFindings.map(({ policyClass, rule, sourceFindingSubject }) => ({
        policyClass,
        rule,
        sourceFindingSubject,
      })),
    ).toEqual(
      expectedSubjects.map((sourceFindingSubject) => ({
        policyClass: 'source-portability',
        rule: 'mixed-absence',
        sourceFindingSubject,
      })),
    );
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 2,
      directOccurrences: 2,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });
    const introduced = compareCompilerPackageCheckBaseline(report, {
      findingIdentities: [],
      schema: 'flight-compiler-check-baseline/1',
    });
    expect(createCompilerPackageCheckPolicyResult(introduced, createCompilerPackageCheckPolicyStrict())).toMatchObject({
      failingFindingIdentities: report.directFindings.map(({ identity }) => identity),
      passed: false,
    });

    const portableSource = createMemoryWorkspaceSource(createScene2DResourceWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources).findings).toEqual([]);
  });

  it('keeps both BitmapText construction-option findings source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createBitmapTextOptionsWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const expectedSubjects = [
      'interface:BitmapTextOptions/property:maxLines',
      'interface:BitmapTextOptions/property:wrapWidth',
    ];

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      expectedSubjects.map((subject) => ({ rule: 'mixed-absence', subject })),
    );
    expect(
      sourcePortability.findings.every(({ message }) =>
        message.includes(
          'createBitmapText allocates fresh BitmapTextData through createBitmapTextData and initializeBitmapTextData',
        ),
      ),
    ).toBe(true);
    expect(
      sourcePortability.findings.every(({ message }) =>
        message.includes(
          'setBitmapTextMaxLines and setBitmapTextWrapWidth accept number | null and assign the required nullable live cells directly',
        ),
      ),
    ).toBe(true);
    expect(
      sourcePortability.findings.every(({ message }) =>
        message.includes(
          'layoutBitmapTextLines treats null maxLines as unlimited and null wrapWidth as no word wrapping',
        ),
      ),
    ).toBe(true);
    expect(
      sourcePortability.findings.every(({ message }) =>
        message.includes(
          'Make maxLines and wrapWidth optional number fields in BitmapTextOptions, using omission as their sole construction-time absence',
        ),
      ),
    ).toBe(true);
    expect(sourcePortability.findings.every(({ message }) => message.includes('Do not whitelist'))).toBe(true);
    expect(
      sourcePortability.findings.every(({ message }) => !message.includes('reviewed source-portability exception')),
    ).toBe(true);
    expect(
      report.directFindings.map(({ policyClass, rule, sourceFindingSubject }) => ({
        policyClass,
        rule,
        sourceFindingSubject,
      })),
    ).toEqual(
      expectedSubjects.map((sourceFindingSubject) => ({
        policyClass: 'source-portability',
        rule: 'mixed-absence',
        sourceFindingSubject,
      })),
    );
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 2,
      directOccurrences: 2,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });
    const introduced = compareCompilerPackageCheckBaseline(report, {
      findingIdentities: [],
      schema: 'flight-compiler-check-baseline/1',
    });
    expect(createCompilerPackageCheckPolicyResult(introduced, createCompilerPackageCheckPolicyStrict())).toMatchObject({
      failingFindingIdentities: report.directFindings.map(({ identity }) => identity),
      passed: false,
    });

    const portableSource = createMemoryWorkspaceSource(createBitmapTextOptionsWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources).findings).toEqual([]);
  });

  it('keeps the Capacitor altitude-accuracy finding source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createCapacitorPositionCoordsWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const expectedSubject = 'interface:CapacitorPositionCoords/property:altitudeAccuracy';

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual([
      { rule: 'mixed-absence', subject: expectedSubject },
    ]);
    expect(sourcePortability.findings[0]?.message).toContain(
      'CapacitorGeolocationPlugin.getCurrentPosition and the successful CapacitorGeolocationPlugin.watchPosition callback are the only raw coordinate ingress paths',
    );
    expect(sourcePortability.findings[0]?.message).toContain(
      'toGeolocationPosition, which evaluates coords.altitudeAccuracy ?? 0',
    );
    expect(sourcePortability.findings[0]?.message).toContain(
      'Make CapacitorPositionCoords.altitudeAccuracy a required number | null field',
    );
    expect(sourcePortability.findings[0]?.message).toContain(
      'do not cast the plugin or make this required result cell optional',
    );
    expect(sourcePortability.findings[0]?.message).toContain('Do not whitelist');
    expect(sourcePortability.findings[0]?.message).not.toContain('reviewed source-portability exception');
    expect(
      report.directFindings.map(({ policyClass, rule, sourceFindingSubject }) => ({
        policyClass,
        rule,
        sourceFindingSubject,
      })),
    ).toEqual([
      {
        policyClass: 'source-portability',
        rule: 'mixed-absence',
        sourceFindingSubject: expectedSubject,
      },
    ]);
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 1,
      directOccurrences: 1,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });
    const introduced = compareCompilerPackageCheckBaseline(report, {
      findingIdentities: [],
      schema: 'flight-compiler-check-baseline/1',
    });
    expect(createCompilerPackageCheckPolicyResult(introduced, createCompilerPackageCheckPolicyStrict())).toMatchObject({
      failingFindingIdentities: [report.directFindings[0]?.identity],
      passed: false,
    });

    const portableSource = createMemoryWorkspaceSource(createCapacitorPositionCoordsWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources).findings).toEqual([]);
  });

  it('keeps the glTF base-path input finding source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createGltfImportOptionsWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const expectedSubject = 'interface:GltfImportOptions/property:basePath';

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual([
      { rule: 'mixed-absence', subject: expectedSubject },
    ]);
    expect(sourcePortability.findings[0]?.message).toContain(
      'buildGltfDocument passes them to buildGltfImageResourceReference for every image',
    );
    expect(sourcePortability.findings[0]?.message).toContain('Make GltfImportOptions.basePath an optional string');
    expect(sourcePortability.findings[0]?.message).toContain(
      'Keep ExternalImageResourceReference.basePath a required string | null cell',
    );
    expect(sourcePortability.findings[0]?.message).toContain(
      'have the URL loaders omit it when the derived path is null',
    );
    expect(sourcePortability.findings[0]?.message).toContain('Do not whitelist');
    expect(sourcePortability.findings[0]?.message).not.toContain('reviewed source-portability exception');
    expect(
      report.directFindings.map(({ policyClass, rule, sourceFindingSubject }) => ({
        policyClass,
        rule,
        sourceFindingSubject,
      })),
    ).toEqual([
      {
        policyClass: 'source-portability',
        rule: 'mixed-absence',
        sourceFindingSubject: expectedSubject,
      },
    ]);
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 1,
      directOccurrences: 1,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });
    const introduced = compareCompilerPackageCheckBaseline(report, {
      findingIdentities: [],
      schema: 'flight-compiler-check-baseline/1',
    });
    expect(createCompilerPackageCheckPolicyResult(introduced, createCompilerPackageCheckPolicyStrict())).toMatchObject({
      failingFindingIdentities: [report.directFindings[0]?.identity],
      passed: false,
    });

    const portableSource = createMemoryWorkspaceSource(createGltfImportOptionsWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources).findings).toEqual([]);
  });

  it('keeps the texture resource subscription finding source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createTextureOptionsWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const expectedSubject = 'type:CreateTextureOptions/property:resource';

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual([
      { rule: 'mixed-absence', subject: expectedSubject },
    ]);
    expect(sourcePortability.findings[0]?.message).toContain(
      'createEmbeddedTextureRef and createExternalTextureRef helpers create or reuse an exact',
    );
    expect(sourcePortability.findings[0]?.message).toContain(
      '(resource.textures ??= []).push(texture) to normalize a present owner',
    );
    expect(sourcePortability.findings[0]?.message).toContain(
      'Scene 2D loading reads reference.textures and fans one resolved source out to every subscriber',
    );
    expect(sourcePortability.findings[0]?.message).toContain(
      'Declare CreateTextureOptions.resource as optional ImageResourceReference without null',
    );
    expect(sourcePortability.findings[0]?.message).toContain(
      'requiring ImageResourceReference | null would force unrelated constructors to manufacture null',
    );
    expect(sourcePortability.findings[0]?.message).toContain('Do not whitelist');
    expect(sourcePortability.findings[0]?.message).not.toContain('reviewed source-portability exception');
    expect(
      report.directFindings.map(({ policyClass, rule, sourceFindingSubject }) => ({
        policyClass,
        rule,
        sourceFindingSubject,
      })),
    ).toEqual([
      {
        policyClass: 'source-portability',
        rule: 'mixed-absence',
        sourceFindingSubject: expectedSubject,
      },
    ]);
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 1,
      directOccurrences: 1,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });
    const introduced = compareCompilerPackageCheckBaseline(report, {
      findingIdentities: [],
      schema: 'flight-compiler-check-baseline/1',
    });
    expect(createCompilerPackageCheckPolicyResult(introduced, createCompilerPackageCheckPolicyStrict())).toMatchObject({
      failingFindingIdentities: [report.directFindings[0]?.identity],
      passed: false,
    });

    const portableSource = createMemoryWorkspaceSource(createTextureOptionsWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources).findings).toEqual([]);
  });

  it('keeps the TreeViewController initial-selection finding source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createTreeViewControllerOptionsWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const expectedSubject = 'interface:TreeViewControllerOptions/property:selectedItem';

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual([
      { rule: 'mixed-absence', subject: expectedSubject },
    ]);
    expect(sourcePortability.findings[0]?.message).toContain(
      'present initial item is retained by identity without a membership check or an onSelect emission',
    );
    expect(sourcePortability.findings[0]?.message).toContain(
      'setTreeViewControllerSelectedItem is the distinct live update boundary',
    );
    expect(sourcePortability.findings[0]?.message).toContain(
      'Selection never drives item visibility or styling: expansion state alone feeds updateTreeViewControllerVisibility',
    );
    expect(sourcePortability.findings[0]?.message).toContain(
      'Make TreeViewControllerOptions.selectedItem an optional TreeViewControllerItem without null',
    );
    expect(sourcePortability.findings[0]?.message).toContain(
      'Keep the runtime field, live setter parameter, getter result, and TreeViewControllerSignals.onSelect payload required nullable',
    );
    expect(sourcePortability.findings[0]?.message).toContain('Do not whitelist');
    expect(sourcePortability.findings[0]?.message).not.toContain('reviewed source-portability exception');
    expect(
      report.directFindings.map(({ policyClass, rule, sourceFindingSubject }) => ({
        policyClass,
        rule,
        sourceFindingSubject,
      })),
    ).toEqual([
      {
        policyClass: 'source-portability',
        rule: 'mixed-absence',
        sourceFindingSubject: expectedSubject,
      },
    ]);
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 1,
      directOccurrences: 1,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });
    const introduced = compareCompilerPackageCheckBaseline(report, {
      findingIdentities: [],
      schema: 'flight-compiler-check-baseline/1',
    });
    expect(createCompilerPackageCheckPolicyResult(introduced, createCompilerPackageCheckPolicyStrict())).toMatchObject({
      failingFindingIdentities: [report.directFindings[0]?.identity],
      passed: false,
    });

    const portableSource = createMemoryWorkspaceSource(createTreeViewControllerOptionsWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources).findings).toEqual([]);
  });

  it('keeps the Attachment2D authored-name finding source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createAttachment2DWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const expectedSubject = 'interface:Attachment2D/property:name';

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual([
      { rule: 'mixed-absence', subject: expectedSubject },
    ]);
    expect(sourcePortability.findings[0]?.message).toContain('No production consumer reads Attachment2D.name');
    expect(sourcePortability.findings[0]?.message).toContain(
      'Spine setup and animation lookup use the separate SkinAttachment2D.name plus slotIndex',
    );
    expect(sourcePortability.findings[0]?.message).toContain('Make Attachment2D.name a required string | null field');
    expect(sourcePortability.findings[0]?.message).toContain('Do not whitelist the redundant live-storage spelling');
    expect(
      report.directFindings.map(({ policyClass, rule, sourceFindingSubject }) => ({
        policyClass,
        rule,
        sourceFindingSubject,
      })),
    ).toEqual([
      {
        policyClass: 'source-portability',
        rule: 'mixed-absence',
        sourceFindingSubject: expectedSubject,
      },
    ]);
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 1,
      directOccurrences: 1,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });

    const portableSource = createMemoryWorkspaceSource(createAttachment2DWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources).findings).toEqual([]);
  });

  it('keeps the Material authored-name finding source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createMaterialWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const expectedSubject = 'interface:Material/property:name';

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual([
      { rule: 'mixed-absence', subject: expectedSubject },
    ]);
    expect(sourcePortability.findings[0]?.message).toContain(
      'createMaterial calls initializeMaterial, which assigns name = null',
    );
    expect(sourcePortability.findings[0]?.message).toContain(
      'cloneMaterial and copyMaterial copy the enumerable name cell without transformation',
    );
    expect(sourcePortability.findings[0]?.message).toContain('equalsMaterial compares own-key sets and exact values');
    expect(sourcePortability.findings[0]?.message).toContain('Make Material.name a required string | null field');
    expect(sourcePortability.findings[0]?.message).toContain('Do not whitelist');
    expect(sourcePortability.findings[0]?.message).not.toContain('reviewed source-portability exception');
    expect(
      report.directFindings.map(({ policyClass, rule, sourceFindingSubject }) => ({
        policyClass,
        rule,
        sourceFindingSubject,
      })),
    ).toEqual([
      {
        policyClass: 'source-portability',
        rule: 'mixed-absence',
        sourceFindingSubject: expectedSubject,
      },
    ]);
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 1,
      directOccurrences: 1,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });
    const introduced = compareCompilerPackageCheckBaseline(report, {
      findingIdentities: [],
      schema: 'flight-compiler-check-baseline/1',
    });
    expect(createCompilerPackageCheckPolicyResult(introduced, createCompilerPackageCheckPolicyStrict())).toMatchObject({
      failingFindingIdentities: [report.directFindings[0]?.identity],
      passed: false,
    });

    const portableSource = createMemoryWorkspaceSource(createMaterialWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources).findings).toEqual([]);
  });

  it('keeps both BoundingBoxAttachment2D point-storage findings source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createBoundingBoxAttachment2DWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const expectedSubjects = ['skin', 'vertices'].map((field) => `interface:BoundingBoxAttachment2D/property:${field}`);

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      expectedSubjects.map((subject) => ({ rule: 'mixed-absence', subject })),
    );
    expect(
      sourcePortability.findings.every(({ message }) =>
        message.includes('Current format parsers do not construct BoundingBoxAttachment2D'),
      ),
    ).toBe(true);
    expect(
      sourcePortability.findings.every(({ message }) =>
        message.includes('Make BoundingBoxAttachment2D.skin a required Skin2D | null field'),
      ),
    ).toBe(true);
    expect(sourcePortability.findings.every(({ message }) => message.includes('Do not whitelist'))).toBe(true);
    expect(
      report.directFindings.map(({ policyClass, rule, sourceFindingSubject }) => ({
        policyClass,
        rule,
        sourceFindingSubject,
      })),
    ).toEqual(
      expectedSubjects.map((sourceFindingSubject) => ({
        policyClass: 'source-portability',
        rule: 'mixed-absence',
        sourceFindingSubject,
      })),
    );
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 2,
      directOccurrences: 2,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });

    const portableSource = createMemoryWorkspaceSource(createBoundingBoxAttachment2DWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources).findings).toEqual([]);
  });

  it('keeps both ClippingAttachment2D point-storage findings source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createClippingAttachment2DWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const expectedSubjects = ['skin', 'vertices'].map((field) => `interface:ClippingAttachment2D/property:${field}`);

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      expectedSubjects.map((subject) => ({ rule: 'mixed-absence', subject })),
    );
    expect(
      sourcePortability.findings.every(({ message }) =>
        message.includes('Current format parsers do not construct ClippingAttachment2D'),
      ),
    ).toBe(true);
    expect(
      sourcePortability.findings.every(({ message }) =>
        message.includes('Make ClippingAttachment2D.skin a required Skin2D | null field'),
      ),
    ).toBe(true);
    expect(sourcePortability.findings.every(({ message }) => message.includes('Do not whitelist'))).toBe(true);
    expect(
      report.directFindings.map(({ policyClass, rule, sourceFindingSubject }) => ({
        policyClass,
        rule,
        sourceFindingSubject,
      })),
    ).toEqual(
      expectedSubjects.map((sourceFindingSubject) => ({
        policyClass: 'source-portability',
        rule: 'mixed-absence',
        sourceFindingSubject,
      })),
    );
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 2,
      directOccurrences: 2,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });

    const portableSource = createMemoryWorkspaceSource(createClippingAttachment2DWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources).findings).toEqual([]);
  });

  it('keeps the Camera3DOptions near-clip-plane finding source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createCamera3DOptionsWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const expectedSubject = 'interface:Camera3DOptions/property:nearClipPlane';

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual([
      { rule: 'mixed-absence', subject: expectedSubject },
    ]);
    expect(sourcePortability.findings[0]?.message).toContain('out.nearClipPlane = opts.nearClipPlane ?? null');
    expect(sourcePortability.findings[0]?.message).toContain(
      'The only downstream consumers are getCamera3DViewProjectionMatrix4',
    );
    expect(sourcePortability.findings[0]?.message).toContain(
      'make Camera3DOptions.nearClipPlane an optional Plane without null',
    );
    expect(sourcePortability.findings[0]?.message).toContain('Do not whitelist');
    expect(sourcePortability.findings[0]?.message).not.toContain('reviewed source-portability exception');
    expect(
      report.directFindings.map(({ policyClass, rule, sourceFindingSubject }) => ({
        policyClass,
        rule,
        sourceFindingSubject,
      })),
    ).toEqual([
      {
        policyClass: 'source-portability',
        rule: 'mixed-absence',
        sourceFindingSubject: expectedSubject,
      },
    ]);
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 1,
      directOccurrences: 1,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });
    const introduced = compareCompilerPackageCheckBaseline(report, {
      findingIdentities: [],
      schema: 'flight-compiler-check-baseline/1',
    });
    expect(createCompilerPackageCheckPolicyResult(introduced, createCompilerPackageCheckPolicyStrict())).toMatchObject({
      failingFindingIdentities: [report.directFindings[0]?.identity],
      passed: false,
    });

    const portableSource = createMemoryWorkspaceSource(createCamera3DOptionsWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources).findings).toEqual([]);
  });

  it('keeps the EnvironmentOptions absence finding source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createEnvironmentOptionsWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const expectedSubject = 'interface:EnvironmentOptions/property:environment';

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual([
      { rule: 'mixed-absence', subject: expectedSubject },
    ]);
    expect(sourcePortability.findings[0]?.message).toContain('out.environment = options?.environment ?? null');
    expect(sourcePortability.findings[0]?.message).toContain(
      'Environment owns the canonical mutable Texture | null storage cell but borrows the Texture identity',
    );
    expect(sourcePortability.findings[0]?.message).toContain(
      'The only direct readers of the live field are ensureGlEnvironmentSourceCube and ensureWgpuEnvironmentSourceCube',
    );
    expect(sourcePortability.findings[0]?.message).toContain(
      "destroyWgpuScene3DIbl is that cache's explicit invalidation and teardown seam",
    );
    expect(sourcePortability.findings[0]?.message).toContain(
      'Make EnvironmentOptions.environment an optional Texture without null',
    );
    expect(sourcePortability.findings[0]?.message).toContain(
      'keep Environment.environment required nullable for live install/clear state',
    );
    expect(sourcePortability.findings[0]?.message).toContain(
      'Adapt cloneEnvironment to omit the option when source.environment is null',
    );
    expect(sourcePortability.findings[0]?.message).toContain('Do not whitelist');
    expect(sourcePortability.findings[0]?.message).not.toContain('reviewed source-portability exception');
    expect(
      report.directFindings.map(({ policyClass, rule, sourceFindingSubject }) => ({
        policyClass,
        rule,
        sourceFindingSubject,
      })),
    ).toEqual([
      {
        policyClass: 'source-portability',
        rule: 'mixed-absence',
        sourceFindingSubject: expectedSubject,
      },
    ]);
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 1,
      directOccurrences: 1,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });
    const introduced = compareCompilerPackageCheckBaseline(report, {
      findingIdentities: [],
      schema: 'flight-compiler-check-baseline/1',
    });
    expect(createCompilerPackageCheckPolicyResult(introduced, createCompilerPackageCheckPolicyStrict())).toMatchObject({
      failingFindingIdentities: [report.directFindings[0]?.identity],
      passed: false,
    });

    const portableSource = createMemoryWorkspaceSource(createEnvironmentOptionsWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources).findings).toEqual([]);
  });

  it('keeps the Canvas blend-policy absence finding source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createCanvasRenderStateWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const expectedSubject = 'interface:CanvasRenderRegistries/property:blendModeApplication';

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual([
      { rule: 'mixed-absence', subject: expectedSubject },
    ]);
    expect(sourcePortability.findings[0]?.message).toContain('registries.blendModeApplication ?? null');
    expect(sourcePortability.findings[0]?.message).toContain(
      'Make CanvasRenderRegistries.blendModeApplication an optional non-null function',
    );
    expect(sourcePortability.findings[0]?.message).toContain('keep CanvasRenderState.applyBlendMode required nullable');
    expect(sourcePortability.findings[0]?.message).toContain('Do not whitelist the redundant registry spelling');
    expect(
      report.directFindings.map(({ policyClass, rule, sourceFindingSubject }) => ({
        policyClass,
        rule,
        sourceFindingSubject,
      })),
    ).toEqual([
      {
        policyClass: 'source-portability',
        rule: 'mixed-absence',
        sourceFindingSubject: expectedSubject,
      },
    ]);
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 1,
      directOccurrences: 1,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });

    const portableSource = createMemoryWorkspaceSource(createCanvasRenderStateWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources).findings).toEqual([]);
  });

  it('keeps both MeshAttachment2D point-storage findings source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createMeshAttachment2DWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const expectedSubjects = ['skin', 'vertices'].map((field) => `interface:MeshAttachment2D/property:${field}`);

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      expectedSubjects.map((subject) => ({ rule: 'mixed-absence', subject })),
    );
    expect(
      sourcePortability.findings.every(({ message }) =>
        message.includes('all call initializeMeshAttachment2D, which writes both fields'),
      ),
    ).toBe(true);
    expect(
      sourcePortability.findings.every(({ message }) =>
        message.includes('Make MeshAttachment2D.skin a required Skin2D | null field'),
      ),
    ).toBe(true);
    expect(sourcePortability.findings.every(({ message }) => message.includes('Do not whitelist'))).toBe(true);
    expect(
      report.directFindings.map(({ policyClass, rule, sourceFindingSubject }) => ({
        policyClass,
        rule,
        sourceFindingSubject,
      })),
    ).toEqual(
      expectedSubjects.map((sourceFindingSubject) => ({
        policyClass: 'source-portability',
        rule: 'mixed-absence',
        sourceFindingSubject,
      })),
    );
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 2,
      directOccurrences: 2,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });

    const portableSource = createMemoryWorkspaceSource(createMeshAttachment2DWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources).findings).toEqual([]);
  });

  it('keeps both PathAttachment2D point-storage findings source-owned through check mode', () => {
    const source = createMemoryWorkspaceSource(createPathAttachment2DWorkspaceFiles(true));
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const report = createCompilerPackageCheckReport(compilation.report, {
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    });
    const expectedSubjects = ['skin', 'vertices'].map((field) => `interface:PathAttachment2D/property:${field}`);

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      expectedSubjects.map((subject) => ({ rule: 'mixed-absence', subject })),
    );
    expect(
      sourcePortability.findings.every(({ message }) =>
        message.includes('deformSkeleton2DPathAttachment passes skin and vertices unchanged'),
      ),
    ).toBe(true);
    expect(
      sourcePortability.findings.every(({ message }) =>
        message.includes('Make PathAttachment2D.skin a required Skin2D | null field'),
      ),
    ).toBe(true);
    expect(sourcePortability.findings.every(({ message }) => message.includes('Do not whitelist'))).toBe(true);
    expect(
      report.directFindings.map(({ policyClass, rule, sourceFindingSubject }) => ({
        policyClass,
        rule,
        sourceFindingSubject,
      })),
    ).toEqual(
      expectedSubjects.map((sourceFindingSubject) => ({
        policyClass: 'source-portability',
        rule: 'mixed-absence',
        sourceFindingSubject,
      })),
    );
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 2,
      directOccurrences: 2,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });

    const portableSource = createMemoryWorkspaceSource(createPathAttachment2DWorkspaceFiles(false));
    const portableInput = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/types'],
      source: portableSource,
      upstreamDirectory: '/flight',
    });
    expect(analyzeTypeScriptSourcePortability(portableInput.sources).findings).toEqual([]);
  });

  it('keeps both specialized entity guard set traps stable through check mode', () => {
    const source = createMemoryWorkspaceSource(createEntityGuardWorkspaceFiles());
    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/entity'],
      source,
      upstreamDirectory: '/flight',
    });
    const sourcePortability = analyzeTypeScriptSourcePortability(input.sources);
    const compilation = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'acceptance',
      },
      backendOptions: {},
      ...input,
    });
    const options = {
      classification: {
        rules: { 'unchecked-double-assertion': 'compiler-defect' as const },
        schema: 'flight-compiler-check-classification/1' as const,
      },
      provenance: {
        compiler: { name: 'flight-compiler', revision: 'compiler-revision' },
        target: { name: 'fixture-target', revision: 'target-revision' },
        upstream: { name: 'flight', revision: 'upstream-revision' },
      },
      sourcePortability,
    };
    const report = createCompilerPackageCheckReport(compilation.report, options);
    const expectedSourceIdentities = [
      'flight-compiler-source-portability-finding/1:["@flighthq/entity","packages/entity/src/guards.ts","unchecked-double-assertion","function:createGuardedEntity/function:set","sha256:870139b4b51bbd01ab624c5d97969207ca6f53e122427ed06476ced04f8b6535"]:0',
      'flight-compiler-source-portability-finding/1:["@flighthq/entity","packages/entity/src/guards.ts","unchecked-double-assertion","function:createGuardedEntityRuntime/function:set","sha256:870139b4b51bbd01ab624c5d97969207ca6f53e122427ed06476ced04f8b6535"]:0',
    ];
    const expectedCheckIdentities = expectedSourceIdentities.map(
      (sourceIdentity) =>
        `flight-compiler-check-finding/1:${JSON.stringify([
          '@flighthq/entity',
          'packages/entity/src/guards.ts',
          'Guards',
          'source',
          'source-portability',
          'unchecked-double-assertion',
          sourceIdentity,
        ])}`,
    );

    expect(compilation.report.modules).toHaveLength(2);
    expect(
      compilation.report.modules.every(({ refusals, status }) => refusals.length === 0 && status === 'emitted'),
    ).toBe(true);
    expect(sourcePortability.acceptedExceptions).toEqual([]);
    expect(sourcePortability.findings.map(({ identity, rule, subject }) => ({ identity, rule, subject }))).toEqual([
      {
        identity: expectedSourceIdentities[0],
        rule: 'unchecked-double-assertion',
        subject: 'function:createGuardedEntity/function:set',
      },
      {
        identity: expectedSourceIdentities[1],
        rule: 'unchecked-double-assertion',
        subject: 'function:createGuardedEntityRuntime/function:set',
      },
    ]);
    expect(sourcePortability.findings.every(({ message }) => message.includes("Proxy set trap's PropertyKey"))).toBe(
      true,
    );
    expect(sourcePortability.findings[0]?.message).toContain('same generic Type & Entity target');
    expect(sourcePortability.findings[1]?.message).toContain('same EntityRuntime target');
    expect(report.directFindings.map(({ identity }) => identity)).toEqual(expectedCheckIdentities);
    expect(report.directFindings.map(({ sourceFindingIdentity }) => sourceFindingIdentity)).toEqual(
      expectedSourceIdentities,
    );
    expect(
      report.directFindings.map(({ code, policyClass, rule, stage }) => ({ code, policyClass, rule, stage })),
    ).toEqual([
      {
        code: 'source-portability',
        policyClass: 'source-portability',
        rule: 'unchecked-double-assertion',
        stage: 'source',
      },
      {
        code: 'source-portability',
        policyClass: 'source-portability',
        rule: 'unchecked-double-assertion',
        stage: 'source',
      },
    ]);
    expect(report.totals).toEqual({
      dependencyCascades: 0,
      directFindings: 2,
      directOccurrences: 2,
      modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
      packages: 1,
    });
    expect(report.packages).toEqual([
      {
        dependencyCascades: 0,
        directFindings: 2,
        directOccurrences: 2,
        findingsByPolicy: {
          'compiler-defect': 0,
          'compiler-restriction': 0,
          'source-portability': 2,
          'target-runtime': 0,
          unclassified: 0,
        },
        modules: { dependencyRefused: 0, directlyRefused: 0, emitted: 2, total: 2 },
        name: '@flighthq/entity',
      },
    ]);

    const baseline = createCompilerPackageCheckBaseline(report);
    const revisedMessages = ['revised entity target guidance', 'revised runtime target guidance'];
    const revisedReport = createCompilerPackageCheckReport(compilation.report, {
      ...options,
      sourcePortability: {
        ...sourcePortability,
        findings: sourcePortability.findings.map((finding, index) => ({
          ...finding,
          message: revisedMessages[index] ?? finding.message,
        })),
      },
    });
    const comparison = compareCompilerPackageCheckBaseline(revisedReport, baseline);

    expect(baseline.findingIdentities).toEqual(expectedCheckIdentities);
    expect(comparison.introduced).toEqual([]);
    expect(comparison.resolvedFindingIdentities).toEqual([]);
    expect(comparison.unchanged.map(({ identity }) => identity)).toEqual(expectedCheckIdentities);
    expect(comparison.unchanged.map(({ occurrences }) => occurrences[0]?.message)).toEqual(revisedMessages);
    expect(comparison.unchanged.every(({ policyClass }) => policyClass === 'source-portability')).toBe(true);
    expect(createCompilerPackageCheckPolicyResult(comparison, createCompilerPackageCheckPolicyStrict())).toMatchObject({
      failingFindingIdentities: [],
      passed: true,
    });
  });

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

  it('attributes a type-only interface cycle through the direct refusal reached by its broad fan-in', () => {
    const files = createCyclicTypesWorkspaceFiles();
    const source = createMemoryWorkspaceSource(files);
    const manifests = readFlightPackageManifests({ upstreamDirectory: '/flight' }, source);
    const eligibility = createFlightPackageEligibilityPlan({
      environment: 'web',
      packages: manifests,
      selectedPackageNames: ['@flighthq/types'],
    });
    const backend: CompilerBackend = {
      emitModule(module) {
        if (module.name === 'Bad') {
          throw createBackendEmissionFailure(
            'acceptance',
            module,
            'Bad is unsupported by the fixture target',
            'fixture-unsupported',
          );
        }
        return [{ contents: module.name, path: `${module.name}.txt` }];
      },
      name: 'acceptance',
    };
    const compilation = compileFlightWorkspace({
      backend,
      backendOptions: {},
      eligiblePackageNames: eligibility.eligiblePackageNames,
      source,
      upstreamDirectory: '/flight',
    });

    const report = createCompilerPackageCheckReport(compilation.report, {
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
    const directIdentity = report.directFindings[0]?.identity;
    const app = compilation.report.modules.find((module) => module.module.name === 'App');

    expect(app?.refusals[0]?.refusedDependencies).toEqual([
      '@flighthq/types/packages/types/src/Bad.ts',
      '@flighthq/types/packages/types/src/Child.ts',
    ]);
    expect(report.directFindings.map((finding) => finding.module.name)).toEqual(['Bad']);
    expect(report.cascades.map((cascade) => cascade.module.name)).toEqual(['App', 'Child', 'Index']);
    expect(report.cascades.every((cascade) => cascade.directFindingIdentities[0] === directIdentity)).toBe(true);
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

function createAnchorLayoutWorkspaceFiles(mixedAbsence: boolean): Record<string, string> {
  const nullable = mixedAbsence ? ' | null' : '';
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/Layout.ts': `export interface AnchorLayoutItemStyle {
  bottom?: number${nullable};
  height?: number${nullable};
  left?: number${nullable};
  right?: number${nullable};
  top?: number${nullable};
  width?: number${nullable};
}`,
    '/flight/packages/types/src/index.ts': `export type { AnchorLayoutItemStyle } from './Layout.js';`,
  };
}

function createColorAdjustmentWorkspaceFiles(): Record<string, string> {
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/GlRenderStateOptions.ts': `export interface GlColorAdjustmentMaterialFeature {
  readonly fragmentShaderChunk: string;
}
export interface GlRenderStateOptions {
  colorAdjustmentFeature?: GlColorAdjustmentMaterialFeature | null;
}`,
    '/flight/packages/types/src/index.ts': `export type { GlColorAdjustmentMaterialFeature, GlRenderStateOptions } from './GlRenderStateOptions.js';`,
  };
}

function createGlContextRuntimeWorkspaceFiles(mixedAbsence: boolean): Record<string, string> {
  const declaration = mixedAbsence
    ? `export interface EXT_texture_filter_anisotropic {
  readonly MAX_TEXTURE_MAX_ANISOTROPY_EXT: number;
  readonly TEXTURE_MAX_ANISOTROPY_EXT: number;
}
export interface GlContextRuntime {
  anisotropyExt?: EXT_texture_filter_anisotropic | null;
  maxAnisotropy?: number;
  sceneMeshUploadCache?: WeakMap<object, object> | null;
}`
    : `export interface EXT_texture_filter_anisotropic {
  readonly MAX_TEXTURE_MAX_ANISOTROPY_EXT: number;
  readonly TEXTURE_MAX_ANISOTROPY_EXT: number;
}
export type GlAnisotropyCapability =
  | { readonly state: 'unqueried' }
  | { readonly state: 'unsupported' }
  | {
      readonly extension: EXT_texture_filter_anisotropic;
      readonly maximum: number;
      readonly state: 'supported';
    };
export interface GlContextRuntime {
  anisotropy: GlAnisotropyCapability;
  sceneMeshUploadCache: WeakMap<object, object> | null;
}`;
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/GlContextRuntime.ts': declaration,
    '/flight/packages/types/src/index.ts': `export type {
  EXT_texture_filter_anisotropic,
  GlContextRuntime,
} from './GlContextRuntime.js';`,
  };
}

function createWgpuDeviceRuntimeWorkspaceFiles(mixedAbsence: boolean): Record<string, string> {
  const marker = mixedAbsence ? '?' : '';
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/WgpuDeviceRuntime.ts': `export interface WgpuDeviceRuntime {
  sceneMeshUploadCache${marker}: WeakMap<object, object> | null;
}`,
    '/flight/packages/types/src/index.ts': `export type { WgpuDeviceRuntime } from './WgpuDeviceRuntime.js';`,
  };
}

function createScene3DDocumentMeshWorkspaceFiles(mixedAbsence: boolean): Record<string, string> {
  const morph = mixedAbsence ? 'morph?: MeshMorph | null;' : 'morph?: MeshMorph;';
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/Scene3DDocument.ts': `export interface MeshMorph {
  readonly weights: Float32Array;
}
export interface Scene3DDocumentMesh {
  ${morph}
}`,
    '/flight/packages/types/src/index.ts': `export type {
  MeshMorph,
  Scene3DDocumentMesh,
} from './Scene3DDocument.js';`,
  };
}

function createSkeleton3DNamesWorkspaceFiles(mixedAbsence: boolean): Record<string, string> {
  const marker = mixedAbsence ? '?' : '';
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/Skeleton3D.ts': `export interface Skeleton3D {
  names${marker}: readonly string[] | null;
}`,
    '/flight/packages/types/src/index.ts': `export type { Skeleton3D } from './Skeleton3D.js';`,
  };
}

function createSkeleton2DImportDrawOrderWorkspaceFiles(mixedAbsence: boolean): Record<string, string> {
  const marker = mixedAbsence ? '?' : '';
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/Skeleton2DImport.ts': `export interface Skeleton2DDrawOrderTimeline {
  orderings: number[];
  times: number[];
}
export interface Skeleton2DImportAnimation {
  drawOrder${marker}: Skeleton2DDrawOrderTimeline | null;
}`,
    '/flight/packages/types/src/index.ts': `export type {
  Skeleton2DDrawOrderTimeline,
  Skeleton2DImportAnimation,
} from './Skeleton2DImport.js';`,
  };
}

function createSkeleton2DWorkspaceFiles(mixedAbsence: boolean): Record<string, string> {
  const marker = mixedAbsence ? '?' : '';
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/Skeleton2D.ts': `interface AttachmentSkin2D { readonly name: string }
interface Slot2D { readonly boneIndex: number }
export interface Skeleton2D {
  skins${marker}: AttachmentSkin2D[] | null;
  slots${marker}: Slot2D[] | null;
}`,
    '/flight/packages/types/src/index.ts': `export type { Skeleton2D } from './Skeleton2D.js';`,
  };
}

function createMorphShapeGradientEndpointWorkspaceFiles(mixedAbsence: boolean): Record<string, string> {
  const nullable = mixedAbsence ? ' | null' : '';
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/MorphShape.ts': `export interface Matrix {
  readonly a: number;
}
export interface MorphShapeGradientEndpoint {
  readonly alphas: readonly number[];
  readonly colors: readonly number[];
  readonly matrix?: Readonly<Matrix>${nullable};
  readonly ratios: readonly number[];
}
export interface MorphShapeGradientPaintBinding {
  readonly endMatrix: Readonly<Matrix> | null;
  readonly startMatrix: Readonly<Matrix> | null;
}`,
    '/flight/packages/types/src/index.ts': `export type {
  Matrix,
  MorphShapeGradientEndpoint,
  MorphShapeGradientPaintBinding,
} from './MorphShape.js';`,
  };
}

function createGlMeshProgramWorkspaceFiles(mixedAbsence: boolean): Record<string, string> {
  const declaration = mixedAbsence
    ? `export interface GlMeshProgram {
  locAlphaIsCoverage?: WebGLUniformLocation | null;
  locColorBias?: WebGLUniformLocation | null;
  locColorMatrix0?: WebGLUniformLocation | null;
  locColorMatrix1?: WebGLUniformLocation | null;
  locColorMatrix2?: WebGLUniformLocation | null;
  locColorMatrix3?: WebGLUniformLocation | null;
  locColorMatrixOffset?: WebGLUniformLocation | null;
  locColorScale?: WebGLUniformLocation | null;
  locInstanceColorPalette?: WebGLUniformLocation | null;
  locInstancePalette?: WebGLUniformLocation | null;
  locJointNormalTexture?: WebGLUniformLocation | null;
  locJointTexture?: WebGLUniformLocation | null;
  locObjectAlpha?: WebGLUniformLocation | null;
  locUvTransform?: WebGLUniformLocation | null;
}`
    : `type GlUniformLocationCache =
  | { readonly state: 'unresolved' }
  | { readonly state: 'absent' }
  | { readonly location: WebGLUniformLocation; readonly state: 'present' };
type GlColorMatrixUniformCache =
  | { readonly state: 'unresolved' }
  | { readonly state: 'absent' }
  | {
      readonly location0: WebGLUniformLocation;
      readonly location1: WebGLUniformLocation;
      readonly location2: WebGLUniformLocation;
      readonly location3: WebGLUniformLocation;
      readonly locationOffset: WebGLUniformLocation;
      readonly state: 'present';
    };
type GlColorScaleBiasUniformCache =
  | { readonly state: 'unresolved' }
  | { readonly state: 'absent' }
  | {
      readonly bias: WebGLUniformLocation;
      readonly scale: WebGLUniformLocation;
      readonly state: 'present';
    };
export interface GlMeshProgram {
  colorMatrixUniforms: GlColorMatrixUniformCache;
  colorScaleBiasUniforms: GlColorScaleBiasUniformCache;
  locAlphaIsCoverage: GlUniformLocationCache;
  locInstanceColorPalette: GlUniformLocationCache;
  locInstancePalette: GlUniformLocationCache;
  locJointNormalTexture: WebGLUniformLocation | null;
  locJointTexture: WebGLUniformLocation | null;
  locObjectAlpha: GlUniformLocationCache;
  locUvTransform: GlUniformLocationCache;
}`;
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/GlMeshProgram.ts': declaration,
    '/flight/packages/types/src/index.ts': `export type { GlMeshProgram } from './GlMeshProgram.js';`,
  };
}

function createGlRenderStateWorkspaceFiles(mixedAbsence: boolean): Record<string, string> {
  const optional = mixedAbsence ? '?' : '';
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/GlRenderState.ts': `export interface GlRenderState {}
export interface GlRenderTarget {}
export interface GlScissorRect {}
export interface ColorScaleBias {}
export interface TintMaterialData {}
export type GlRenderTextureGuard = (state: GlRenderState) => void;
export interface GlRenderStateRuntime {
  currentRenderTarget${optional}: GlRenderTarget | null;
  currentScissorRect${optional}: GlScissorRect | null;
  flushPendingDraws${optional}: ((state: GlRenderState) => void) | null;
  glRenderTextureGuard${optional}: GlRenderTextureGuard | null;
  quadBatchWriterUniformColorScaleBias${optional}: ColorScaleBias | TintMaterialData | readonly number[] | null;
}`,
    '/flight/packages/types/src/index.ts': `export type { GlRenderStateRuntime } from './GlRenderState.js';`,
  };
}

function createEntityGuardWorkspaceFiles(): Record<string, string> {
  return {
    '/flight/packages/entity/package.json': createPackageManifest('@flighthq/entity'),
    '/flight/packages/entity/src/guards.ts': `const EntityRuntimeKey = 'runtime';
interface Entity { runtime: object | undefined }
interface EntityRuntime { binding: object | null }
function observe(): void {}
export function createGuardedEntity<Type extends object>(entity: Type & Entity): Type & Entity {
  return new Proxy(entity, {
    set(target, prop, value) {
      if (prop === EntityRuntimeKey) observe();
      (target as unknown as Record<PropertyKey, unknown>)[prop] = value;
      return true;
    },
  });
}
export function createGuardedEntityRuntime(runtime: EntityRuntime): EntityRuntime {
  return new Proxy(runtime, {
    set(target, prop, value) {
      if (prop === 'binding') observe();
      (target as unknown as Record<PropertyKey, unknown>)[prop] = value;
      return true;
    },
  });
}`,
    '/flight/packages/entity/src/index.ts': `export { createGuardedEntity, createGuardedEntityRuntime } from './guards.js';`,
  };
}

function createNodeRuntimeSlotWorkspaceFiles(opaque: boolean): Record<string, string> {
  const runtimeWrite = opaque
    ? '(node as { [EntityRuntimeKey]?: unknown })[EntityRuntimeKey] = runtimeFactory();'
    : 'node[EntityRuntimeKey] = runtimeFactory();';
  return {
    '/flight/packages/node/package.json': createPackageManifest('@flighthq/node'),
    '/flight/packages/node/src/index.ts': `export { initializeNode } from './node.js';`,
    '/flight/packages/node/src/node.ts': `export const EntityRuntimeKey = Symbol.for('EntityRuntime');
interface EntityRuntime { binding: object | null }
interface NodeRuntime<Traits extends object> extends EntityRuntime { parent: Traits | null }
interface Node<Traits extends object> { [EntityRuntimeKey]: NodeRuntime<Traits> | undefined }
type EntityConstruction<Value> = { -readonly [Key in keyof Value]: Value[Key] };
type NodeRuntimeFactory<Runtime extends EntityRuntime> = () => Runtime;
export function initializeNode<Traits extends object, Runtime extends NodeRuntime<Traits>>(
  out: EntityConstruction<Node<Traits>>,
  runtimeFactory: NodeRuntimeFactory<Runtime>,
): void {
  const node = out as EntityConstruction<Node<Traits>>;
  ${runtimeWrite}
}`,
  };
}

function createRuntimeFactoryWorkspaceFiles(): Record<string, string> {
  return {
    '/flight/packages/node/package.json': createPackageManifest('@flighthq/node'),
    '/flight/packages/node/src/index.ts': `export { initializeNode } from './node.js';`,
    '/flight/packages/node/src/node.ts': `interface NodeRuntime<Traits extends object> { readonly traits?: Traits }
type NodeRuntimeFactory<Runtime> = (obj?: Readonly<Partial<Runtime>>) => Runtime;
function createNodeRuntime<Traits extends object>(): NodeRuntime<Traits> { return {}; }
export function initializeNode<Traits extends object, Runtime extends NodeRuntime<Traits>>(
  createNodeRuntimeFactory?: NodeRuntimeFactory<Runtime>,
): void {
  const runtimeFactory =
    createNodeRuntimeFactory ?? (createNodeRuntime as unknown as NodeRuntimeFactory<Runtime>);
  void runtimeFactory();
}`,
    '/flight/packages/scene2d/package.json': createPackageManifest('@flighthq/scene2d'),
    '/flight/packages/scene2d/src/index.ts': `export { createNode2D } from './displayObject.js';`,
    '/flight/packages/scene2d/src/displayObject.ts': `interface Node2DRuntime { readonly scene2d: true }
type NodeRuntimeFactory<Runtime> = (obj?: Readonly<Partial<Runtime>>) => Runtime;
type Node2DRuntimeFactory<Runtime extends Node2DRuntime> = NodeRuntimeFactory<Runtime>;
function initializeNode<Runtime extends Node2DRuntime>(
  out: object,
  kind: string,
  obj: object,
  createData: () => object,
  runtimeFactory: NodeRuntimeFactory<Runtime>,
): void { void out; void kind; void obj; void createData; void runtimeFactory(); }
function createNode2DRuntime(): Node2DRuntime { return { scene2d: true }; }
export function createNode2D<R extends Node2DRuntime>(
  createNode2DRuntimeFactory?: Node2DRuntimeFactory<R>,
): void {
  initializeNode(
    {},
    'Node2D',
    {},
    () => ({}),
    createNode2DRuntimeFactory ?? (createNode2DRuntime as unknown as NodeRuntimeFactory<R>),
  );
}`,
  };
}

function createNodeBoundsWorkspaceFiles(): Record<string, string> {
  return {
    '/flight/packages/node/package.json': createPackageManifest('@flighthq/node'),
    '/flight/packages/node/src/boundsRectangle.ts': `interface EntityRuntime { binding: object | null }
interface HasBoundsRectangleRuntime extends EntityRuntime { boundsRectangle: object | null }
interface NodeRuntime<Traits extends object> extends EntityRuntime { traits?: Traits }
interface Node<Traits extends object> { readonly traits?: Traits }
interface HasBoundsRectangle { readonly bounds: true }
interface HasTransform2D { readonly x: number }
type NodeOf<Traits extends object> = Node<Traits> & Traits;
type BoundsNode<Traits extends object> = NodeOf<Traits> & HasBoundsRectangle;
type Spatial2DNode<Traits extends object> = NodeOf<Traits> & HasBoundsRectangle & HasTransform2D;
const entityRuntime: EntityRuntime = { binding: null };
const out = {};
function getEntityRuntime(_source: object): Readonly<EntityRuntime> { return entityRuntime; }
function getNodeParent<Traits extends object>(_source: Readonly<Node<Traits>>): NodeOf<Traits> | null {
  return null;
}
function computeNodeBoundsRectangle<Traits extends object>(
  _out: object,
  _source: Spatial2DNode<Traits>,
  _targetCoordinateSpace: Spatial2DNode<Traits> | null | undefined,
): void {}
export function ensureNodeLocalBoundsRectangle<Traits extends object>(target: BoundsNode<Traits>): void {
  const runtime = getEntityRuntime(target) as NodeRuntime<Traits> & HasBoundsRectangleRuntime;
  runtime.boundsRectangle = null;
}
export function getNodeHeight<Traits extends object>(source: Spatial2DNode<Traits>): number {
  computeNodeBoundsRectangle(out, source, getNodeParent(source) as unknown as Spatial2DNode<Traits> | null);
  return 0;
}
export function getNodeWidth<Traits extends object>(source: Spatial2DNode<Traits>): number {
  computeNodeBoundsRectangle(out, source, getNodeParent(source) as unknown as Spatial2DNode<Traits> | null);
  return 0;
}`,
    '/flight/packages/node/src/index.ts': `export {
  ensureNodeLocalBoundsRectangle,
  getNodeHeight,
  getNodeWidth,
} from './boundsRectangle.js';`,
  };
}

function createNodeHierarchyWorkspaceFiles(): Record<string, string> {
  return {
    '/flight/packages/node/package.json': createPackageManifest('@flighthq/node'),
    '/flight/packages/node/src/hierarchy.ts': `interface Node<Traits extends object> { readonly name: string }
type NodeOf<Traits extends object> = Node<Traits> & NoInfer<Traits>;
function getNodeParent<Traits extends object>(_source: Readonly<Node<Traits>>): NodeOf<Traits> | null {
  return null;
}
export function getNodeCommonAncestor<Traits extends object>(
  a: Readonly<Node<Traits>>,
  b: Readonly<Node<Traits>>,
): NodeOf<Traits> | null {
  const aNode = a as NodeOf<Traits>;
  if (aNode === b) return aNode;
  return getNodeParent(b as NodeOf<Traits>);
}`,
    '/flight/packages/node/src/index.ts': `export { getNodeCommonAncestor } from './hierarchy.js';`,
  };
}

function createNodeTraversalWorkspaceFiles(): Record<string, string> {
  return {
    '/flight/packages/node/package.json': createPackageManifest('@flighthq/node'),
    '/flight/packages/node/src/index.ts': `export { getNodeNextSibling } from './traversal.js';`,
    '/flight/packages/node/src/traversal.ts': `interface NodeRuntime<Traits extends object> {
  children: NodeOf<Traits>[] | null;
  parent: NodeOf<Traits> | null;
}
interface Node<Traits extends object> {
  readonly name: string;
  runtime: NodeRuntime<Traits>;
}
type NodeOf<Traits extends object> = Node<Traits> & NoInfer<Traits>;
function getNodeRuntime<Traits extends object>(
  source: Readonly<Node<Traits>>,
): Readonly<NodeRuntime<Traits>> {
  return source.runtime;
}
function getNodeParent<Traits extends object>(source: Readonly<Node<Traits>>): NodeOf<Traits> | null {
  return getNodeRuntime(source).parent;
}
export function getNodeNextSibling<Traits extends object>(
  source: Readonly<Node<Traits>>,
): NodeOf<Traits> | null {
  const sourceNode = source as NodeOf<Traits>;
  const parent = getNodeParent(sourceNode);
  if (parent === null) return null;
  const siblings = getNodeRuntime(parent).children;
  if (siblings === null) return null;
  const index = siblings.indexOf(sourceNode);
  return index < 0 || index + 1 === siblings.length ? null : siblings[index + 1];
}`,
  };
}

function createNodeOrderListWorkspaceFiles(): Record<string, string> {
  return {
    '/flight/packages/node/package.json': createPackageManifest('@flighthq/node'),
    '/flight/packages/node/src/index.ts': `export { applyNodeOrderList } from './nodeOrderList.js';`,
    '/flight/packages/node/src/nodeOrderList.ts': `interface Node<Traits extends object> { readonly name: string }
type NodeAny = Node<any>;
type NodeOf<Traits extends object> = Node<Traits> & NoInfer<Traits>;
const members: NodeAny[] = [];
export function applyNodeOrderList<Traits extends object>(children: NodeOf<Traits>[]): void {
  if (members.length === 0) return;
  children[0] = members[0] as NodeOf<Traits>;
}`,
  };
}

function createNodeStageFitWorkspaceFiles(): Record<string, string> {
  return {
    '/flight/packages/node/package.json': createPackageManifest('@flighthq/node'),
    '/flight/packages/node/src/index.ts': `export { computeScene2DFitTransform } from './stageFit.js';`,
    '/flight/packages/node/src/stageFit.ts': `interface Rectangle { height: number; width: number; x: number; y: number }
interface NodeRuntime<Traits extends object> { localBoundsId: number; traits?: Traits }
interface Node<Traits extends object> { readonly runtime: NodeRuntime<Traits> }
interface BoundsNodeAny extends Node<object> { readonly bounds: true }
interface HasBoundsRectangleRuntime {
  computeLocalBoundsRectangle: (out: Rectangle, source: Readonly<BoundsNodeAny>) => void;
}
interface Scene2DFitContext<Traits extends object> { root: Node<Traits> | null }
const scratch: Rectangle = { height: 0, width: 0, x: 0, y: 0 };
function getNodeRuntime<Traits extends object>(
  source: Readonly<Node<Traits>>,
): Readonly<NodeRuntime<Traits>> {
  return source.runtime;
}
export function computeScene2DFitTransform<Traits extends object>(
  out: Rectangle,
  scene2d: Readonly<Scene2DFitContext<Traits>>,
): void {
  if (scene2d.root === null) return;
  const runtime = getNodeRuntime(scene2d.root) as Partial<HasBoundsRectangleRuntime>;
  if (runtime.computeLocalBoundsRectangle === undefined) return;
  runtime.computeLocalBoundsRectangle(scratch, scene2d.root as BoundsNodeAny);
  out.width = scratch.width;
}`,
  };
}

function createNodeTransform2dWorkspaceFiles(): Record<string, string> {
  return {
    '/flight/packages/node/package.json': createPackageManifest('@flighthq/node'),
    '/flight/packages/node/src/index.ts': `export { ensureNodeLocalMatrix } from './nodeTransform2d.js';`,
    '/flight/packages/node/src/nodeTransform2d.ts': `interface EntityRuntime { binding: object | null }
interface HasTransform2DRuntime extends EntityRuntime {
  localMatrix: number | null;
  rotationAngle: number;
}
interface NodeRuntime<Traits extends object> extends EntityRuntime { traits?: Traits }
interface Node<Traits extends object> { readonly traits?: Traits }
interface HasTransform2D { rotation: number }
type Transform2DNode<Traits extends object> = Node<Traits> & HasTransform2D;
const entityRuntime: EntityRuntime = { binding: null };
function getEntityRuntime(_source: object): Readonly<EntityRuntime> { return entityRuntime; }
export function ensureNodeLocalMatrix<Traits extends object>(target: Transform2DNode<Traits>): void {
  const runtime = getEntityRuntime(target) as NodeRuntime<Traits> & HasTransform2DRuntime;
  runtime.rotationAngle = target.rotation;
  runtime.localMatrix = 1;
}`,
  };
}

function createNodeTransform3dWorkspaceFiles(): Record<string, string> {
  return {
    '/flight/packages/node/package.json': createPackageManifest('@flighthq/node'),
    '/flight/packages/node/src/index.ts': `export { setNodeLocalMatrix4 } from './nodeTransform3d.js';`,
    '/flight/packages/node/src/nodeTransform3d.ts': `interface EntityRuntime { binding: object | null }
interface HasTransform3DRuntime extends EntityRuntime {
  localMatrix4: number | null;
  localMatrix4Detached: boolean;
}
interface NodeRuntime<Traits extends object> extends EntityRuntime {
  localTransformId: number;
  localTransformUsingLocalTransformId: number;
  traits?: Traits;
}
interface Node<Traits extends object> { readonly traits?: Traits }
interface HasTransform3D { position: number }
type Transform3DNode<Traits extends object> = Node<Traits> & HasTransform3D;
const entityRuntime: EntityRuntime = { binding: null };
function getEntityRuntime(_source: object): Readonly<EntityRuntime> { return entityRuntime; }
export function setNodeLocalMatrix4<Traits extends object>(target: Transform3DNode<Traits>): void {
  const runtime = getEntityRuntime(target) as NodeRuntime<Traits> & HasTransform3DRuntime;
  runtime.localMatrix4 = target.position;
  runtime.localTransformUsingLocalTransformId = runtime.localTransformId;
  runtime.localMatrix4Detached = true;
}`,
  };
}

function createLogWorkspaceFiles(opaque: boolean): Record<string, string> {
  const declarations = opaque
    ? `export type LogData = string | Readonly<Record<string, unknown>>;
export interface LogContext { fields: Readonly<Record<string, unknown>> }
export interface LogSpan { fields: Readonly<Record<string, unknown>> }`
    : `export type LogFieldValue =
  | boolean
  | number
  | string
  | null
  | readonly LogFieldValue[]
  | Readonly<Record<string, LogFieldValue>>;
export type LogFields = Readonly<Record<string, LogFieldValue>>;
export type LogData = string | LogFields;
export interface LogContext { fields: LogFields }
export interface LogSpan { fields: LogFields }`;
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/Log.ts': declarations,
    '/flight/packages/types/src/index.ts': `export type { LogContext, LogData, LogSpan } from './Log.js';`,
  };
}

function createAnimationClipEventWorkspaceFiles(opaque: boolean): Record<string, string> {
  const declarations = opaque
    ? `export interface AnimationClipEvent { name: string; payload: unknown; time: number }`
    : `export type AnimationClipEventPayload =
  | boolean
  | number
  | string
  | null
  | readonly AnimationClipEventPayload[]
  | Readonly<Record<string, AnimationClipEventPayload>>;
export interface AnimationClipEvent { name: string; payload: AnimationClipEventPayload; time: number }`;
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/AnimationClipEvent.ts': declarations,
    '/flight/packages/types/src/index.ts': opaque
      ? `export type { AnimationClipEvent } from './AnimationClipEvent.js';`
      : `export type { AnimationClipEvent, AnimationClipEventPayload } from './AnimationClipEvent.js';`,
  };
}

function createAnimationPlayerSignalWorkspaceFiles(mixedAbsence: boolean): Record<string, string> {
  const optional = mixedAbsence ? '?' : '';
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/AnimationPlayer.ts': `export interface AnimationClipEvent { readonly name: string }
export interface Signal<T> { readonly id: number }
export interface AnimationPlayer {
  onEvent${optional}: Signal<(event: Readonly<AnimationClipEvent>) => void> | null;
  onFinished${optional}: Signal<() => void> | null;
  onLooped${optional}: Signal<() => void> | null;
}`,
    '/flight/packages/types/src/index.ts': `export type { AnimationPlayer } from './AnimationPlayer.js';`,
  };
}

function createCommandPropertyWorkspaceFiles(opaque: boolean): Record<string, string> {
  const declaration = opaque
    ? `export interface NodeAny { readonly x: number; readonly y: number }
export interface CommandPropertyEntry {
  readonly after: unknown;
  readonly before: unknown;
  readonly property: string;
  readonly target: NodeAny;
}`
    : `export interface Node2D { readonly x: number; readonly y: number }
export interface SetNodePositionCommand {
  readonly afterX: number;
  readonly afterY: number;
  readonly beforeX: number;
  readonly beforeY: number;
  readonly target: Node2D;
}`;
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/Command.ts': declaration,
    '/flight/packages/types/src/index.ts': opaque
      ? `export type { CommandPropertyEntry, NodeAny } from './Command.js';`
      : `export type { Node2D, SetNodePositionCommand } from './Command.js';`,
  };
}

function createFlightDocumentWorkspaceFiles(mixedAbsence: boolean): Record<string, string> {
  const marker = mixedAbsence ? '?' : '';
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/FlightDocument.ts': `interface FlightDocumentInteractiveStates {
  readonly hover: boolean;
}
interface FlightDocumentInteractiveStateTransitionDescriptor {
  readonly kind: string;
}
export interface FlightDocumentNode {
  interactiveStates${marker}: FlightDocumentInteractiveStates | null;
  transition${marker}: FlightDocumentInteractiveStateTransitionDescriptor | null;
}`,
    '/flight/packages/types/src/index.ts': `export type { FlightDocumentNode } from './FlightDocument.js';`,
  };
}

function createMeshDeformationWorkspaceFiles(mixedAbsence: boolean): Record<string, string> {
  const nullable = mixedAbsence ? ' | null' : '';
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/Mesh.ts': `interface Aabb { readonly minX: number }
interface MeshMorph { readonly weights: Float32Array }
interface Skin { readonly skeleton: object }
export interface Mesh {
  morph?: MeshMorph${nullable};
  skin?: Skin${nullable};
}
export interface MeshDeformRuntime {
  deformedLocalBounds?: Aabb${nullable};
}`,
    '/flight/packages/types/src/index.ts': `export type { Mesh, MeshDeformRuntime } from './Mesh.js';`,
  };
}

function createMeshGeometryFromAttributesWorkspaceFiles(mixedAbsence: boolean): Record<string, string> {
  const nullable = mixedAbsence ? ' | null' : '';
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/MeshGeometryFromAttributesOptions.ts': `export interface MeshGeometryFromAttributesOptions {
  indices?: readonly number[] | Uint16Array | Uint32Array${nullable};
  normals?: readonly number[]${nullable};
  positions: readonly number[];
  uvs?: readonly number[]${nullable};
}`,
    '/flight/packages/types/src/index.ts': `export type { MeshGeometryFromAttributesOptions } from './MeshGeometryFromAttributesOptions.js';`,
  };
}

function createMeshGeometryOptionsWorkspaceFiles(mixedAbsence: boolean): Record<string, string> {
  const nullable = mixedAbsence ? ' | null' : '';
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/MeshGeometryOptions.ts': `export interface MeshGeometryOptions {
  indices?: Readonly<Uint16Array<ArrayBuffer>> | Readonly<Uint32Array<ArrayBuffer>>${nullable};
  vertices: Float32Array<ArrayBuffer>;
}`,
    '/flight/packages/types/src/index.ts': `export type { MeshGeometryOptions } from './MeshGeometryOptions.js';`,
  };
}

function createNotificationWorkspaceFiles(opaque: boolean): Record<string, string> {
  const dataType = opaque ? 'unknown' : 'NotificationData';
  const providerData = opaque ? 'readonly data?: unknown;' : '';
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/Notification.ts': `export type NotificationData =
  | boolean
  | number
  | string
  | null
  | readonly NotificationData[]
  | Readonly<NotificationDataFields>;
export interface NotificationDataFields {
  readonly [name: string]: NotificationData;
}
export interface NotificationRequest { data?: ${dataType} }
export interface WebNotificationOptions { data?: ${dataType} }
export interface WebServiceWorkerNotificationInstance {
  ${providerData}
  readonly tag: string;
}`,
    '/flight/packages/types/src/index.ts': `export type {
  NotificationData,
  NotificationDataFields,
  NotificationRequest,
  WebNotificationOptions,
  WebServiceWorkerNotificationInstance,
} from './Notification.js';`,
  };
}

function createGuiDialogCloseResultWorkspaceFiles(opaque: boolean): Record<string, string> {
  const declaration = opaque
    ? `export type GuiDialogCloseReason = 'accepted' | 'cancelled' | 'dismissed';
export interface GuiDialogCloseResult {
  readonly entryId: string;
  readonly reason: GuiDialogCloseReason;
  readonly value?: unknown;
}`
    : `export interface GuiDialogCloseFields {
  readonly [name: string]: GuiDialogCloseValue;
}
export type GuiDialogCloseValue =
  | boolean
  | number
  | string
  | null
  | readonly GuiDialogCloseValue[]
  | Readonly<GuiDialogCloseFields>;
export type GuiDialogCloseResult =
  | { readonly entryId: string; readonly reason: 'accepted'; readonly value?: GuiDialogCloseValue }
  | { readonly entryId: string; readonly reason: 'cancelled' | 'dismissed' };`;
  const exports = opaque
    ? 'export type { GuiDialogCloseReason, GuiDialogCloseResult }'
    : 'export type { GuiDialogCloseFields, GuiDialogCloseResult, GuiDialogCloseValue }';
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/GuiDialog.ts': declaration,
    '/flight/packages/types/src/index.ts': `${exports} from './GuiDialog.js';`,
  };
}

function createNetResponseBodyWorkspaceFiles(opaque: boolean): Record<string, string> {
  const body = opaque
    ? 'string | unknown | ArrayBuffer | Blob | null'
    : 'string | NetJsonValue | ArrayBuffer | Blob | null';
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/Net.ts': `export type NetJsonValue =
  | boolean
  | number
  | string
  | null
  | readonly NetJsonValue[]
  | Readonly<NetJsonObject>;
export interface NetJsonObject {
  readonly [name: string]: NetJsonValue;
}
export type NetResponseBody = ${body};
export interface NetResponse {
  body: NetResponseBody;
  ok: boolean;
}`,
    '/flight/packages/types/src/index.ts': `export type {
  NetJsonObject,
  NetJsonValue,
  NetResponse,
  NetResponseBody,
} from './Net.js';`,
  };
}

function createHostAppLoopWorkspaceFiles(opaque: boolean): Record<string, string> {
  const handle = opaque ? 'unknown' : 'AppLoopFrameHandle';
  const handleAlias = opaque ? '' : 'export type AppLoopFrameHandle = number;\n';
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/HostAppLoop.ts': `${handleAlias}export interface HostAppLoopCapability {
  requestFrame(callback: (time: number) => void): ${handle};
  cancelFrame(handle: ${handle}): void;
  now(): number;
}`,
    '/flight/packages/types/src/index.ts': opaque
      ? `export type { HostAppLoopCapability } from './HostAppLoop.js';`
      : `export type { AppLoopFrameHandle, HostAppLoopCapability } from './HostAppLoop.js';`,
  };
}

function createHostVideoStreamWorkspaceFiles(opaque: boolean): Record<string, string> {
  const sourceName = opaque ? 'HostVideo' : 'VideoCapabilityBackend';
  const capability = opaque
    ? `export interface HostVideoCapability {
  attachStream?(stream: unknown): HostImageSource | null;
  canPlayType(mimeType: string): boolean;
}`
    : `export interface VideoCapabilityBackend {
  canPlayType(mimeType: string): boolean;
  createVideoElement?(): HostImageSource | null;
}`;
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    [`/flight/packages/types/src/${sourceName}.ts`]: `export interface HostImageSource { readonly id: string }
${capability}`,
    '/flight/packages/types/src/index.ts': opaque
      ? `export type { HostImageSource, HostVideoCapability } from './HostVideo.js';`
      : `export type { HostImageSource, VideoCapabilityBackend } from './VideoCapabilityBackend.js';`,
  };
}

function createLottieDocumentWorkspaceFiles(opaque: boolean): Record<string, string> {
  const unsupportedCharacterData = opaque ? '  chars?: unknown[];\n' : '';
  const unsupportedTextData = opaque ? '  a?: unknown[];\n  m?: unknown;\n  p?: unknown;\n' : '';
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/LottieDocument.ts': `export interface LottieKeyframe<T> {
  readonly s?: T;
  readonly t: number;
}
export interface LottieTextDocument { readonly t: string }
export interface LottieTextData {
  readonly d: { readonly k: readonly LottieKeyframe<LottieTextDocument>[] };
${unsupportedTextData}}
export interface LottieDocument {
${unsupportedCharacterData}  readonly fr: number;
  readonly h: number;
  readonly ip: number;
  readonly layers: readonly string[];
  readonly op: number;
  readonly w: number;
}`,
    '/flight/packages/types/src/index.ts': `export type {
  LottieDocument,
  LottieKeyframe,
  LottieTextData,
  LottieTextDocument,
} from './LottieDocument.js';`,
  };
}

function createNativeSurfaceHandleWorkspaceFiles(opaque: boolean): Record<string, string> {
  const handle = opaque ? 'unknown' : "Entity & { readonly __brand: 'NativeSurfaceHandle' }";
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/Surface.ts': `export interface Entity { readonly uid: string }
export type NativeSurfaceHandle = ${handle};
export interface SurfaceRuntime {
  readonly handle: NativeSurfaceHandle;
}`,
    '/flight/packages/types/src/index.ts': `export type { Entity, NativeSurfaceHandle, SurfaceRuntime } from './Surface.js';`,
  };
}

function createNativeWindowHandleWorkspaceFiles(opaque: boolean): Record<string, string> {
  const handle = opaque ? 'unknown' : "Entity & { readonly __brand: 'NativeWindowHandle' }";
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/AppWindow.ts': `export interface Entity { readonly uid: string }
export type NativeWindowHandle = ${handle};
export interface HostWindowAttachCapability {
  attach(handle: NativeWindowHandle): boolean;
}`,
    '/flight/packages/types/src/index.ts': `export type {
  Entity,
  HostWindowAttachCapability,
  NativeWindowHandle,
} from './AppWindow.js';`,
  };
}

function createTrayCreateResultWorkspaceFiles(opaque: boolean): Record<string, string> {
  const error = opaque ? 'error?: unknown' : 'error: TrayErrorPayload | null';
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/Tray.ts': `export interface TrayErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly operation: string;
}
export type TrayCreateProviderResult =
  | { readonly outcome: 'created' }
  | { readonly outcome: 'cancelled' }
  | { readonly ${error}; readonly outcome: 'runtime-api-unavailable' }
  | { readonly ${error}; readonly outcome: 'invalid-icon' }
  | { readonly ${error}; readonly outcome: 'tray-create-failed' };`,
    '/flight/packages/types/src/index.ts': `export type {
  TrayCreateProviderResult,
  TrayErrorPayload,
} from './Tray.js';`,
  };
}

function createScene3DRenderProxyWorkspaceFiles(mixedAbsence: boolean): Record<string, string> {
  const marker = mixedAbsence ? '?' : '';
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/Scene3DRenderProxy.ts': `interface ColorScaleBias { readonly redScale: number }
export interface Scene3DRenderProxy {
  alpha?: number;
  colorMatrix${marker}: readonly number[] | null;
  colorScaleBias${marker}: Readonly<ColorScaleBias> | null;
  instanceColors${marker}: Readonly<Float32Array> | null;
  instanceCount?: number;
  instanceMatrices${marker}: Readonly<Float32Array> | null;
  jointMatrices${marker}: Readonly<Float32Array> | null;
  normalMatrices${marker}: Readonly<Float32Array> | null;
}`,
    '/flight/packages/types/src/index.ts': `export type { Scene3DRenderProxy } from './Scene3DRenderProxy.js';`,
  };
}

function createScene2DResourceWorkspaceFiles(mixedAbsence: boolean): Record<string, string> {
  const nullable = mixedAbsence ? ' | null' : '';
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/Scene2DResources.ts': `interface AudioContext {
  decodeAudioData(buffer: ArrayBuffer): Promise<object>;
}
export interface Scene2DDocumentLoadOptions {
  mimeType?: string${nullable};
}
export interface LoadScene2DAudioResourcesOptions {
  context?: AudioContext${nullable};
}`,
    '/flight/packages/types/src/index.ts': `export type {
  LoadScene2DAudioResourcesOptions,
  Scene2DDocumentLoadOptions,
} from './Scene2DResources.js';`,
  };
}

function createBitmapTextOptionsWorkspaceFiles(mixedAbsence: boolean): Record<string, string> {
  const nullable = mixedAbsence ? ' | null' : '';
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/BitmapText.ts': `export interface BitmapTextOptions {
  align?: 'center' | 'justify' | 'left' | 'right';
  maxLines?: number${nullable};
  wrapWidth?: number${nullable};
}`,
    '/flight/packages/types/src/index.ts': `export type { BitmapTextOptions } from './BitmapText.js';`,
  };
}

function createCapacitorPositionCoordsWorkspaceFiles(mixedAbsence: boolean): Record<string, string> {
  const unavailable = mixedAbsence ? 'number | null | undefined' : 'number | null';
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/CapacitorApi.ts': `export interface CapacitorPositionCoords {
  accuracy: number;
  altitude: number | null;
  altitudeAccuracy: ${unavailable};
  heading: number | null;
  latitude: number;
  longitude: number;
  speed: number | null;
}`,
    '/flight/packages/types/src/index.ts': `export type { CapacitorPositionCoords } from './CapacitorApi.js';`,
  };
}

function createGltfImportOptionsWorkspaceFiles(mixedAbsence: boolean): Record<string, string> {
  const nullable = mixedAbsence ? ' | null' : '';
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/GltfExtension.ts': `export interface GltfImportOptions {
  basePath?: string${nullable};
}`,
    '/flight/packages/types/src/index.ts': `export type { GltfImportOptions } from './GltfExtension.js';`,
  };
}

function createTextureOptionsWorkspaceFiles(mixedAbsence: boolean): Record<string, string> {
  const nullable = mixedAbsence ? ' | null' : '';
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/CreateTextureOptions.ts': `export interface ImageResourceReference {
  readonly kind: string;
}
export type CreateTextureOptions = {
  readonly resource?: ImageResourceReference${nullable};
};`,
    '/flight/packages/types/src/index.ts': `export type {
  CreateTextureOptions,
  ImageResourceReference,
} from './CreateTextureOptions.js';`,
  };
}

function createTreeViewControllerOptionsWorkspaceFiles(mixedAbsence: boolean): Record<string, string> {
  const nullable = mixedAbsence ? ' | null' : '';
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/TreeViewController.ts': `interface GuiControllerOptions {
  transition?: string;
}
export interface TreeViewControllerItem {
  readonly id: number;
}
export interface TreeViewControllerOptions extends GuiControllerOptions {
  items: readonly Readonly<TreeViewControllerItem>[];
  selectedItem?: TreeViewControllerItem${nullable};
}`,
    '/flight/packages/types/src/index.ts': `export type {
  TreeViewControllerItem,
  TreeViewControllerOptions,
} from './TreeViewController.js';`,
  };
}

function createAttachment2DWorkspaceFiles(mixedAbsence: boolean): Record<string, string> {
  const marker = mixedAbsence ? '?' : '';
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/Attachment2D.ts': `export interface Attachment2D {
  kind: string;
  name${marker}: string | null;
}`,
    '/flight/packages/types/src/index.ts': `export type { Attachment2D } from './Attachment2D.js';`,
  };
}

function createMaterialWorkspaceFiles(mixedAbsence: boolean): Record<string, string> {
  const marker = mixedAbsence ? '?' : '';
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/Material.ts': `interface Entity { readonly id: number }
export interface Material extends Entity {
  readonly kind: string;
  name${marker}: string | null;
}`,
    '/flight/packages/types/src/index.ts': `export type { Material } from './Material.js';`,
  };
}

function createBoundingBoxAttachment2DWorkspaceFiles(mixedAbsence: boolean): Record<string, string> {
  const marker = mixedAbsence ? '?' : '';
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/BoundingBoxAttachment2D.ts': `interface Attachment2D { readonly kind: string }
interface Skin2D { readonly influenceCounts: Uint16Array; readonly influences: Float32Array }
export interface BoundingBoxAttachment2D extends Attachment2D {
  kind: 'BoundingBoxAttachment2D';
  pointCount: number;
  skin${marker}: Skin2D | null;
  vertices${marker}: Float32Array | null;
}`,
    '/flight/packages/types/src/index.ts': `export type { BoundingBoxAttachment2D } from './BoundingBoxAttachment2D.js';`,
  };
}

function createClippingAttachment2DWorkspaceFiles(mixedAbsence: boolean): Record<string, string> {
  const marker = mixedAbsence ? '?' : '';
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/ClippingAttachment2D.ts': `interface Attachment2D { readonly kind: string }
interface Skin2D { readonly influenceCounts: Uint16Array; readonly influences: Float32Array }
export interface ClippingAttachment2D extends Attachment2D {
  endSlotIndex: number;
  kind: 'ClippingAttachment2D';
  pointCount: number;
  skin${marker}: Skin2D | null;
  vertices${marker}: Float32Array | null;
}`,
    '/flight/packages/types/src/index.ts': `export type { ClippingAttachment2D } from './ClippingAttachment2D.js';`,
  };
}

function createCamera3DOptionsWorkspaceFiles(mixedAbsence: boolean): Record<string, string> {
  const nullable = mixedAbsence ? ' | null' : '';
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/Camera3DOptions.ts': `interface Plane { readonly a: number }
export interface Camera3DOptions {
  far: number;
  near: number;
  nearClipPlane?: Plane${nullable};
}`,
    '/flight/packages/types/src/index.ts': `export type { Camera3DOptions } from './Camera3DOptions.js';`,
  };
}

function createEnvironmentOptionsWorkspaceFiles(mixedAbsence: boolean): Record<string, string> {
  const nullable = mixedAbsence ? ' | null' : '';
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/EnvironmentOptions.ts': `interface Texture { readonly version: number }
export interface EnvironmentOptions {
  enabled?: boolean;
  environment?: Texture${nullable};
  intensity?: number;
}`,
    '/flight/packages/types/src/index.ts': `export type { EnvironmentOptions } from './EnvironmentOptions.js';`,
  };
}

function createCanvasRenderStateWorkspaceFiles(mixedAbsence: boolean): Record<string, string> {
  const nullable = mixedAbsence ? ' | null' : '';
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/CanvasRenderState.ts': `export interface CanvasRenderState {}
export type BlendMode = 'normal' | 'add';
export interface CanvasRenderRegistries {
  blendModeApplication?: ((state: CanvasRenderState, blendMode: BlendMode | null) => void)${nullable};
}`,
    '/flight/packages/types/src/index.ts': `export type {
  BlendMode,
  CanvasRenderRegistries,
  CanvasRenderState,
} from './CanvasRenderState.js';`,
  };
}

function createMeshAttachment2DWorkspaceFiles(mixedAbsence: boolean): Record<string, string> {
  const marker = mixedAbsence ? '?' : '';
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/MeshAttachment2D.ts': `interface Attachment2D { readonly kind: string }
interface Skin2D { readonly influenceCounts: Uint16Array; readonly influences: Float32Array }
export interface MeshAttachment2D extends Attachment2D {
  skin${marker}: Skin2D | null;
  triangles: Uint16Array;
  uvs: Float32Array;
  vertexCount: number;
  vertices${marker}: Float32Array | null;
}`,
    '/flight/packages/types/src/index.ts': `export type { MeshAttachment2D } from './MeshAttachment2D.js';`,
  };
}

function createPathAttachment2DWorkspaceFiles(mixedAbsence: boolean): Record<string, string> {
  const marker = mixedAbsence ? '?' : '';
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/PathAttachment2D.ts': `interface Attachment2D { readonly kind: string }
interface Skin2D { readonly influenceCounts: Uint16Array; readonly influences: Float32Array }
export interface PathAttachment2D extends Attachment2D {
  commands: number[];
  kind: 'PathAttachment2D';
  pointCount: number;
  skin${marker}: Skin2D | null;
  vertices${marker}: Float32Array | null;
}`,
    '/flight/packages/types/src/index.ts': `export type { PathAttachment2D } from './PathAttachment2D.js';`,
  };
}

function createSlot2DWorkspaceFiles(mixedAbsence: boolean): Record<string, string> {
  const marker = mixedAbsence ? '?' : '';
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/Slot2D.ts': `interface Attachment2D { readonly kind: string }
interface Skeleton2DSlotDeform { readonly offsets: Float32Array }
export interface Slot2D {
  attachment${marker}: Attachment2D | null;
  deform${marker}: Skeleton2DSlotDeform | null;
  boneIndex: number;
  name${marker}: string | null;
}`,
    '/flight/packages/types/src/index.ts': `export type { Slot2D } from './Slot2D.js';`,
  };
}

function createSkeleton2DSlotAnimationTargetWorkspaceFiles(mixedAbsence: boolean): Record<string, string> {
  const marker = mixedAbsence ? '?' : '';
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/Skeleton2DSlotAnimationTarget.ts': `interface Attachment2D { readonly kind: string }
interface Entity { readonly id: number }
export interface Skeleton2DSlotAnimationTarget extends Entity {
  attachments${marker}: readonly (Attachment2D | null)[] | null;
  kind: string;
  path: 'Attachment' | 'Color';
  slotIndex: number;
}`,
    '/flight/packages/types/src/index.ts': `export type { Skeleton2DSlotAnimationTarget } from './Skeleton2DSlotAnimationTarget.js';`,
  };
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

function createCyclicTypesWorkspaceFiles(): Record<string, string> {
  return {
    '/flight/packages/types/package.json': createPackageManifest('@flighthq/types'),
    '/flight/packages/types/src/App.ts':
      "import type { Bad } from './Bad.js'; import type { Child } from './Child.js'; export interface App { bad: Bad; child: Child; }",
    '/flight/packages/types/src/Bad.ts': 'export interface Bad { reason: string; }',
    '/flight/packages/types/src/Child.ts': "import type { App } from './App.js'; export interface Child { app: App; }",
    '/flight/packages/types/src/index.ts':
      "export type { App } from './App.js'; export type { Bad } from './Bad.js'; export type { Child } from './Child.js';",
  };
}
