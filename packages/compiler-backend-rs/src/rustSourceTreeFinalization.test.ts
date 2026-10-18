import ts from 'typescript';

import { createCompilerGeneratedFileHeader } from '../../compiler-emission/src/index.js';
import { createCompilerModuleEvaluationPlan } from '../../compiler-module/src/index.js';
import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type {
  CompilerBackendModuleFile,
  CompilerBackendPackageGraphFinalization,
  CompilerModuleFacadePlan,
  CompilerModuleIdentity,
  CompilerModuleResolutionPlan,
  CompilerRustModuleEvaluationEmissionFragment,
  CompilerRustSourceTreeFinalizationFailureCode,
  CompilerRustSourceTreeModuleReemissionRequest,
  CompilerRustSourceTreePlan,
  IrModule,
} from '../../compiler-types/src/index.js';
import {
  createCompilerRustSourceTreeFinalization,
  emitEmittedFileSourceFragmentRust,
  isCompilerRustSourceTreeFinalizationFailure,
} from './rustSourceTreeFinalization.js';

const emptyModuleEvaluation = createCompilerModuleEvaluationPlan({ dependencies: [], entries: [], modules: [] });
const emptyModuleResolution: CompilerModuleResolutionPlan = {
  edges: [],
  schema: 'flight-compiler-module-resolution/1',
};

describe('createCompilerRustSourceTreeFinalization', () => {
  it('re-emits exact source owners and creates deterministic skeletons from one canonical plan', () => {
    const root = lower(
      '@scope/math',
      'index.ts',
      "import { point } from './geometry/shapes/point.js'; export { point };",
    );
    const point = lower('@scope/math', 'geometry/shapes/point.ts', 'export const point = 1;');
    const privateValue = lower('@scope/math', 'internal/value.ts', 'export const privateValue = 2;');
    const refused = lower('@scope/math', 'refused.ts', 'export const refused = 3;');
    const filtered = lower('@scope/math', 'filtered.ts', 'export const filtered = 4;');
    const resolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          importer: identity(root),
          specifier: './geometry/shapes/point.js',
          target: identity(point),
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const finalization: CompilerBackendPackageGraphFinalization = {
      facade: createFacade([point]),
      moduleEvaluation: emptyModuleEvaluation,
      moduleFiles: [
        retained(privateValue, 'legacy/private.rs'),
        retained(point, 'lib.rs'),
        retained(root, 'geometry/shapes/point.rs'),
      ],
    };
    const semanticModules = [filtered, privateValue, refused, point, root];
    const finalizationSnapshot = structuredClone(finalization);
    const moduleSnapshot = structuredClone(semanticModules);
    const resolutionSnapshot = structuredClone(resolution);
    const first = finalize(finalization, semanticModules, resolution);
    const second = finalize(
      { ...finalization, moduleFiles: [...finalization.moduleFiles].reverse() },
      [...semanticModules].reverse(),
      { ...resolution, edges: [...resolution.edges].reverse() },
    );

    expect(second.result).toEqual(first.result);
    expect(second.calls).toEqual(first.calls);
    expect(isDeeplyFrozen(first.result, new WeakSet())).toBe(true);
    expect(first.calls.map(({ module }) => module)).toEqual([point.name, privateValue.name, root.name]);
    expect(first.calls.some(({ module }) => module === refused.name || module === filtered.name)).toBe(false);
    expect(first.calls.find(({ module }) => module === root.name)).toEqual({
      module: root.name,
      references: [['./geometry/shapes/point.js', 'crate::geometry::shapes::point']],
      sourceFragment: 'pub mod geometry;\npub(crate) mod internal;',
      targetPath: 'lib.rs',
    });

    const rootReplacement = first.result.moduleFileReplacements?.find(
      (replacement) => replacement.module.name === root.name,
    );
    const pointReplacement = first.result.moduleFileReplacements?.find(
      (replacement) => replacement.module.name === point.name,
    );
    expect(rootReplacement).toMatchObject({
      file: { dependencies: [`generated/${root.name}`], path: 'lib.rs' },
      module: identity(root),
      retainedPath: 'geometry/shapes/point.rs',
    });
    expect(rootReplacement?.file.contents).toBe(
      `${createCompilerGeneratedFileHeader(root, '//')}\n` +
        '#![allow(dead_code)]\n' +
        '#![forbid(unsafe_code)]\n' +
        'pub mod geometry;\n' +
        'pub(crate) mod internal;\n\n' +
        `pub fn emitted_${root.name.toLowerCase()}() {}\n`,
    );
    expect(pointReplacement).toMatchObject({
      file: { path: 'geometry/shapes/point.rs' },
      module: identity(point),
      retainedPath: 'lib.rs',
    });
    expect(first.result.packageFiles.map(({ file }) => file.path)).toEqual([
      'geometry/mod.rs',
      'geometry/shapes/mod.rs',
      'internal/mod.rs',
    ]);
    expect(first.result.packageFiles).toContainEqual({
      file: { contents: 'pub mod shapes;\n', path: 'geometry/mod.rs' },
      owner: { kind: 'package', packageName: '@scope/math' },
      provenance: [identity(point)],
    });
    expect(first.result.packageFiles).toContainEqual({
      file: { contents: 'pub(crate) mod value;\n', path: 'internal/mod.rs' },
      owner: { kind: 'package', packageName: '@scope/math' },
      provenance: [identity(privateValue)],
    });
    expect(first.result.packageFiles.some(({ file }) => /Cargo\.(?:toml|lock)$/u.test(file.path))).toBe(false);
    expect(finalization).toEqual(finalizationSnapshot);
    expect(semanticModules).toEqual(moduleSnapshot);
    expect(resolution).toEqual(resolutionSnapshot);
  });

  it('fails loudly on missing or duplicate semantic owners and plan/file mismatches', () => {
    const root = lower('@scope/math', 'index.ts', 'export const root = 1;');
    const finalization: CompilerBackendPackageGraphFinalization = {
      facade: createFacade([root]),
      moduleEvaluation: emptyModuleEvaluation,
      moduleFiles: [retained(root, 'legacy.rs')],
    };
    const reemitModule = ({ module, sourceFile }: Readonly<CompilerRustSourceTreeModuleReemissionRequest>) => ({
      contents: `${createCompilerGeneratedFileHeader(module, '//')}\n#![forbid(unsafe_code)]\n`,
      path: sourceFile.filePath,
    });

    expectFinalizationFailure(
      () => createCompilerRustSourceTreeFinalization({ finalization, reemitModule, semanticModules: [] }),
      'rust-source-tree-finalization-missing-retained-module',
    );
    expectFinalizationFailure(
      () =>
        createCompilerRustSourceTreeFinalization({
          finalization,
          reemitModule,
          semanticModules: [{ ...root, source: root.source.replace('/src/', '/src/./') }],
        }),
      'rust-source-tree-finalization-missing-retained-module',
    );
    expectFinalizationFailure(
      () =>
        createCompilerRustSourceTreeFinalization({
          finalization,
          reemitModule,
          semanticModules: [root, structuredClone(root)],
        }),
      'rust-source-tree-finalization-duplicate-retained-module',
    );
    expectFinalizationFailure(
      () =>
        createCompilerRustSourceTreeFinalization({
          finalization: {
            ...finalization,
            moduleFiles: [retained(root, 'first.rs'), retained(root, 'second.rs')],
          },
          reemitModule,
          semanticModules: [root],
        }),
      'rust-source-tree-finalization-module-file-mismatch',
    );
    expectFinalizationFailure(
      () =>
        createCompilerRustSourceTreeFinalization({
          finalization,
          reemitModule: ({ module }) => ({
            contents: `${createCompilerGeneratedFileHeader(module, '//')}\n#![forbid(unsafe_code)]\n`,
            path: 'wrong.rs',
          }),
          semanticModules: [root],
        }),
      'rust-source-tree-finalization-module-file-mismatch',
    );
  });

  it('routes root and nested emission fragments after declarations and crate attributes exactly once', () => {
    const root = lower('@scope/math', 'index.ts', 'export const root = 1;');
    const nested = lower('@scope/math', 'feature/item.ts', 'export const item = 2;');
    const finalization: CompilerBackendPackageGraphFinalization = {
      facade: createFacade([root, nested]),
      moduleEvaluation: emptyModuleEvaluation,
      moduleFiles: [retained(root, 'legacy-root.rs'), retained(nested, 'legacy-item.rs')],
    };
    const fragments = [
      createRootEmissionFragment(
        '@scope/math',
        'use flight_runtime::FlightModuleEvaluationError;\npub fn __flight_instantiate_group_0() {}\npub fn __flight_evaluate_group_0() {}',
        'lib.rs',
      ),
      createModuleEmissionFragment(
        '@scope/math',
        ['feature', 'item'],
        'feature/item.rs',
        'enum __FlightModuleEvaluationState { Uninstantiated }\npub(crate) fn __flight_instantiate_once() {}\npub(crate) fn __flight_evaluate_once() {}',
      ),
    ];

    const first = finalize(finalization, [nested, root], emptyModuleResolution, undefined, () => fragments);
    const repeat = finalize(
      { ...finalization, moduleFiles: [...finalization.moduleFiles].reverse() },
      [root, nested],
      emptyModuleResolution,
      undefined,
      () => [...fragments].reverse(),
    );

    expect(repeat.result).toEqual(first.result);
    const rootContents = first.result.moduleFileReplacements?.find((replacement) => replacement.file.path === 'lib.rs')
      ?.file.contents;
    const nestedContents = first.result.moduleFileReplacements?.find(
      (replacement) => replacement.file.path === 'feature/item.rs',
    )?.file.contents;
    expect(rootContents).toContain(
      '#![forbid(unsafe_code)]\npub mod feature;\nuse flight_runtime::FlightModuleEvaluationError;\n',
    );
    expect(countText(rootContents ?? '', 'pub mod feature;')).toBe(1);
    expect(countText(rootContents ?? '', 'use flight_runtime::FlightModuleEvaluationError;')).toBe(1);
    expect(countText(rootContents ?? '', 'pub fn __flight_instantiate_group_0()')).toBe(1);
    expect(countText(rootContents ?? '', 'pub fn __flight_evaluate_group_0()')).toBe(1);
    expect(nestedContents).toContain(
      '#![forbid(unsafe_code)]\nenum __FlightModuleEvaluationState { Uninstantiated }\n',
    );
    expect(countText(nestedContents ?? '', 'enum __FlightModuleEvaluationState')).toBe(1);
    expect(countText(nestedContents ?? '', 'pub(crate) fn __flight_instantiate_once()')).toBe(1);
    expect(countText(nestedContents ?? '', 'pub(crate) fn __flight_evaluate_once()')).toBe(1);
    expect(first.result.packageFiles).toContainEqual({
      file: { contents: 'pub mod item;\n', path: 'feature/mod.rs' },
      owner: { kind: 'package', packageName: '@scope/math' },
      provenance: [identity(nested)],
    });
  });

  it('routes a fileless crate-root fragment to the unique skeleton after its declarations', () => {
    const alpha = lower('@scope/math', 'alpha.ts', 'export const alpha = 1;');
    const beta = lower('@scope/math', 'beta.ts', 'export const beta = 2;');
    const outcome = finalize(
      {
        facade: createFacade([alpha, beta]),
        moduleEvaluation: emptyModuleEvaluation,
        moduleFiles: [retained(beta, 'old-beta.rs'), retained(alpha, 'old-alpha.rs')],
      },
      [beta, alpha],
      emptyModuleResolution,
      undefined,
      () => [
        createRootEmissionFragment(
          '@scope/math',
          'pub fn __flight_instantiate_group_0() {}\npub fn __flight_instantiate_group_1() {}',
        ),
      ],
    );

    expect(outcome.result.packageFiles).toContainEqual({
      file: {
        contents:
          'pub mod alpha;\n' +
          'pub mod beta;\n' +
          'pub fn __flight_instantiate_group_0() {}\n' +
          'pub fn __flight_instantiate_group_1() {}\n',
        path: 'lib.rs',
      },
      owner: { kind: 'package', packageName: '@scope/math' },
      provenance: [identity(alpha), identity(beta)],
    });
  });

  it('rejects missing, duplicate, path-mismatched, and wrongly owned emission targets', () => {
    const root = lower('@scope/math', 'index.ts', 'export const root = 1;');
    const nested = lower('@scope/math', 'feature/item.ts', 'export const item = 2;');
    const finalization: CompilerBackendPackageGraphFinalization = {
      facade: createFacade([root, nested]),
      moduleEvaluation: emptyModuleEvaluation,
      moduleFiles: [retained(root, 'old-root.rs'), retained(nested, 'old-item.rs')],
    };
    const cases: readonly Readonly<{
      code: CompilerRustSourceTreeFinalizationFailureCode;
      fragments: readonly Readonly<CompilerRustModuleEvaluationEmissionFragment>[];
    }>[] = [
      {
        code: 'rust-source-tree-finalization-emission-target-missing',
        fragments: [createModuleEmissionFragment('@scope/math', ['absent'], 'absent.rs', 'fn absent() {}')],
      },
      {
        code: 'rust-source-tree-finalization-emission-target-duplicate',
        fragments: [
          createRootEmissionFragment('@scope/math', 'fn first() {}', 'lib.rs'),
          createRootEmissionFragment('@scope/math', 'fn second() {}', 'lib.rs'),
        ],
      },
      {
        code: 'rust-source-tree-finalization-emission-target-path-mismatch',
        fragments: [createModuleEmissionFragment('@scope/math', ['feature', 'item'], 'wrong.rs', 'fn wrong() {}')],
      },
      {
        code: 'rust-source-tree-finalization-emission-target-ownership-mismatch',
        fragments: [createModuleEmissionFragment('@scope/math', ['feature'], 'feature/mod.rs', 'fn skeleton() {}')],
      },
    ];

    for (const { code, fragments } of cases) {
      expectFinalizationFailure(
        () => finalize(finalization, [root, nested], emptyModuleResolution, undefined, () => fragments),
        code,
      );
    }
  });

  it('rejects lifecycle emission for a placeholder root without changing placeholder behavior', () => {
    const root = lower('@scope/math', 'index.ts', 'export const root = 1;');
    const finalization: CompilerBackendPackageGraphFinalization = {
      facade: createFacade([root]),
      moduleEvaluation: emptyModuleEvaluation,
      moduleFiles: [],
      placeholderModules: [root],
      refusals: [{ code: 'rust-placeholder-test', message: 'root refused', module: identity(root) }],
    };

    expectFinalizationFailure(
      () =>
        finalize(finalization, [root], emptyModuleResolution, undefined, () => [
          createRootEmissionFragment('@scope/math', 'fn forbidden() {}', 'lib.rs'),
        ]),
      'rust-source-tree-finalization-emission-target-ownership-mismatch',
    );
    const unchanged = finalize(finalization, [root], emptyModuleResolution);
    expect(unchanged.result.moduleFileReplacements).toEqual([]);
    expect(unchanged.result.packageFiles).toEqual([]);
    expect(unchanged.calls).toEqual([]);
  });
});

describe('emitEmittedFileSourceFragmentRust', () => {
  it('inserts declarations after generated headers and all crate-level inner attributes', () => {
    const file = {
      contents:
        '// Generated by @flighthq/tool-compiler from @scope/math/src/index.ts#Index. Do not edit.\r\n' +
        '#![allow(dead_code)]\r\n' +
        '#![forbid(unsafe_code)]\r\n\r\n' +
        'pub fn root() {}\r\n',
      dependencies: ['runtime'],
      path: 'lib.rs',
    };
    const snapshot = structuredClone(file);

    expect(emitEmittedFileSourceFragmentRust(file, 'pub mod api;\r\nmod internal;')).toEqual({
      contents:
        '// Generated by @flighthq/tool-compiler from @scope/math/src/index.ts#Index. Do not edit.\n' +
        '#![allow(dead_code)]\n' +
        '#![forbid(unsafe_code)]\n' +
        'pub mod api;\n' +
        'mod internal;\n\n' +
        'pub fn root() {}\n',
      dependencies: ['runtime'],
      path: 'lib.rs',
    });
    expect(file).toEqual(snapshot);
    expect(emitEmittedFileSourceFragmentRust(file, '')).toEqual({
      contents:
        '// Generated by @flighthq/tool-compiler from @scope/math/src/index.ts#Index. Do not edit.\n' +
        '#![allow(dead_code)]\n' +
        '#![forbid(unsafe_code)]\n\n' +
        'pub fn root() {}\n',
      dependencies: ['runtime'],
      path: 'lib.rs',
    });
  });

  it('fails loudly when a fragment cannot follow the generated header and crate attributes', () => {
    const header = '// Generated by @flighthq/tool-compiler from @scope/math/src/index.ts#Index. Do not edit.';
    const invalidInputs = [
      { contents: '#![forbid(unsafe_code)]\npub fn root() {}', fragment: 'mod child;' },
      { contents: `${header}\n#![forbid(unsafe_code)\npub fn root() {}`, fragment: 'mod child;' },
      { contents: `${header}\npub fn root() {}\n#![forbid(unsafe_code)]`, fragment: 'mod child;' },
      { contents: `${header}\n#![forbid(unsafe_code)]`, fragment: '#![allow(dead_code)]' },
    ];
    for (const input of invalidInputs) {
      expectFinalizationFailure(
        () => emitEmittedFileSourceFragmentRust({ contents: input.contents, path: 'lib.rs' }, input.fragment),
        'rust-source-tree-finalization-invalid-fragment-placement',
      );
    }
  });

  it('plans placeholder-backed modules as declared import targets and leaves strict plans alone', () => {
    const root = lower('@scope/math', 'consumer.ts', "import { convert } from './provider.js'; export { convert };");
    const provider = lower(
      '@scope/math',
      'provider.ts',
      'export function convert(value: unknown): unknown { return value; }',
    );
    const resolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          importer: identity(root),
          specifier: './provider.js',
          target: identity(provider),
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const base = {
      facade: createFacade([root]),
      moduleEvaluation: emptyModuleEvaluation,
      moduleFiles: [retained(root, 'consumer.rs')],
      refusals: [{ code: 'rust-placeholder-test', message: 'provider refused', module: identity(provider) }],
    } satisfies CompilerBackendPackageGraphFinalization;
    let plan: Readonly<CompilerRustSourceTreePlan> | undefined;
    const placeholderRun = finalize(
      { ...base, placeholderModules: [provider] },
      [root, provider],
      resolution,
      (observed) => {
        plan = observed;
      },
    );

    expect(placeholderRun.calls.map(({ module }) => module)).toEqual([root.name]);
    expect(plan?.modules).toContainEqual({
      filePath: 'provider.rs',
      identity: identity(provider),
      modulePath: ['provider'],
    });
    expect(plan?.files.find((file) => file.filePath === 'provider.rs')?.ownership).toEqual({
      kind: 'placeholder',
      module: identity(provider),
    });
    expect(plan?.references).toContainEqual({
      from: identity(root),
      rustPath: 'crate::provider',
      specifier: './provider.js',
      target: identity(provider),
    });
    expect(placeholderRun.result.packageFiles.map(({ file }) => file.path)).toEqual(['lib.rs']);
    expect(placeholderRun.result.packageFiles[0]?.file.contents).toBe('pub mod consumer;\npub(crate) mod provider;\n');
    expect(placeholderRun.result.moduleFileReplacements?.map(({ file }) => file.path)).toEqual(['consumer.rs']);

    const publicRun = finalize(
      { ...base, facade: createFacade([root, provider]), placeholderModules: [provider] },
      [root, provider],
      resolution,
    );
    expect(publicRun.result.packageFiles[0]?.file.contents).toBe('pub mod consumer;\npub mod provider;\n');

    let strictFailure: unknown;
    try {
      finalize(base, [root, provider], resolution);
    } catch (error) {
      strictFailure = error;
    }
    expect(strictFailure).toMatchObject({
      code: 'rust-source-tree-import-target-refused',
      kind: 'rust-source-tree-planning',
    });

    expectFinalizationFailure(
      () =>
        createCompilerRustSourceTreeFinalization({
          finalization: {
            ...base,
            moduleFiles: [retained(root, 'consumer.rs'), retained(provider, 'provider.rs')],
            placeholderModules: [provider],
          },
          moduleResolution: resolution,
          semanticModules: [root, provider],
          reemitModule() {
            throw new Error('finalization must reject a retained placeholder before re-emission');
          },
        }),
      'rust-source-tree-finalization-placeholder-retained',
    );
  });

  it('keeps planned child module declarations in a refused directory-index placeholder', () => {
    const index = lower('@scope/math', 'geometry/index.ts', "export { answer } from './tools.js';");
    const tools = lower('@scope/math', 'geometry/tools.ts', 'export const answer = 1;');
    const resolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          importer: identity(index),
          specifier: './tools.js',
          target: identity(tools),
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    let plan: Readonly<CompilerRustSourceTreePlan> | undefined;
    const outcome = finalize(
      {
        facade: createFacade([tools]),
        moduleEvaluation: emptyModuleEvaluation,
        moduleFiles: [retained(tools, 'geometry/tools.rs')],
        placeholderModules: [index],
        refusals: [{ code: 'rust-placeholder-test', message: 'index refused', module: identity(index) }],
      },
      [index, tools],
      resolution,
      (observed) => {
        plan = observed;
      },
    );

    const placeholderFile = plan?.files.find((file) => file.filePath === 'geometry/mod.rs');
    expect(placeholderFile?.ownership).toEqual({ kind: 'placeholder', module: identity(index) });
    expect(placeholderFile?.sourceFragment).toBe('pub mod tools;');
    expect(outcome.result.packageFiles.map(({ file }) => file.path)).toEqual(['lib.rs']);
    expect(outcome.result.packageFiles[0]?.file.contents).toBe('pub mod geometry;\n');
    expect(outcome.result.moduleFileReplacements?.map(({ file }) => file.path)).toEqual(['geometry/tools.rs']);
  });
});

describe('isCompilerRustSourceTreeFinalizationFailure', () => {
  it('recognizes complete finalization failures and rejects lookalikes', () => {
    const failure = Object.assign(new Error('missing'), {
      code: 'rust-source-tree-finalization-missing-retained-module',
      kind: 'rust-source-tree-finalization',
      subjects: ['@scope/math/src/value.ts#Value'],
    });

    expect(isCompilerRustSourceTreeFinalizationFailure(failure)).toBe(true);
    expect(isCompilerRustSourceTreeFinalizationFailure({ ...failure })).toBe(false);
    expect(
      isCompilerRustSourceTreeFinalizationFailure(Object.assign(new Error('empty'), { ...failure, subjects: [] })),
    ).toBe(false);
    expect(
      isCompilerRustSourceTreeFinalizationFailure(
        Object.assign(new Error('unknown'), { ...failure, code: 'rust-source-tree-finalization-unknown' }),
      ),
    ).toBe(false);
  });
});

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

function createModuleEmissionFragment(
  packageName: string,
  modulePath: readonly [string, ...string[]],
  filePath: string,
  source: string,
): CompilerRustModuleEvaluationEmissionFragment {
  return {
    locator: {
      crate: createRustCrateIdentity(packageName),
      filePath,
      kind: 'module',
      modulePath,
      packageName,
    },
    source,
    symbols: [],
  };
}

function createRootEmissionFragment(
  packageName: string,
  source: string,
  filePath?: string,
): CompilerRustModuleEvaluationEmissionFragment {
  return {
    locator: {
      crate: createRustCrateIdentity(packageName),
      ...(filePath === undefined ? {} : { filePath }),
      kind: 'crate-root',
      modulePath: [],
      packageName,
    },
    source,
    symbols: [],
  };
}

function createRustCrateIdentity(packageName: string) {
  const cargoName = packageName.replace('@', '').replace('/', '-');
  return { cargoName, packageName, rustName: cargoName.replaceAll('-', '_') };
}

function countText(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

function expectFinalizationFailure(
  operation: () => unknown,
  code: CompilerRustSourceTreeFinalizationFailureCode,
): void {
  let failure: unknown;
  try {
    operation();
  } catch (error) {
    failure = error;
  }
  expect(isCompilerRustSourceTreeFinalizationFailure(failure)).toBe(true);
  if (!isCompilerRustSourceTreeFinalizationFailure(failure)) throw failure;
  expect(failure.code).toBe(code);
}

function finalize(
  finalization: Readonly<CompilerBackendPackageGraphFinalization>,
  semanticModules: readonly Readonly<IrModule>[],
  moduleResolution: Readonly<CompilerModuleResolutionPlan>,
  observePlan?: (plan: Readonly<CompilerRustSourceTreePlan>) => void,
  finalizePlan?: (
    plan: Readonly<CompilerRustSourceTreePlan>,
  ) => readonly Readonly<CompilerRustModuleEvaluationEmissionFragment>[] | undefined,
) {
  const calls: Array<{
    module: string;
    references: Array<[string, string]>;
    sourceFragment: string;
    targetPath: string;
  }> = [];
  let receivedPlan: CompilerRustSourceTreeModuleReemissionRequest['plan'] | undefined;
  const result = createCompilerRustSourceTreeFinalization({
    finalization,
    moduleResolution,
    ...(observePlan === undefined && finalizePlan === undefined
      ? {}
      : {
          finalizePlan(plan: Readonly<CompilerRustSourceTreePlan>) {
            observePlan?.(plan);
            return finalizePlan?.(plan);
          },
        }),
    reemitModule(request) {
      if (receivedPlan === undefined) receivedPlan = request.plan;
      else expect(request.plan).toBe(receivedPlan);
      expect(Object.isFrozen(request.plan)).toBe(true);
      calls.push({
        module: request.module.name,
        references: request.references.map((reference) => [reference.specifier, reference.rustPath]),
        sourceFragment: request.sourceFile.sourceFragment,
        targetPath: request.sourceFile.filePath,
      });
      return {
        contents:
          `${createCompilerGeneratedFileHeader(request.module, '//')}\n` +
          '#![allow(dead_code)]\n' +
          '#![forbid(unsafe_code)]\n\n' +
          `pub fn emitted_${request.module.name.toLowerCase()}() {}`,
        dependencies: [`generated/${request.module.name}`],
        path: request.sourceFile.filePath,
      };
    },
    semanticModules,
  });
  return { calls, result };
}

function identity(module: Readonly<IrModule>): CompilerModuleIdentity {
  return { name: module.name, packageName: module.packageName, source: module.source };
}

function isDeeplyFrozen(value: unknown, seen: WeakSet<object>): boolean {
  if (!value || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((item) => isDeeplyFrozen(item, seen));
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
  if (result.diagnostics.length > 0) throw new Error(result.diagnostics.map((item) => item.message).join('\n'));
  return result.module;
}

function retained(module: Readonly<IrModule>, path: string): CompilerBackendModuleFile {
  return {
    file: { contents: `provisional ${module.name}`, path },
    module: identity(module),
  };
}
