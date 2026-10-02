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
    expect(sourcePortability.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      expectedSubjects.map((subject) => ({ rule: 'mixed-absence', subject })),
    );
    expect(
      sourcePortability.findings.every(({ message }) =>
        message.includes('WebGPU instead packs instance colors beside matrices in one instance buffer'),
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
    expect(analyzeTypeScriptSourcePortability(portableInput.sources).findings).toEqual([]);
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
      expect.stringContaining('GL and WebGPU draw the geometry that preparation updates'),
      expect.stringContaining('the WebGPU skin adapter returns false for skin == null'),
      expect.stringContaining('Shared culling before GL or WebGPU draws falls back with ?? to geometry bounds'),
    ]);
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
