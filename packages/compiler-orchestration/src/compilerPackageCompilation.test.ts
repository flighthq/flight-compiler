import { createBackendEmissionFailure } from '../../compiler-emission/src/index.js';
import { createCompilerLoweringFailure } from '../../compiler-lowering/src/index.js';
import type {
  CompilerBackend,
  CompilerModuleIdentity,
  CompilerPackageGraph,
  TypeScriptPackageGraphSource,
} from '../../compiler-types/src/index.js';
import { parseTypeScriptSource } from './compilerOrchestration.js';
import { compileTypeScriptPackageGraph, isCompilerPackageGraphFailure } from './compilerPackageCompilation.js';

describe('compileTypeScriptPackageGraph', () => {
  it('compiles a cross-package graph once with explicit C++ identity and a build manifest', () => {
    const model = source('@flighthq/types', 'types', 'model.ts', 'export interface Model { value: number }');
    const renderer = source(
      '@flighthq/render-wgpu',
      'render-wgpu',
      'renderer.ts',
      "import type { Model } from '@flighthq/types'; export function render(model: Model): Model { return model; }",
    );
    const modelIdentity = identity(model, 'Model');
    const rendererIdentity = identity(renderer, 'Renderer');
    const backend: CompilerBackend = {
      createEmissionSession: ({ modules }) => ({
        emitModule(module) {
          expect(modules).toHaveLength(2);
          return module.packageName === '@flighthq/types'
            ? [{ contents: 'model', dependencies: ['flight/runtime.hpp'], path: 'flight/types/model.hpp' }]
            : [
                {
                  contents: 'renderer',
                  dependencies: ['flight/types/model.hpp', 'flight/runtime.hpp'],
                  path: 'flight/render_wgpu/renderer.hpp',
                },
              ];
        },
      }),
      emitModule: () => {
        throw new Error('compatibility entry point must not be used');
      },
      name: 'cpp',
    };
    const result = compileTypeScriptPackageGraph({
      backend,
      backendOptions: {},
      graph: graph(
        [rendererIdentity],
        [
          {
            importer: rendererIdentity,
            specifier: '@flighthq/types',
            target: modelIdentity,
          },
        ],
        [
          { dependencies: [], name: '@flighthq/types', root: model.packageRoot },
          {
            dependencies: ['@flighthq/types'],
            name: '@flighthq/render-wgpu',
            root: renderer.packageRoot,
          },
        ],
      ),
      sources: [renderer, model],
    });

    expect(result.compilation.files.map((file) => file.path)).toEqual([
      'flight/render_wgpu/renderer.hpp',
      'flight/types/model.hpp',
    ]);
    expect(result.report).toMatchObject({
      backend: 'cpp',
      schema: 'flight-compiler-package-report/1',
    });
    expect(result.report.files).toContainEqual({
      dependencies: ['flight/runtime.hpp', 'flight/types/model.hpp'],
      module: rendererIdentity,
      path: 'flight/render_wgpu/renderer.hpp',
    });
    expect(result.report.initialization.entries).toEqual([rendererIdentity]);
    expect(result.report.initialization.modules.map((module) => module.module)).toEqual([
      modelIdentity,
      rendererIdentity,
    ]);
    expect(result.report.packages).toEqual([
      {
        dependencies: ['@flighthq/types'],
        modules: [expect.objectContaining({ module: rendererIdentity, status: 'emitted' })],
        name: '@flighthq/render-wgpu',
        outputFiles: ['flight/render_wgpu/renderer.hpp'],
      },
      {
        dependencies: [],
        modules: [expect.objectContaining({ module: modelIdentity, status: 'emitted' })],
        name: '@flighthq/types',
        outputFiles: ['flight/types/model.hpp'],
      },
    ]);
  });

  it('reuses one backend emission session and keeps partial output dependency-closed', () => {
    const good = source('@local/source', 'source', 'good.ts', 'export const good = 1;');
    const bad = source('@local/source', 'source', 'bad.ts', 'export const bad = 1;');
    const dependent = source(
      '@local/source',
      'source',
      'dependent.ts',
      "import { bad } from './bad.js'; export const value = bad;",
    );
    const goodIdentity = identity(good, 'Good');
    const badIdentity = identity(bad, 'Bad');
    const dependentIdentity = identity(dependent, 'Dependent');
    let sessions = 0;
    const backend: CompilerBackend = {
      createEmissionSession: () => {
        sessions += 1;
        return {
          emitModule(module) {
            if (module.name === 'Bad') throw createBackendEmissionFailure('fixture', module, 'unsupported bad value');
            return [{ contents: module.name, path: `${module.name}.txt` }];
          },
        };
      },
      emitModule: () => {
        throw new Error('compatibility entry point must not be used');
      },
      name: 'fixture',
    };
    const result = compileTypeScriptPackageGraph({
      backend,
      backendOptions: {},
      graph: graph(
        [goodIdentity, badIdentity, dependentIdentity],
        [{ importer: dependentIdentity, specifier: './bad.js', target: badIdentity }],
        [{ dependencies: [], name: '@local/source', root: good.packageRoot }],
      ),
      sources: [dependent, bad, good],
    });

    expect(sessions).toBe(1);
    expect(result.compilation.files).toEqual([{ contents: 'Good\n', path: 'Good.txt' }]);
    expect(result.report.modules).toEqual([
      expect.objectContaining({
        module: badIdentity,
        refusals: [expect.objectContaining({ code: 'unsupported-ir', stage: 'emission' })],
        status: 'refused',
      }),
      expect.objectContaining({
        module: dependentIdentity,
        refusals: [expect.objectContaining({ code: 'dependency-refused', stage: 'dependency' })],
        status: 'refused',
      }),
      expect.objectContaining({ module: goodIdentity, outputFiles: ['Good.txt'], status: 'emitted' }),
    ]);
    expect(result.report.initialization.entries).toEqual([goodIdentity]);
  });

  it('records stable lowering codes and source locations while emitting unaffected modules', () => {
    const good = source('@local/source', 'source', 'good.ts', 'export const good = 1;');
    const bad = source(
      '@local/source',
      'source',
      'bad.ts',
      'export const retained = 1;\ndoSomething();\ndoSomethingElse();',
    );
    const backend: CompilerBackend = {
      emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
      name: 'fixture',
    };
    const result = compileTypeScriptPackageGraph({
      backend,
      backendOptions: {},
      graph: graph(
        [identity(good, 'Good'), identity(bad, 'Bad')],
        [],
        [{ dependencies: [], name: '@local/source', root: good.packageRoot }],
      ),
      sources: [bad, good],
    });

    expect(result.compilation.files.map((file) => file.path)).toEqual(['Good.txt']);
    expect(result.report.modules[0]).toMatchObject({
      module: identity(bad, 'Bad'),
      refusals: [
        {
          code: 'unsupported-typescript',
          column: 1,
          line: 2,
          message: expect.any(String),
          stage: 'lowering',
        },
        {
          code: 'unsupported-typescript',
          column: 1,
          line: 3,
          message: expect.any(String),
          stage: 'lowering',
        },
      ],
      status: 'refused',
    });
  });

  it('is deterministic under source, package, entry, and dependency permutation', () => {
    const alpha = source('@local/source', 'source', 'alpha.ts', 'export const alpha = 1;');
    const beta = source(
      '@local/source',
      'source',
      'beta.ts',
      "import { alpha } from './alpha.js'; export const beta = alpha;",
    );
    const alphaIdentity = identity(alpha, 'Alpha');
    const betaIdentity = identity(beta, 'Beta');
    const dependency = { importer: betaIdentity, specifier: './alpha.js', target: alphaIdentity };
    const backend: CompilerBackend = {
      emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
      name: 'fixture',
    };
    const compile = (sources: readonly TypeScriptPackageGraphSource[], entries: readonly CompilerModuleIdentity[]) =>
      compileTypeScriptPackageGraph({
        backend,
        backendOptions: {},
        graph: graph(entries, [dependency], [{ dependencies: [], name: '@local/source', root: alpha.packageRoot }]),
        sources,
      }).report;

    expect(compile([alpha, beta], [alphaIdentity, betaIdentity])).toEqual(
      compile([beta, alpha], [betaIdentity, alphaIdentity]),
    );
  });

  it('turns independent backend failures and output collisions into per-module refusals', () => {
    const collisionA = source('@local/source', 'source', 'collision-a.ts', 'export const valueA = 1;');
    const collisionB = source('@local/source', 'source', 'collision-b.ts', 'export const valueB = 1;');
    const unsafe = source('@local/source', 'source', 'unsafe.ts', 'export const unsafe = 1;');
    const broken = source('@local/source', 'source', 'broken.ts', 'export const broken = 1;');
    const backend: CompilerBackend = {
      emitModule(module) {
        if (module.name === 'Unsafe') return [{ contents: 'unsafe', path: '../unsafe.txt' }];
        if (module.name === 'Broken') throw new Error('fixture backend crashed');
        return [{ contents: module.name, path: 'SAME.txt' }];
      },
      name: 'fixture',
    };
    const result = compileTypeScriptPackageGraph({
      backend,
      backendOptions: {},
      graph: graph([], [], [{ dependencies: [], name: '@local/source', root: collisionA.packageRoot }]),
      sources: [broken, collisionB, unsafe, collisionA],
    });

    expect(result.compilation.files).toEqual([]);
    expect(result.report.entries).toHaveLength(4);
    expect(
      result.report.modules.map((module) => [module.module.name, module.refusals[0]?.code, module.refusals[0]?.stage]),
    ).toEqual([
      ['Broken', 'internal-error', 'emission'],
      ['Collision-a', 'duplicate-emitted-path', 'emission'],
      ['Collision-b', 'duplicate-emitted-path', 'emission'],
      ['Unsafe', 'unsafe-emitted-path', 'emission'],
    ]);
  });

  it('preserves controlled unsupported lowering failures as unsupported IR refusals', () => {
    const unsupported = source('@local/source', 'source', 'unsupported.ts', 'export const unsupported = 1;');
    const backend: CompilerBackend = {
      emitModule(module) {
        throw createCompilerLoweringFailure('unsupported-ir', 'fixture-pass', module, 'fixture unsupported IR');
      },
      name: 'fixture',
    };
    const result = compileTypeScriptPackageGraph({
      backend,
      backendOptions: {},
      graph: graph([], [], [{ dependencies: [], name: '@local/source', root: unsupported.packageRoot }]),
      sources: [unsupported],
    });

    expect(result.report.modules[0]?.refusals).toEqual([
      {
        code: 'unsupported-ir',
        message:
          'Compiler lowering pass fixture-pass failed for @local/source/packages/source/src/unsupported.ts: fixture unsupported IR',
        stage: 'emission',
      },
    ]);
  });

  it('validates the final package output with the configured parser and target compiler', () => {
    const value = source('@local/source', 'source', 'value.ts', 'export const value = 1;');
    const events: string[] = [];
    const backend: CompilerBackend = {
      emitModule: () => [{ contents: 'value', path: 'Value.txt' }],
      name: 'fixture',
    };
    const compile = (supportsSyntax: boolean, supportsCompilation: boolean) =>
      compileTypeScriptPackageGraph({
        backend,
        backendOptions: {},
        graph: graph([], [], [{ dependencies: [], name: '@local/source', root: value.packageRoot }]),
        sourceParser: {
          name: 'fixture-parser',
          parseEmittedSource(file) {
            events.push(`parse:${file.path}`);
            return [];
          },
          supportsEmittedSource: () => supportsSyntax,
        },
        sources: [value],
        targetCompilationSmoke: {
          compileEmittedSources(files) {
            events.push(`compile:${files.map((file) => file.path).join(',')}`);
            return [];
          },
          name: 'fixture-compiler',
          supportsEmittedSource: () => supportsCompilation,
        },
      });

    expect(compile(true, true).compilation.files.map((file) => file.path)).toEqual(['Value.txt']);
    expect(events).toEqual(['parse:Value.txt', 'compile:Value.txt']);
    expect(() => compile(false, true)).toThrow(
      expect.objectContaining({ code: 'insufficient-emitted-source-syntax-files', kind: 'compiler-invariant' }),
    );
    expect(() => compile(true, false)).toThrow(
      expect.objectContaining({ code: 'insufficient-target-compilation-smoke-files', kind: 'compiler-invariant' }),
    );
  });

  it('refuses an unplannable module initialization while preserving an unrelated entry', () => {
    const invalid = source('@local/source', 'source', 'invalid.ts', 'export const value = 1; export default value;');
    const valid = source('@local/source', 'source', 'valid.ts', 'export const valid = 1;');
    const result = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'fixture',
      },
      backendOptions: {},
      graph: graph([], [], [{ dependencies: [], name: '@local/source', root: invalid.packageRoot }]),
      sources: [invalid, valid],
    });

    expect(result.compilation.files).toEqual([{ contents: 'Valid\n', path: 'Valid.txt' }]);
    expect(result.report.modules).toEqual([
      expect.objectContaining({
        module: identity(invalid, 'Invalid'),
        refusals: [expect.objectContaining({ code: 'unsupported-default-expression-order', stage: 'initialization' })],
        status: 'refused',
      }),
      expect.objectContaining({ module: identity(valid, 'Valid'), status: 'emitted' }),
    ]);
  });

  it('rethrows unrecognized errors from backend emission as-is', () => {
    const value = source('@local/source', 'source', 'value.ts', 'export const value = 1;');
    const sentinel = { customError: true };
    const backend: CompilerBackend = {
      emitModule: () => {
        throw sentinel;
      },
      name: 'fixture',
    };

    expect(() =>
      compileTypeScriptPackageGraph({
        backend,
        backendOptions: {},
        graph: graph([], [], [{ dependencies: [], name: '@local/source', root: value.packageRoot }]),
        sources: [value],
      }),
    ).toThrow(sentinel);
  });

  it('resolves relative imports through extension mapping (.js to .ts, .cjs to .cts, .mjs to .mts, .jsx to .tsx)', () => {
    const dep = source('@local/source', 'source', 'dep.ts', 'export const dep = 1;');
    const importer = source(
      '@local/source',
      'source',
      'importer.ts',
      "import { dep } from './dep.js'; export const value = dep;",
    );
    const backend: CompilerBackend = {
      emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
      name: 'fixture',
    };
    const result = compileTypeScriptPackageGraph({
      backend,
      backendOptions: {},
      graph: graph(
        [identity(importer, 'Importer')],
        [],
        [{ dependencies: [], name: '@local/source', root: dep.packageRoot }],
      ),
      sources: [importer, dep],
    });

    expect(result.report.initialization.groups.map((group) => group.modules)).toEqual([
      [identity(dep, 'Dep')],
      [identity(importer, 'Importer')],
    ]);
  });

  it('resolves relative imports without extensions via .ts suffix and index.ts fallback', () => {
    const child = source('@local/source', 'source', 'sub/child.ts', 'export const child = 1;');
    const index = source('@local/source', 'source', 'lib/index.ts', 'export const lib = 1;');
    const consumer = source(
      '@local/source',
      'source',
      'consumer.ts',
      "import { child } from './sub/child'; import { lib } from './lib'; export const value = child + lib;",
    );
    const backend: CompilerBackend = {
      emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
      name: 'fixture',
    };
    const result = compileTypeScriptPackageGraph({
      backend,
      backendOptions: {},
      graph: graph(
        [identity(consumer, 'Consumer')],
        [],
        [{ dependencies: [], name: '@local/source', root: child.packageRoot }],
      ),
      sources: [consumer, child, index],
    });

    expect(result.report.initialization.groups.map((group) => group.modules.map((m) => m.name))).toEqual([
      ['Index'],
      ['Child'],
      ['Consumer'],
    ]);
  });

  it('resolves parent-directory relative imports with .. segments', () => {
    const shared = source('@local/source', 'source', 'shared.ts', 'export const shared = 1;');
    const deep = source(
      '@local/source',
      'source',
      'sub/deep.ts',
      "import { shared } from '../shared.js'; export const value = shared;",
    );
    const backend: CompilerBackend = {
      emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
      name: 'fixture',
    };
    const result = compileTypeScriptPackageGraph({
      backend,
      backendOptions: {},
      graph: graph(
        [identity(deep, 'Deep')],
        [],
        [{ dependencies: [], name: '@local/source', root: shared.packageRoot }],
      ),
      sources: [deep, shared],
    });

    expect(result.report.initialization.groups.map((group) => group.modules.map((m) => m.name))).toEqual([
      ['Shared'],
      ['Deep'],
    ]);
  });

  it('sorts lowering diagnostics by package, source, line, column, code, and message', () => {
    const a = source('@local/source', 'source', 'alpha.ts', 'export const retained = 1;\ndoAlpha();\ndoBeta();');
    const b = source('@local/source', 'source', 'beta.ts', 'export const retained = 1;\ndoBeta();\ndoAlpha();');
    const backend: CompilerBackend = {
      emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
      name: 'fixture',
    };
    const result = compileTypeScriptPackageGraph({
      backend,
      backendOptions: {},
      graph: graph([], [], [{ dependencies: [], name: '@local/source', root: a.packageRoot }]),
      sources: [b, a],
    });

    expect(result.diagnostics.map((d) => `${d.source}:${String(d.line)}`)).toEqual([
      expect.stringContaining('alpha.ts:2'),
      expect.stringContaining('alpha.ts:3'),
      expect.stringContaining('beta.ts:2'),
      expect.stringContaining('beta.ts:3'),
    ]);
  });

  it('rejects duplicate module identities from identical sources', () => {
    const value = source('@local/source', 'source', 'value.ts', 'export const value = 1;');
    expect(() =>
      compileTypeScriptPackageGraph({
        backend: { emitModule: () => [], name: 'fixture' },
        backendOptions: {},
        graph: graph([], [], [{ dependencies: [], name: '@local/source', root: value.packageRoot }]),
        sources: [value, value],
      }),
    ).toThrow(expect.objectContaining({ code: 'duplicate-module-identity', kind: 'compiler-invariant' }));
  });

  it('extracts dependency edges from re-export specifiers', () => {
    const dep = source('@local/source', 'source', 'dep.ts', 'export const dep = 1;');
    const reexporter = source('@local/source', 'source', 'reexporter.ts', "export * from './dep.js';");
    const backend: CompilerBackend = {
      emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
      name: 'fixture',
    };
    const result = compileTypeScriptPackageGraph({
      backend,
      backendOptions: {},
      graph: graph(
        [identity(reexporter, 'Reexporter')],
        [],
        [{ dependencies: [], name: '@local/source', root: dep.packageRoot }],
      ),
      sources: [reexporter, dep],
    });

    expect(result.report.initialization.groups.map((group) => group.modules.map((m) => m.name))).toEqual([
      ['Dep'],
      ['Reexporter'],
    ]);
  });

  it('traces a named barrel import to its source module deterministically', () => {
    const good = source('@local/source', 'source', 'good.ts', 'export const good = 1;');
    const barrel = source('@local/source', 'source', 'barrel.ts', "export { good } from './good.js';");
    const consumer = source(
      '@local/source',
      'source',
      'consumer.ts',
      "import { good } from './barrel.js'; export const value = good;",
    );
    const first = compileFixturePackageGraph([barrel, consumer, good], consumer);
    const second = compileFixturePackageGraph([good, consumer, barrel], consumer);

    expect(first.report.initialization).toEqual(second.report.initialization);
    expect(getFixtureDependencyTargets(first, 'Consumer')).toEqual(['Good']);
    expect(first.report.initialization.groups.map((group) => group.modules.map((module) => module.name))).toEqual([
      ['Good'],
      ['Consumer'],
    ]);
  });

  it('passes the traced source as the exact backend module-resolution target', () => {
    const good = source('@local/source', 'source', 'good.ts', 'export const good = 1;');
    const barrel = source('@local/source', 'source', 'barrel.ts', "export { good } from './good.js';");
    const consumer = source(
      '@local/source',
      'source',
      'consumer.ts',
      "import { good } from './barrel.js'; export const value = good;",
    );
    const consumerIdentity = identity(consumer, 'Consumer');
    let exactTargets: string[] = [];
    compileTypeScriptPackageGraph({
      backend: {
        createEmissionSession({ moduleResolution }) {
          exactTargets =
            moduleResolution?.edges
              .filter(
                (edge) =>
                  edge.specifier === './barrel.js' &&
                  edge.importer?.packageName === consumerIdentity.packageName &&
                  edge.importer.source === consumerIdentity.source,
              )
              .map((edge) => edge.target.source) ?? [];
          return { emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }] };
        },
        emitModule: () => [],
        name: 'fixture',
      },
      backendOptions: {},
      graph: graph([consumerIdentity], [], [{ dependencies: [], name: '@local/source', root: consumer.packageRoot }]),
      moduleResolution: {
        edges: [
          {
            importer: consumerIdentity,
            specifier: './barrel.js',
            target: { packageName: barrel.packageName, source: identity(barrel, 'Barrel').source },
          },
        ],
        schema: 'flight-compiler-module-resolution/1',
      },
      sources: [consumer, barrel, good],
    });

    expect(exactTargets).toEqual([identity(good, 'Good').source]);
  });

  it('orders independently traced named-import dependencies by their source requests', () => {
    const alpha = source('@local/source', 'source', 'alpha.ts', 'export const alpha = 1;');
    const zeta = source('@local/source', 'source', 'zeta.ts', 'export const zeta = 2;');
    const alphaBarrel = source('@local/source', 'source', 'alpha-barrel.ts', "export { alpha } from './alpha.js';");
    const zetaBarrel = source('@local/source', 'source', 'zeta-barrel.ts', "export { zeta } from './zeta.js';");
    const consumer = source(
      '@local/source',
      'source',
      'consumer.ts',
      "import { zeta } from './zeta-barrel.js'; import { alpha } from './alpha-barrel.js'; export const value = alpha + zeta;",
    );
    const result = compileFixturePackageGraph([zetaBarrel, consumer, alpha, alphaBarrel, zeta], consumer);

    expect(getFixtureDependencyTargets(result, 'Consumer')).toEqual(['Alpha', 'Zeta']);
  });

  it('keeps namespace imports dependent on the barrel module', () => {
    const good = source('@local/source', 'source', 'good.ts', 'export const good = 1;');
    const barrel = source('@local/source', 'source', 'barrel.ts', "export { good } from './good.js';");
    const consumer = source(
      '@local/source',
      'source',
      'consumer.ts',
      "import * as barrel from './barrel.js'; export const value = barrel.good;",
    );
    const result = compileFixturePackageGraph([consumer, good, barrel], consumer);

    expect(getFixtureDependencyTargets(result, 'Consumer')).toEqual(['Barrel']);
    expect(result.report.initialization.groups.map((group) => group.modules.map((module) => module.name))).toEqual([
      ['Good'],
      ['Barrel'],
      ['Consumer'],
    ]);
  });

  it('keeps named namespace-object imports dependent on the barrel module', () => {
    const good = source('@local/source', 'source', 'good.ts', 'export const good = 1;');
    const barrel = source('@local/source', 'source', 'barrel.ts', "export * as values from './good.js';");
    const consumer = source(
      '@local/source',
      'source',
      'consumer.ts',
      "import { values } from './barrel.js'; export const value = values.good;",
    );
    const result = compileFixturePackageGraph([consumer, good, barrel], consumer);

    expect(getFixtureDependencyTargets(result, 'Consumer')).toEqual(['Barrel']);
  });

  it('keeps side-effect and named imports from the same request dependent on the barrel module', () => {
    const good = source('@local/source', 'source', 'good.ts', 'export const good = 1;');
    const barrel = source('@local/source', 'source', 'barrel.ts', "export { good } from './good.js';");
    const consumer = source(
      '@local/source',
      'source',
      'consumer.ts',
      "import './barrel.js'; import { good } from './barrel.js'; export const value = good;",
    );
    const result = compileFixturePackageGraph([consumer, good, barrel], consumer);

    expect(getFixtureDependencyTargets(result, 'Consumer')).toEqual(['Barrel']);
  });

  it('traces a named import through export-all and multiple barrel levels', () => {
    const good = source('@local/source', 'source', 'good.ts', 'export const good = 1;');
    const inner = source('@local/source', 'source', 'inner.ts', "export * from './good.js';");
    const outer = source('@local/source', 'source', 'outer.ts', "export { good } from './inner.js';");
    const consumer = source(
      '@local/source',
      'source',
      'consumer.ts',
      "import { good } from './outer.js'; export const value = good;",
    );
    const result = compileFixturePackageGraph([outer, inner, consumer, good], consumer);

    expect(getFixtureDependencyTargets(result, 'Consumer')).toEqual(['Good']);
    expect(result.report.initialization.groups.map((group) => group.modules.map((module) => module.name))).toEqual([
      ['Good'],
      ['Consumer'],
    ]);
  });

  it('falls back to the barrel when any named import cannot be traced', () => {
    const good = source('@local/source', 'source', 'good.ts', 'export const good = 1;');
    const barrel = source('@local/source', 'source', 'barrel.ts', "export { good } from './good.js';");
    const consumer = source(
      '@local/source',
      'source',
      'consumer.ts',
      "import { good, missing } from './barrel.js'; export const value = good; export type Missing = typeof missing;",
    );
    const result = compileFixturePackageGraph([consumer, barrel, good], consumer);

    expect(getFixtureDependencyTargets(result, 'Consumer')).toEqual(['Barrel']);
  });

  it('keeps a barrel dependency when named imports resolve to multiple source modules', () => {
    const alpha = source('@local/source', 'source', 'alpha.ts', 'export const alpha = 1;');
    const beta = source('@local/source', 'source', 'beta.ts', 'export const beta = 2;');
    const barrel = source(
      '@local/source',
      'source',
      'barrel.ts',
      "export { alpha } from './alpha.js'; export { beta } from './beta.js';",
    );
    const consumer = source(
      '@local/source',
      'source',
      'consumer.ts',
      "import { alpha, beta } from './barrel.js'; export const value = alpha + beta;",
    );
    const result = compileFixturePackageGraph([consumer, beta, barrel, alpha], consumer);

    expect(getFixtureDependencyTargets(result, 'Consumer')).toEqual(['Barrel']);
  });

  it('does not cascade an unrelated barrel source refusal to a named-import consumer', () => {
    const good = source('@local/source', 'source', 'good.ts', 'export const good = 1;');
    const bad = source('@local/source', 'source', 'bad.ts', 'export const bad = 1;');
    const barrel = source(
      '@local/source',
      'source',
      'barrel.ts',
      "export * from './bad.js'; export * from './good.js';",
    );
    const consumer = source(
      '@local/source',
      'source',
      'consumer.ts',
      "import { good } from './barrel.js'; export const value = good;",
    );
    const result = compileFixturePackageGraph([barrel, bad, consumer, good], consumer, {
      emitModule(module) {
        if (module.name === 'Bad') throw createBackendEmissionFailure('fixture', module, 'unsupported bad value');
        return [{ contents: module.name, path: `${module.name}.txt` }];
      },
      name: 'fixture',
    });

    expect(result.compilation.files.map((file) => file.path)).toEqual(['Consumer.txt', 'Good.txt']);
    expect(result.report.modules.find((module) => module.module.name === 'Barrel')).toMatchObject({
      refusals: [expect.objectContaining({ code: 'dependency-refused' })],
      status: 'refused',
    });
    expect(result.report.modules.find((module) => module.module.name === 'Consumer')).toMatchObject({
      refusals: [],
      status: 'emitted',
    });
  });

  it('skips unresolvable relative re-export specifiers in dependency edges', () => {
    const value = source(
      '@local/source',
      'source',
      'value.ts',
      "export * from './nonexistent.js'; export const value = 1;",
    );
    const backend: CompilerBackend = {
      emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
      name: 'fixture',
    };
    const result = compileTypeScriptPackageGraph({
      backend,
      backendOptions: {},
      graph: graph([], [], [{ dependencies: [], name: '@local/source', root: value.packageRoot }]),
      sources: [value],
    });

    expect(result.report.modules).toHaveLength(1);
    expect(result.report.modules[0]?.module.name).toBe('Value');
  });

  it('skips bare specifiers without resolution plan edges', () => {
    const dep = source('@local/dep', 'dep', 'dep.ts', 'export const dep = 1;');
    const value = source('@local/source', 'source', 'value.ts', "export * from '@local/dep'; export const value = 1;");
    const backend: CompilerBackend = {
      emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
      name: 'fixture',
    };
    const result = compileTypeScriptPackageGraph({
      backend,
      backendOptions: {},
      graph: graph(
        [],
        [],
        [
          { dependencies: [], name: '@local/dep', root: dep.packageRoot },
          { dependencies: ['@local/dep'], name: '@local/source', root: value.packageRoot },
        ],
      ),
      sources: [value, dep],
    });

    expect(result.report.modules.map((m) => m.module.name).sort()).toEqual(['Dep', 'Value']);
  });

  it('returns undefined for ambiguous relative resolution matching multiple local modules', () => {
    const depFile = source('@local/source', 'source', 'dep.ts', 'export const dep = 1;');
    const depIndex = source('@local/source', 'source', 'dep/index.ts', 'export const depIndex = 1;');
    const consumer = source(
      '@local/source',
      'source',
      'consumer.ts',
      "import { dep } from './dep'; export const value = dep;",
    );
    const backend: CompilerBackend = {
      emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
      name: 'fixture',
    };
    const result = compileTypeScriptPackageGraph({
      backend,
      backendOptions: {},
      graph: graph(
        [identity(consumer, 'Consumer')],
        [],
        [{ dependencies: [], name: '@local/source', root: depFile.packageRoot }],
      ),
      sources: [consumer, depFile, depIndex],
    });

    expect(
      result.report.initialization.groups.every((group) => group.modules.length <= 1 || group.modules.length >= 3),
    ).toBe(true);
  });

  it('sorts lowering diagnostics by column when package, source, and line match', () => {
    const value = source('@local/source', 'source', 'value.ts', 'export const retained = 1;\ndoAlpha(); doBeta();');
    const backend: CompilerBackend = {
      emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
      name: 'fixture',
    };
    const result = compileTypeScriptPackageGraph({
      backend,
      backendOptions: {},
      graph: graph([], [], [{ dependencies: [], name: '@local/source', root: value.packageRoot }]),
      sources: [value],
    });

    const refusals = result.report.modules[0]?.refusals ?? [];
    expect(refusals).toHaveLength(2);
    expect(refusals[0]!.column).toBeLessThan(refusals[1]!.column!);
    expect(refusals[0]!.line).toBe(refusals[1]!.line);
  });

  it('infers exact, global, and relative module resolution edges into one graph', () => {
    const model = source('@local/model', 'model', 'model.ts', 'export const model = 1;');
    const exact = source(
      '@local/source',
      'source',
      'exact.ts',
      "import { model } from '@model'; export const exact = model;",
    );
    const global = source(
      '@local/source',
      'source',
      'global.ts',
      "import { model } from '@global-model'; export const global = model;",
    );
    const relative = source(
      '@local/source',
      'source',
      'relative.ts',
      "import { exact } from './exact'; export const relative = exact;",
    );
    const modelIdentity = identity(model, 'Model');
    const exactIdentity = identity(exact, 'Exact');
    const globalIdentity = identity(global, 'Global');
    const relativeIdentity = identity(relative, 'Relative');
    const result = compileTypeScriptPackageGraph({
      backend: {
        emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
        name: 'fixture',
      },
      backendOptions: {},
      graph: graph(
        [exactIdentity, globalIdentity, relativeIdentity],
        [],
        [
          { dependencies: [], name: '@local/model', root: model.packageRoot },
          { dependencies: ['@local/model'], name: '@local/source', root: exact.packageRoot },
        ],
      ),
      moduleResolution: {
        edges: [
          {
            importer: exactIdentity,
            specifier: '@model',
            target: { packageName: modelIdentity.packageName, source: modelIdentity.source },
          },
          {
            specifier: '@global-model',
            target: { packageName: modelIdentity.packageName, source: modelIdentity.source },
          },
        ],
        schema: 'flight-compiler-module-resolution/1',
      },
      sources: [relative, global, model, exact],
    });

    expect(result.report.initialization.groups.map((group) => group.modules)).toEqual([
      [modelIdentity],
      [exactIdentity],
      [globalIdentity],
      [relativeIdentity],
    ]);
  });
});

describe('isCompilerPackageGraphFailure', () => {
  it('recognizes a package-root mismatch as tagged graph input failure', () => {
    const value = source('@local/source', 'source', 'value.ts', 'export const value = 1;');
    let received: unknown;
    try {
      compileTypeScriptPackageGraph({
        backend: { emitModule: () => [], name: 'fixture' },
        backendOptions: {},
        graph: graph(
          [identity(value, 'Value')],
          [],
          [{ dependencies: [], name: '@local/source', root: '/flight/packages/other' }],
        ),
        sources: [value],
      });
    } catch (error) {
      received = error;
    }

    expect(isCompilerPackageGraphFailure(received)).toBe(true);
    expect(received).toMatchObject({ code: 'package-root-mismatch', kind: 'compiler-package-graph' });
    expect(isCompilerPackageGraphFailure(new Error('other'))).toBe(false);
    expect(
      isCompilerPackageGraphFailure(
        Object.assign(new Error('empty subject'), {
          code: 'invalid-graph',
          kind: 'compiler-package-graph',
          subject: '',
        }),
      ),
    ).toBe(false);
  });

  it('rejects malformed package, source, entry, and module dependency shapes with stable codes', () => {
    const value = source('@local/source', 'source', 'value.ts', 'export const value = 1;');
    const valueIdentity = identity(value, 'Value');
    const package_ = { dependencies: [] as readonly string[], name: '@local/source', root: value.packageRoot };
    const missingIdentity = { ...valueIdentity, source: 'packages/source/src/missing.ts' };
    const attempts: readonly [string, () => unknown][] = [
      [
        'invalid-graph',
        () =>
          compileTypeScriptPackageGraph({
            backend: { emitModule: () => [], name: 'fixture' },
            backendOptions: {},
            graph: null as never,
            sources: [value],
          }),
      ],
      [
        'invalid-package',
        () =>
          compileTypeScriptPackageGraph({
            backend: { emitModule: () => [], name: 'fixture' },
            backendOptions: {},
            graph: graph([], [], [null as never]),
            sources: [value],
          }),
      ],
      [
        'duplicate-package',
        () =>
          compileTypeScriptPackageGraph({
            backend: { emitModule: () => [], name: 'fixture' },
            backendOptions: {},
            graph: graph([], [], [package_, package_]),
            sources: [value],
          }),
      ],
      [
        'invalid-package-dependency',
        () =>
          compileTypeScriptPackageGraph({
            backend: { emitModule: () => [], name: 'fixture' },
            backendOptions: {},
            graph: graph([], [], [{ ...package_, dependencies: ['@local/source'] }]),
            sources: [value],
          }),
      ],
      [
        'invalid-source',
        () =>
          compileTypeScriptPackageGraph({
            backend: { emitModule: () => [], name: 'fixture' },
            backendOptions: {},
            graph: graph([], [], [package_]),
            sources: [null as never],
          }),
      ],
      [
        'unknown-package',
        () =>
          compileTypeScriptPackageGraph({
            backend: { emitModule: () => [], name: 'fixture' },
            backendOptions: {},
            graph: graph([], [], [package_]),
            sources: [{ ...value, packageName: '@local/unknown' }],
          }),
      ],
      [
        'invalid-entry',
        () =>
          compileTypeScriptPackageGraph({
            backend: { emitModule: () => [], name: 'fixture' },
            backendOptions: {},
            graph: graph([missingIdentity], [], [package_]),
            sources: [value],
          }),
      ],
      [
        'duplicate-entry',
        () =>
          compileTypeScriptPackageGraph({
            backend: { emitModule: () => [], name: 'fixture' },
            backendOptions: {},
            graph: graph([valueIdentity, valueIdentity], [], [package_]),
            sources: [value],
          }),
      ],
      [
        'invalid-module-dependency',
        () =>
          compileTypeScriptPackageGraph({
            backend: { emitModule: () => [], name: 'fixture' },
            backendOptions: {},
            graph: graph(
              [valueIdentity],
              [{ importer: valueIdentity, specifier: './missing.js', target: missingIdentity }],
              [package_],
            ),
            sources: [value],
          }),
      ],
    ];

    for (const [code, attempt] of attempts) {
      let received: unknown;
      try {
        attempt();
        expect.unreachable(`Expected ${code}`);
      } catch (error) {
        received = error;
      }
      expect(isCompilerPackageGraphFailure(received)).toBe(true);
      expect(received).toMatchObject({ code, kind: 'compiler-package-graph' });
    }
  });
});

function graph(
  entries: readonly CompilerModuleIdentity[],
  moduleDependencies: CompilerPackageGraph['moduleDependencies'],
  packages: CompilerPackageGraph['packages'],
): CompilerPackageGraph {
  return { entries, moduleDependencies, packages, schema: 'flight-compiler-package-graph/1' };
}

function identity(source: Readonly<TypeScriptPackageGraphSource>, name: string): CompilerModuleIdentity {
  return {
    name,
    packageName: source.packageName,
    source: source.sourceFile.fileName.slice('/flight/'.length),
  };
}

function source(
  packageName: string,
  packageDirectory: string,
  fileName: string,
  contents: string,
): TypeScriptPackageGraphSource {
  const packageRoot = `/flight/packages/${packageDirectory}`;
  return {
    packageName,
    packageRoot,
    sourceFile: parseTypeScriptSource(`${packageRoot}/src/${fileName}`, contents),
    upstreamDirectory: '/flight',
  };
}

function compileFixturePackageGraph(
  sources: readonly TypeScriptPackageGraphSource[],
  entry: Readonly<TypeScriptPackageGraphSource>,
  backend: CompilerBackend = {
    emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
    name: 'fixture',
  },
) {
  return compileTypeScriptPackageGraph({
    backend,
    backendOptions: {},
    graph: graph(
      [identity(entry, 'Consumer')],
      [],
      [{ dependencies: [], name: '@local/source', root: entry.packageRoot }],
    ),
    sources,
  });
}

function getFixtureDependencyTargets(
  result: ReturnType<typeof compileFixturePackageGraph>,
  moduleName: string,
): string[] {
  return (
    result.report.initialization.modules
      .find((module) => module.module.name === moduleName)
      ?.dependencies.map((dependency) => dependency.target.name) ?? []
  );
}
