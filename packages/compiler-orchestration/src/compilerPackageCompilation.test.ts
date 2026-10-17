import { createBackendEmissionFailure } from '../../compiler-emission/src/index.js';
import { createCompilerLoweringFailure } from '../../compiler-lowering/src/index.js';
import type {
  CompilerBackend,
  CompilerBackendModuleFileReplacement,
  CompilerBackendPackageGraphFinalization,
  CompilerModuleIdentity,
  CompilerPackageCompilationProgress,
  CompilerPackageGraph,
  TypeScriptPackageGraphSource,
} from '../../compiler-types/src/index.js';
import { parseTypeScriptSource } from './compilerOrchestration.js';
import {
  compileTypeScriptPackageGraph,
  isCompilerBackendFinalizationFailure,
  isCompilerPackageGraphFailure,
} from './compilerPackageCompilation.js';

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
    expect(result.report.exports).toMatchObject({
      modules: [
        {
          module: rendererIdentity,
          slots: [expect.objectContaining({ exportName: 'render', lane: 'value' })],
        },
      ],
      schema: 'flight-compiler-module-facade/1',
    });
    expect(result.report.typescript).toEqual({
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
    });
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
        refusals: [
          expect.objectContaining({
            classification: 'compiler-restriction',
            code: 'unsupported-ir',
            stage: 'emission',
          }),
        ],
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

  it('records every refused dependency that blocked a module, not only the first one scanned', () => {
    const badA = source('@local/source', 'source', 'badA.ts', 'export const badA = 1;');
    const badB = source('@local/source', 'source', 'badB.ts', 'export const badB = 2;');
    const dependent = source(
      '@local/source',
      'source',
      'dependent.ts',
      "import { badA } from './badA.js'; import { badB } from './badB.js'; export const dependent = badA + badB;",
    );
    const badAIdentity = identity(badA, 'BadA');
    const badBIdentity = identity(badB, 'BadB');
    const dependentIdentity = identity(dependent, 'Dependent');
    const backend: CompilerBackend = {
      emitModule(module) {
        if (module.name !== 'Dependent') {
          throw createBackendEmissionFailure('fixture', module, `unsupported ${module.name}`);
        }
        return [{ contents: module.name, path: `${module.name}.txt` }];
      },
      name: 'fixture',
    };
    const result = compileTypeScriptPackageGraph({
      backend,
      backendOptions: {},
      graph: graph(
        [],
        [
          { importer: dependentIdentity, specifier: './badA.js', target: badAIdentity },
          { importer: dependentIdentity, specifier: './badB.js', target: badBIdentity },
        ],
        [{ dependencies: [], name: '@local/source', root: dependent.packageRoot }],
      ),
      sources: [dependent, badA, badB],
    });

    const blocked = result.report.modules.find((module) => module.module.name === 'Dependent');
    expect(blocked?.status).toBe('refused');
    expect(blocked?.refusals).toEqual([
      expect.objectContaining({
        code: 'dependency-refused',
        refusedDependencies: ['@local/source/packages/source/src/badA.ts', '@local/source/packages/source/src/badB.ts'],
        stage: 'dependency',
      }),
    ]);
  });

  // The emit-path filter scopes OUTPUT without scoping analysis: every module is still lowered, so a selected
  // module resolves what it imports from an unselected one, but only selected modules produce a file. A module
  // the filter left out is reported as SKIPPED -- not refused -- because it was not asked for, and calling that a
  // failure would make an intentionally narrow run read as a broken one.
  it('emits only what an emit-path filter selects and reports the rest as skipped', () => {
    const badA = source('@local/source', 'source', 'badA.ts', 'export const badA = 1;');
    const dependent = source(
      '@local/source',
      'source',
      'dependent.ts',
      "import { badA } from './badA.js'; export function dependent(): number { return badA; }",
    );
    const badAIdentity = identity(badA, 'BadA');
    const dependentIdentity = identity(dependent, 'Dependent');
    const backend: CompilerBackend = {
      emitModule(module) {
        if (module.name !== 'Dependent') {
          throw createBackendEmissionFailure('fixture', module, `unsupported ${module.name}`);
        }
        return [{ contents: module.name, path: `${module.name}.txt` }];
      },
      emitRefusalPlaceholder: (module) => ({ contents: '// placeholder', path: `placeholder/${module.name}.txt` }),
      name: 'fixture',
    };
    const compile = (emitPathPrefixes: readonly string[]) =>
      compileTypeScriptPackageGraph({
        backend,
        backendOptions: {},
        bestEffort: true,
        emitPathPrefixes,
        graph: graph(
          [],
          [{ importer: dependentIdentity, specifier: './badA.js', target: badAIdentity }],
          [{ dependencies: [], name: '@local/source', root: dependent.packageRoot }],
        ),
        sources: [dependent, badA],
      });

    // An exact path selects exactly one module, and the other is skipped rather than stubbed.
    const exact = compile(['packages/source/src/dependent.ts']);
    expect(exact.compilation.files.map((file) => file.path)).toEqual(['Dependent.txt']);
    expect(exact.report.modules.map((module) => [module.module.name, module.status])).toEqual([
      ['BadA', 'skipped'],
      ['Dependent', 'emitted'],
    ]);
    expect(exact.report.bestEffort?.modules.map((module) => module.module.name)).toEqual(['Dependent']);

    // A DIRECTORY prefix selects everything under it, and does not leak into a sibling directory that merely
    // shares the prefix's spelling.
    expect(compile(['packages/source/src']).compilation.files.map((file) => file.path)).toEqual([
      'Dependent.txt',
      'placeholder/BadA.txt',
    ]);
    expect(compile(['packages/source/sr']).compilation.files).toEqual([]);

    // An empty filter is not a filter: the run emits everything, exactly as if it had not been passed.
    expect(compile([]).compilation.files.map((file) => file.path)).toEqual(['Dependent.txt', 'placeholder/BadA.txt']);
  });

  // The other half of that invariant: the filter scopes OUTPUT and not the SEMANTIC CONTEXT the backend
  // resolves against. A backend names an imported type by looking its owner up among the modules it was given,
  // so an unselected dependency missing from that list does not refuse the selected module -- the emitter falls
  // back to a spelling of its own and the same module emits DIFFERENT code for the same source. The emitted
  // bytes of a selected module must not depend on which prefixes the run happened to name.
  it('emits a selected module identically when the dependency it imports owner evidence from is unselected', () => {
    const owner = source(
      '@local/source',
      'source',
      'owner.ts',
      'export interface Owner { readonly value: number }\nexport type OwnerAlias = Owner;',
    );
    const holder = source(
      '@local/source',
      'source',
      'holder.ts',
      "import type { OwnerAlias } from './owner.js';\nexport interface Holder { readonly owner: OwnerAlias }",
    );
    const ownerIdentity = identity(owner, 'Owner');
    const holderIdentity = identity(holder, 'Holder');
    const backend: CompilerBackend = {
      createEmissionSession: ({ modules }) => {
        // What a target backend does with this list: index the declarations each module owns, so a reference
        // from another module resolves to the module that declares it. An owner this list does not hold is not
        // refused -- the reference resolves to nothing and the emitter falls back.
        const ownerSources = new Map<string, string>();
        for (const module of modules) {
          for (const exported of module.exports) {
            if (exported.kind === 'local') {
              ownerSources.set(`${module.packageName} ${exported.exported}`, module.source);
            }
          }
        }
        return {
          emitModule(module) {
            return [
              {
                contents: module.imports
                  .flatMap((imported) =>
                    imported.bindings.map(
                      (binding) =>
                        `${binding.imported} = ${ownerSources.get(`${module.packageName} ${binding.imported}`) ?? 'unresolved'}`,
                    ),
                  )
                  .join('\n'),
                path: `${module.name}.txt`,
              },
            ];
          },
        };
      },
      emitModule: () => {
        throw new Error('compatibility entry point must not be used');
      },
      emitRefusalPlaceholder: (module) => ({ contents: '// placeholder', path: `placeholder/${module.name}.txt` }),
      name: 'fixture',
    };
    const compile = (emitPathPrefixes: readonly string[] | undefined) =>
      compileTypeScriptPackageGraph({
        backend,
        backendOptions: {},
        bestEffort: true,
        ...(emitPathPrefixes === undefined ? {} : { emitPathPrefixes }),
        graph: graph(
          [],
          [{ importer: holderIdentity, specifier: './owner.js', target: ownerIdentity }],
          [{ dependencies: [], name: '@local/source', root: holder.packageRoot }],
        ),
        sources: [holder, owner],
      });

    // The importing module named the alias by the module that declares it, so `owner.ts` is in the context the
    // emitter resolved against. Spelled with the newline the emitted-file normalizer guarantees.
    const holderFile = { contents: 'OwnerAlias = packages/source/src/owner.ts\n', path: 'Holder.txt' };
    const all = compile(undefined);
    expect(all.compilation.files).toEqual([holderFile, { contents: '\n', path: 'Owner.txt' }]);

    // Only the selected module is emitted, and its bytes are the ones the unfiltered run produced.
    const filtered = compile(['packages/source/src/holder.ts']);
    expect(filtered.compilation.files).toEqual([holderFile]);
    expect(filtered.report.modules.map((module) => [module.module.name, module.status])).toEqual([
      ['Holder', 'emitted'],
      ['Owner', 'skipped'],
    ]);
    // A skipped module is not a refused one: it gets no file and no placeholder either.
    expect(filtered.report.modules.find((module) => module.module.name === 'Owner')?.outputFiles).toEqual([]);
    expect(filtered.report.bestEffort?.modules.map((module) => module.module.name)).toEqual(['Holder']);
  });

  it('finalizes package-owned output once from full context despite module filtering and source reorder', () => {
    const owner = source('@local/source', 'source', 'owner.ts', 'export interface Owner { value: number }');
    const consumer = source(
      '@local/source',
      'source',
      'consumer.ts',
      "import type { Owner } from './owner.js'; export function inspect(value: Owner): Owner { return value; }",
    );
    const ownerIdentity = identity(owner, 'Owner');
    const consumerIdentity = identity(consumer, 'Consumer');
    const compile = (
      sources: readonly TypeScriptPackageGraphSource[],
      emitPathPrefixes?: readonly string[],
    ): Readonly<{ finalizations: number; result: ReturnType<typeof compileTypeScriptPackageGraph> }> => {
      let finalizations = 0;
      const backend: CompilerBackend = {
        createEmissionSession: ({ modules }) => ({
          emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
          finalizePackageGraph() {
            finalizations += 1;
            const provenance = [...modules]
              .reverse()
              .map(({ name, packageName, source: sourcePath }) => ({ name, packageName, source: sourcePath }));
            return {
              packageFiles: [
                {
                  file: { contents: modules.map((module) => module.name).join(','), path: 'abi/source.cpp' },
                  owner: { kind: 'package', packageName: '@local/source' },
                  provenance,
                },
                {
                  file: { contents: 'package header', path: 'abi/source.h' },
                  owner: { kind: 'package', packageName: '@local/source' },
                  provenance,
                },
              ],
            };
          },
        }),
        emitModule: () => {
          throw new Error('compatibility entry point must not be used');
        },
        name: 'fixture',
      };
      const result = compileTypeScriptPackageGraph({
        backend,
        backendOptions: {},
        ...(emitPathPrefixes === undefined ? {} : { emitPathPrefixes }),
        graph: graph(
          [consumerIdentity],
          [{ importer: consumerIdentity, specifier: './owner.js', target: ownerIdentity }],
          [{ dependencies: [], name: '@local/source', root: owner.packageRoot }],
        ),
        sources,
      });
      return { finalizations, result };
    };

    const all = compile([owner, consumer]);
    const filtered = compile([consumer, owner], ['packages/source/src/consumer.ts']);
    const packageFiles = filtered.result.report.files.filter((file) => 'owner' in file);

    expect(all.finalizations).toBe(1);
    expect(filtered.finalizations).toBe(1);
    expect(all.result.compilation.files.filter((file) => file.path.startsWith('abi/'))).toEqual(
      filtered.result.compilation.files.filter((file) => file.path.startsWith('abi/')),
    );
    expect(filtered.result.compilation.files.map((file) => file.path)).toEqual([
      'Consumer.txt',
      'abi/source.cpp',
      'abi/source.h',
    ]);
    expect(packageFiles).toEqual([
      {
        dependencies: [],
        owner: { kind: 'package', packageName: '@local/source' },
        path: 'abi/source.cpp',
        provenance: [consumerIdentity, ownerIdentity],
      },
      {
        dependencies: [],
        owner: { kind: 'package', packageName: '@local/source' },
        path: 'abi/source.h',
        provenance: [consumerIdentity, ownerIdentity],
      },
    ]);
    expect(filtered.result.report.packages[0]?.outputFiles).toEqual(['Consumer.txt', 'abi/source.cpp', 'abi/source.h']);
    expect(filtered.result.report.modules.find((module) => module.module.name === 'Owner')).toMatchObject({
      outputFiles: [],
      status: 'skipped',
    });
  });

  it('finalizes from the immutable final facade and deterministically ordered retained module files', () => {
    const owner = source('@local/source', 'source', 'owner.ts', 'export interface Owner { value: number }');
    const entry = source(
      '@local/source',
      'source',
      'entry.ts',
      "import type { Owner } from './owner.js'; export function inspect(value: Owner): Owner { return value; }",
    );
    const refused = source('@local/source', 'source', 'refused.ts', 'export const refused = 1;');
    const ownerIdentity = identity(owner, 'Owner');
    const entryIdentity = identity(entry, 'Entry');
    const refusedIdentity = identity(refused, 'Refused');
    const compile = (sources: readonly TypeScriptPackageGraphSource[]) => {
      let received: Readonly<CompilerBackendPackageGraphFinalization> | undefined;
      let returnedPackageFile: { contents: string; path: string } | undefined;
      let returnedReplacementFile: { contents: string; path: string } | undefined;
      const backend: CompilerBackend = {
        createEmissionSession: () => ({
          emitModule(module) {
            if (module.name === 'Refused') {
              throw createBackendEmissionFailure('fixture', module, 'refused by fixture');
            }
            return [
              { contents: `z ${module.name}`, path: `z/${module.name}.txt` },
              { contents: `a ${module.name}`, path: `a/${module.name}.txt` },
            ];
          },
          finalizePackageGraph(finalization) {
            received = finalization;
            expect(Object.isFrozen(finalization)).toBe(true);
            expect(Object.isFrozen(finalization.facade)).toBe(true);
            expect(Object.isFrozen(finalization.facade.modules)).toBe(true);
            expect(Object.isFrozen(finalization.moduleFiles)).toBe(true);
            expect(Object.isFrozen(finalization.moduleFiles[0]?.file)).toBe(true);
            expect(() => (finalization.moduleFiles as unknown as unknown[]).splice(0)).toThrow(TypeError);
            const provenance = [
              ...new Map(
                finalization.moduleFiles.map(({ module }) => [
                  `${module.packageName}\0${module.source}\0${module.name}`,
                  module,
                ]),
              ).values(),
            ];
            const artifacts = {
              moduleFileReplacements: [...finalization.moduleFiles].reverse().map(({ file, module }) => ({
                file: { contents: `final ${file.contents}`, path: `final/${file.path}` },
                module,
                retainedPath: file.path,
              })),
              packageFiles: [
                {
                  file: {
                    contents: finalization.moduleFiles.map(({ file }) => file.path).join('\n'),
                    path: 'package/summary.txt',
                  },
                  owner: { kind: 'package' as const, packageName: '@local/source' },
                  provenance,
                },
              ],
            };
            returnedReplacementFile = artifacts.moduleFileReplacements[0]?.file;
            returnedPackageFile = artifacts.packageFiles[0]?.file;
            return artifacts;
          },
        }),
        emitModule: () => {
          throw new Error('compatibility entry point must not be used');
        },
        name: 'fixture',
      };
      const result = compileTypeScriptPackageGraph({
        backend,
        backendOptions: {},
        graph: graph(
          [entryIdentity, refusedIdentity],
          [{ importer: entryIdentity, specifier: './owner.js', target: ownerIdentity }],
          [{ dependencies: [], name: '@local/source', root: owner.packageRoot }],
        ),
        sources,
      });
      if (!received) throw new Error('Package-graph finalization did not run');
      if (!returnedPackageFile || !returnedReplacementFile) throw new Error('Finalized files were not returned');
      returnedPackageFile.path = 'mutated/package.txt';
      returnedReplacementFile.path = 'mutated/replacement.txt';
      return { finalization: received, result };
    };

    const first = compile([refused, entry, owner]);
    const second = compile([owner, refused, entry]);

    expect(second.finalization).toEqual(first.finalization);
    expect(second.result.compilation).toEqual(first.result.compilation);
    expect(first.finalization.facade.modules.map(({ module }) => module)).toEqual([entryIdentity]);
    expect(first.finalization.facade.modules[0]?.slots).toEqual([
      expect.objectContaining({ exportName: 'inspect', lane: 'value' }),
    ]);
    expect(first.finalization.moduleFiles.map(({ file, module }) => [module.name, file.path])).toEqual([
      ['Entry', 'a/Entry.txt'],
      ['Entry', 'z/Entry.txt'],
      ['Owner', 'a/Owner.txt'],
      ['Owner', 'z/Owner.txt'],
    ]);
    expect(first.finalization.moduleFiles.some(({ module }) => module.name === 'Refused')).toBe(false);
    expect(first.result.report.modules.find(({ module }) => module.name === 'Refused')).toMatchObject({
      outputFiles: [],
      status: 'refused',
    });
    expect(first.result.compilation.files.map(({ path }) => path)).toEqual([
      'final/a/Entry.txt',
      'final/a/Owner.txt',
      'final/z/Entry.txt',
      'final/z/Owner.txt',
      'package/summary.txt',
    ]);
    expect(first.result.compilation.files.every(Object.isFrozen)).toBe(true);
    expect(first.result.report.files).toContainEqual({
      dependencies: [],
      module: entryIdentity,
      path: 'final/a/Entry.txt',
    });
    expect(first.result.report.files).toContainEqual({
      dependencies: [],
      owner: { kind: 'package', packageName: '@local/source' },
      path: 'package/summary.txt',
      provenance: [entryIdentity, ownerIdentity],
    });
  });

  it('requires exact complete retained module replacements and rejects their output collisions', () => {
    const input = source('@local/source', 'source', 'input.ts', 'export const value = 1;');
    const refused = source('@local/source', 'source', 'refused.ts', 'export const refused = 1;');
    const inputIdentity = identity(input, 'Input');
    const refusedIdentity = identity(refused, 'Refused');
    const replace = (
      retained: CompilerBackendPackageGraphFinalization['moduleFiles'][number],
      path = `final/${retained.file.path}`,
    ): CompilerBackendModuleFileReplacement => ({
      file: { contents: `final ${retained.file.contents}`, path },
      module: retained.module,
      retainedPath: retained.file.path,
    });
    const compile = (
      createReplacements: (
        finalization: Readonly<CompilerBackendPackageGraphFinalization>,
      ) => readonly CompilerBackendModuleFileReplacement[],
    ) =>
      compileTypeScriptPackageGraph({
        backend: {
          createEmissionSession: () => ({
            emitModule(module) {
              if (module.name === 'Refused') {
                throw createBackendEmissionFailure('fixture', module, 'refused by fixture');
              }
              return [
                { contents: 'a', path: 'a/Input.txt' },
                { contents: 'b', path: 'b/Input.txt' },
              ];
            },
            finalizePackageGraph: (finalization) => ({
              moduleFileReplacements: createReplacements(finalization),
              packageFiles: [],
            }),
          }),
          emitModule: () => [],
          name: 'fixture',
        } satisfies CompilerBackend,
        backendOptions: {},
        graph: graph(
          [inputIdentity, refusedIdentity],
          [],
          [{ dependencies: [], name: '@local/source', root: input.packageRoot }],
        ),
        sources: [refused, input],
      });
    const invalidReplacement = expect.objectContaining({
      code: 'invalid-module-file-replacement',
      kind: 'compiler-invariant',
    });

    const swapped = compile((finalization) => [
      replace(finalization.moduleFiles[0]!, 'b/Input.txt'),
      replace(finalization.moduleFiles[1]!, 'a/Input.txt'),
    ]);
    expect(swapped.compilation.files).toEqual([
      expect.objectContaining({ contents: 'final b\n', path: 'a/Input.txt' }),
      expect.objectContaining({ contents: 'final a\n', path: 'b/Input.txt' }),
    ]);

    expect(() => compile((finalization) => [replace(finalization.moduleFiles[0]!)])).toThrow(invalidReplacement);
    expect(() =>
      compile((finalization) => [replace(finalization.moduleFiles[0]!), replace(finalization.moduleFiles[0]!)]),
    ).toThrow(invalidReplacement);
    expect(() =>
      compile((finalization) => [
        replace(finalization.moduleFiles[0]!),
        {
          ...replace(finalization.moduleFiles[1]!),
          module: refusedIdentity,
        },
      ]),
    ).toThrow(invalidReplacement);
    expect(() =>
      compile((finalization) => [
        replace(finalization.moduleFiles[0]!),
        {
          ...replace(finalization.moduleFiles[1]!),
          retainedPath: 'missing/Input.txt',
        },
      ]),
    ).toThrow(invalidReplacement);
    expect(() =>
      compile((finalization) => finalization.moduleFiles.map((retained) => replace(retained, 'same/output.txt'))),
    ).toThrow(expect.objectContaining({ code: 'duplicate-emitted-path', kind: 'compiler-invariant' }));
  });

  it('fails package-finalized output on unsafe paths and package-local path collisions', () => {
    const input = source('@local/source', 'source', 'input.ts', 'export const value = 1;');
    const compile = (path: string) =>
      compileTypeScriptPackageGraph({
        backend: {
          createEmissionSession: ({ modules }) => ({
            emitModule: (module) => [{ contents: module.name, path: 'Input.txt' }],
            finalizePackageGraph: () => ({
              packageFiles: [
                {
                  file: { contents: 'package output', path },
                  owner: { kind: 'package', packageName: '@local/source' },
                  provenance: modules.map(({ name, packageName, source: sourcePath }) => ({
                    name,
                    packageName,
                    source: sourcePath,
                  })),
                },
              ],
            }),
          }),
          emitModule: () => [],
          name: 'fixture',
        } satisfies CompilerBackend,
        backendOptions: {},
        graph: graph(
          [identity(input, 'Input')],
          [],
          [{ dependencies: [], name: '@local/source', root: input.packageRoot }],
        ),
        sources: [input],
      });

    expect(() => compile('../unsafe.h')).toThrow(
      expect.objectContaining({ code: 'unsafe-emitted-path', kind: 'compiler-invariant' }),
    );
    expect(() => compile('input.TXT')).toThrow(
      expect.objectContaining({ code: 'duplicate-emitted-path', kind: 'compiler-invariant' }),
    );
  });

  // Best-effort is one predicate wide: a module refused only because a DEPENDENCY refused still emits its own
  // real output, and a module refused for its own reasons gets a replaceable placeholder at its path instead of
  // nothing. Strict mode is untouched, which is the whole reason the mode is opt-in.
  it('emits dependency-incomplete output and placeholders when asked for best-effort', () => {
    const badA = source('@local/source', 'source', 'badA.ts', 'export const badA = 1;');
    const dependent = source(
      '@local/source',
      'source',
      'dependent.ts',
      "import { badA } from './badA.js'; export function dependent(): number { return badA; }",
    );
    const badAIdentity = identity(badA, 'BadA');
    const dependentIdentity = identity(dependent, 'Dependent');
    let sessionPlaceholderCalls = 0;
    let backendPlaceholderCalls = 0;
    const backend: CompilerBackend = {
      createEmissionSession: () => ({
        emitModule(module) {
          if (module.name !== 'Dependent') {
            throw createBackendEmissionFailure(
              'fixture',
              module,
              `unsupported ${module.name}`,
              'fixture-session-placeholder',
            );
          }
          return [{ contents: module.name, path: `${module.name}.txt` }];
        },
        emitRefusalPlaceholder(module, failure) {
          sessionPlaceholderCalls += 1;
          expect(failure.rule).toBe('fixture-session-placeholder');
          return {
            contents: `// session placeholder for ${module.name}: ${failure.rule}`,
            path: `placeholder/${module.name}.txt`,
          };
        },
      }),
      emitModule: () => {
        throw new Error('compatibility entry point must not be used');
      },
      emitRefusalPlaceholder: () => {
        backendPlaceholderCalls += 1;
        throw new Error('backend placeholder must not replace the session-scoped form');
      },
      name: 'fixture',
    };
    const compile = (bestEffort: boolean, sources: readonly TypeScriptPackageGraphSource[] = [dependent, badA]) =>
      compileTypeScriptPackageGraph({
        backend,
        backendOptions: {},
        ...(bestEffort ? { bestEffort: true } : {}),
        graph: graph(
          [],
          [{ importer: dependentIdentity, specifier: './badA.js', target: badAIdentity }],
          [{ dependencies: [], name: '@local/source', root: dependent.packageRoot }],
        ),
        sources,
      });

    // Strict: exactly what it always was -- the refusal closes the dependency and nothing is written.
    const strict = compile(false);
    expect(strict.compilation.files).toEqual([]);
    expect(strict.report.bestEffort).toBeUndefined();
    expect(sessionPlaceholderCalls).toBe(0);
    expect(backendPlaceholderCalls).toBe(0);

    const best = compile(true);
    // The dependency-incomplete module keeps its real output; the refused one leaves a replaceable path.
    expect(best.compilation.files.map((file) => file.path)).toEqual(['Dependent.txt', 'placeholder/BadA.txt']);
    expect(best.report.bestEffort?.schema).toBe('flight-compiler-best-effort/1');
    expect(best.report.bestEffort?.modules.map((module) => [module.module.name, module.status, module.path])).toEqual([
      ['BadA', 'refused-placeholder', 'placeholder/BadA.txt'],
      ['Dependent', 'dependency-incomplete', 'Dependent.txt'],
    ]);

    // The manifest also says who imports the placeholder and carries the fingerprints an overlay diffs against.
    // Those two are what make a hand-written replacement maintainable across a pin move rather than a one-shot
    // dump: the consumers are the callers it must satisfy, and the fingerprints move when the source under it
    // does.
    const refusedModule = best.report.bestEffort?.modules.find((module) => module.module.name === 'BadA');
    expect(refusedModule?.consumers).toEqual(['@local/source/packages/source/src/dependent.ts']);
    expect(refusedModule?.declarationFingerprints).toHaveLength(1);
    expect(refusedModule?.declarationFingerprints?.[0]).toMatch(/^sha256:/u);
    // A module that emitted is not a placeholder, so it carries no fingerprints -- only the ones an overlay
    // replaces need drift detection.
    const emittedModule = best.report.bestEffort?.modules.find((module) => module.module.name === 'Dependent');
    expect(emittedModule?.declarationFingerprints).toBeUndefined();
    expect(emittedModule?.consumers).toEqual([]);

    // A module that produced output reports as emitted, and the inherited refusal stays visible in its refusals
    // rather than being quietly dropped.
    const dependentReport = best.report.modules.find((module) => module.module.name === 'Dependent');
    expect(dependentReport?.status).toBe('emitted');
    expect(dependentReport?.outputFiles).toEqual(['Dependent.txt']);
    expect(dependentReport?.refusals.map((refusal) => refusal.code)).toEqual(['dependency-refused']);
    const refusedReport = best.report.modules.find((module) => module.module.name === 'BadA');
    expect(refusedReport?.status).toBe('refused');
    expect(refusedReport?.outputFiles).toEqual([]);
    expect(refusedReport?.refusals).toEqual([
      expect.objectContaining({ rule: 'fixture-session-placeholder', stage: 'emission' }),
    ]);
    expect(sessionPlaceholderCalls).toBe(1);
    expect(backendPlaceholderCalls).toBe(0);

    const reordered = compile(true, [badA, dependent]);
    expect(reordered.compilation.files).toEqual(best.compilation.files);
    expect(reordered.report.bestEffort).toEqual(best.report.bestEffort);
    expect(sessionPlaceholderCalls).toBe(2);
    expect(backendPlaceholderCalls).toBe(0);
  });

  it('reports bounded lowering and per-module emission progress without changing the compilation', () => {
    const good = source('@local/source', 'source', 'good.ts', 'export const good = 1;');
    const bad = source('@local/source', 'source', 'bad.ts', 'export const bad = 2;');
    const goodIdentity = identity(good, 'Good');
    const badIdentity = identity(bad, 'Bad');
    const progress: CompilerPackageCompilationProgress[] = [];
    let observing = true;
    const backend: CompilerBackend = {
      createEmissionSession: () => {
        if (observing) {
          expect(progress.at(-1)).toMatchObject({ phase: 'emission-session', state: 'started' });
        }
        return {
          emitModule(module) {
            if (observing) {
              expect(progress.at(-1)).toEqual({
                completedModules: module.name === 'Bad' ? 0 : 1,
                module: module.name === 'Bad' ? badIdentity : goodIdentity,
                moduleCount: 2,
                phase: 'module-emission',
                schema: 'flight-compiler-package-compilation-progress/1',
                state: 'started',
              });
            }
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
    const options = {
      backend,
      backendOptions: {},
      graph: graph([], [], [{ dependencies: [], name: '@local/source', root: good.packageRoot }]),
      sources: [good, bad],
    };

    const observed = compileTypeScriptPackageGraph({
      ...options,
      observeProgress(event) {
        expect(Object.isFrozen(event)).toBe(true);
        if ('module' in event) expect(Object.isFrozen(event.module)).toBe(true);
        progress.push(event);
      },
    });
    observing = false;
    const silent = compileTypeScriptPackageGraph(options);

    expect(progress).toEqual([
      {
        moduleCount: 2,
        phase: 'lowering',
        schema: 'flight-compiler-package-compilation-progress/1',
        state: 'started',
      },
      {
        completedModules: 0,
        module: goodIdentity,
        moduleCount: 2,
        phase: 'module-lowering',
        schema: 'flight-compiler-package-compilation-progress/1',
        state: 'started',
      },
      {
        completedModules: 1,
        module: goodIdentity,
        moduleCount: 2,
        phase: 'module-lowering',
        schema: 'flight-compiler-package-compilation-progress/1',
        state: 'completed',
      },
      {
        completedModules: 1,
        module: badIdentity,
        moduleCount: 2,
        phase: 'module-lowering',
        schema: 'flight-compiler-package-compilation-progress/1',
        state: 'started',
      },
      {
        completedModules: 2,
        module: badIdentity,
        moduleCount: 2,
        phase: 'module-lowering',
        schema: 'flight-compiler-package-compilation-progress/1',
        state: 'completed',
      },
      {
        moduleCount: 2,
        phase: 'lowering',
        schema: 'flight-compiler-package-compilation-progress/1',
        state: 'completed',
      },
      {
        moduleCount: 2,
        phase: 'emission-session',
        schema: 'flight-compiler-package-compilation-progress/1',
        state: 'started',
      },
      {
        moduleCount: 2,
        phase: 'emission-session',
        schema: 'flight-compiler-package-compilation-progress/1',
        state: 'completed',
      },
      {
        completedModules: 0,
        module: badIdentity,
        moduleCount: 2,
        phase: 'module-emission',
        schema: 'flight-compiler-package-compilation-progress/1',
        state: 'started',
      },
      {
        completedModules: 1,
        module: badIdentity,
        moduleCount: 2,
        outcome: 'refused',
        phase: 'module-emission',
        schema: 'flight-compiler-package-compilation-progress/1',
        state: 'completed',
      },
      {
        completedModules: 1,
        module: goodIdentity,
        moduleCount: 2,
        phase: 'module-emission',
        schema: 'flight-compiler-package-compilation-progress/1',
        state: 'started',
      },
      {
        completedModules: 2,
        module: goodIdentity,
        moduleCount: 2,
        outcome: 'emitted',
        phase: 'module-emission',
        schema: 'flight-compiler-package-compilation-progress/1',
        state: 'completed',
      },
    ]);
    expect(observed).toEqual(silent);

    const interruptedJsonLines: string[] = [];
    expect(() =>
      compileTypeScriptPackageGraph({
        ...options,
        observeProgress(event) {
          interruptedJsonLines.push(JSON.stringify(event));
          if (event.phase === 'module-lowering' && event.module.name === 'Bad' && event.state === 'started') {
            throw new Error('simulated stalled source boundary');
          }
        },
      }),
    ).toThrow('simulated stalled source boundary');
    expect(JSON.parse(interruptedJsonLines.at(-1)!) as unknown).toEqual({
      completedModules: 1,
      module: badIdentity,
      moduleCount: 2,
      phase: 'module-lowering',
      schema: 'flight-compiler-package-compilation-progress/1',
      state: 'started',
    });
  });

  it('carries a backend refusal rule into the report so instances of one decision group together', () => {
    const badA = source('@local/source', 'source', 'badA.ts', 'export const badA = 1;');
    const badB = source('@local/source', 'source', 'badB.ts', 'export const badB = 2;');
    const stated = source('@local/source', 'source', 'stated.ts', 'export const stated = 3;');
    const backend: CompilerBackend = {
      emitModule(module) {
        if (module.name === 'BadA') {
          throw createBackendEmissionFailure(
            'fixture',
            module,
            'missing: SharedArrayBuffer[type]',
            'cpp-missing-binding',
          );
        }
        if (module.name === 'BadB') {
          throw createBackendEmissionFailure('fixture', module, 'missing: MapIterator[type]', 'cpp-missing-binding');
        }
        throw createBackendEmissionFailure(
          'fixture',
          module,
          'object getters require target-specific accessor lowering',
        );
      },
      name: 'fixture',
    };
    const result = compileTypeScriptPackageGraph({
      backend,
      backendOptions: {},
      graph: graph([], [], [{ dependencies: [], name: '@local/source', root: stated.packageRoot }]),
      sources: [badA, badB, stated],
    });

    const refusalOf = (name: string) =>
      result.report.modules.find((module) => module.module.name === name)?.refusals[0];
    // Two instances, two messages, one rule: that pair is the whole reason the field exists.
    expect(refusalOf('BadA')?.message).not.toBe(refusalOf('BadB')?.message);
    expect(refusalOf('BadA')?.rule).toBe('cpp-missing-binding');
    expect(refusalOf('BadB')?.rule).toBe('cpp-missing-binding');
    expect(refusalOf('BadA')?.classification).toBe('compiler-restriction');
    expect(refusalOf('BadB')?.classification).toBe('compiler-restriction');
    // A message that names no instance is already the identity, so it carries no second spelling.
    expect(refusalOf('Stated')?.rule).toBeUndefined();
    expect(refusalOf('Stated')?.classification).toBe('compiler-restriction');
    expect(refusalOf('Stated')?.message).toBe(
      'fixture emission failed for @local/source/packages/source/src/stated.ts: object getters require target-specific accessor lowering',
    );
  });

  it('records stable lowering codes and source locations while emitting unaffected modules', () => {
    const good = source('@local/source', 'source', 'good.ts', 'export const good = 1;');
    const bad = source(
      '@local/source',
      'source',
      'bad.ts',
      'export const retained = 1;\nexport namespace A { export function f(): number { return 1; } }\nexport namespace B { export function g(): number { return 2; } }',
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

  it('emits modules with warning-severity type alias diagnostics rather than refusing them', () => {
    const mixed = source(
      '@local/source',
      'source',
      'mixed.ts',
      'export type Mapped<T> = { [K in keyof T]: T[K] }; export const value = 1;',
    );
    const backend: CompilerBackend = {
      emitModule: (module) => [{ contents: module.name, path: `${module.name}.txt` }],
      name: 'fixture',
    };
    const result = compileTypeScriptPackageGraph({
      backend,
      backendOptions: {},
      graph: graph(
        [identity(mixed, 'Mixed')],
        [],
        [{ dependencies: [], name: '@local/source', root: mixed.packageRoot }],
      ),
      sources: [mixed],
    });

    expect(result.compilation.files.map((file) => file.path)).toEqual(['Mixed.txt']);
    expect(result.report.modules[0]).toMatchObject({
      module: identity(mixed, 'Mixed'),
      outputFiles: ['Mixed.txt'],
      status: 'emitted',
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
      result.report.modules.map((module) => [
        module.module.name,
        module.refusals[0]?.classification,
        module.refusals[0]?.code,
        module.refusals[0]?.stage,
      ]),
    ).toEqual([
      ['Broken', undefined, 'internal-error', 'emission'],
      ['Collision-a', 'compiler-defect', 'duplicate-emitted-path', 'emission'],
      ['Collision-b', 'compiler-defect', 'duplicate-emitted-path', 'emission'],
      ['Unsafe', 'compiler-defect', 'unsafe-emitted-path', 'emission'],
    ]);
  });

  // An emitted path is package-relative, so the same name in two packages is the ordinary workspace shape and
  // the same name twice in one package is the defect. The SDK emits 146 `contract.hpp`, one per package, and
  // refusing those refused every module in the run.
  it('keeps a package-local name distinct across packages while still refusing it twice in one package', () => {
    const alpha = source('@flight/alpha', 'alpha', 'index.ts', 'export const alphaValue = 1;');
    const beta = source('@flight/beta', 'beta', 'index.ts', 'export const betaValue = 2;');
    const betaTwin = source('@flight/beta', 'beta', 'twin.ts', 'export const betaTwin = 3;');
    const backend: CompilerBackend = {
      emitModule: (module) => [{ contents: module.name, path: 'contract.hpp' }],
      name: 'fixture',
    };
    const result = compileTypeScriptPackageGraph({
      backend,
      backendOptions: {},
      graph: graph(
        [],
        [],
        [
          { dependencies: [], name: '@flight/alpha', root: alpha.packageRoot },
          { dependencies: [], name: '@flight/beta', root: beta.packageRoot },
        ],
      ),
      sources: [alpha, beta, betaTwin],
    });

    // Alpha's file survives, because nothing else in alpha emits that path.
    expect(result.compilation.files).toEqual([{ contents: 'Index\n', path: 'contract.hpp' }]);
    expect(
      result.report.modules.map((module) => [module.module.packageName, module.module.name, module.refusals[0]?.code]),
    ).toEqual([
      ['@flight/alpha', 'Index', undefined],
      ['@flight/beta', 'Index', 'duplicate-emitted-path'],
      ['@flight/beta', 'Twin', 'duplicate-emitted-path'],
    ]);
    expect(result.report.modules[1]?.refusals[0]?.message).toBe(
      'Backend emitted colliding package file path: @flight/beta/contract.hpp',
    );
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
        classification: 'compiler-restriction',
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
    const a = source(
      '@local/source',
      'source',
      'alpha.ts',
      'export const retained = 1;\nexport namespace A { export function f(): number { return 1; } }\nexport namespace B { export function g(): number { return 2; } }',
    );
    const b = source(
      '@local/source',
      'source',
      'beta.ts',
      'export const retained = 1;\nexport namespace B { export function g(): number { return 2; } }\nexport namespace A { export function f(): number { return 1; } }',
    );
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

  it('splits a named barrel request across its exact source modules', () => {
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

    expect(getFixtureDependencyTargets(result, 'Consumer')).toEqual(['Alpha', 'Beta']);
    expect(
      result.report.initialization.modules.find((module) => module.module.name === 'Consumer')?.dependencies,
    ).toEqual([
      expect.objectContaining({ importedNames: ['alpha'], target: expect.objectContaining({ name: 'Alpha' }) }),
      expect.objectContaining({ importedNames: ['beta'], target: expect.objectContaining({ name: 'Beta' }) }),
    ]);
  });

  it('does not cascade an unrelated multi-source barrel refusal to a named-import consumer', () => {
    const alpha = source('@local/source', 'source', 'alpha.ts', 'export const alpha = 1;');
    const beta = source('@local/source', 'source', 'beta.ts', 'export const beta = 2;');
    const bad = source('@local/source', 'source', 'bad.ts', 'export const bad = 3;');
    const barrel = source(
      '@local/source',
      'source',
      'barrel.ts',
      "export * from './alpha.js'; export * from './beta.js'; export * from './bad.js';",
    );
    const consumer = source(
      '@local/source',
      'source',
      'consumer.ts',
      "import { alpha, beta } from './barrel.js'; export const value = alpha + beta;",
    );
    const result = compileFixturePackageGraph([barrel, bad, consumer, beta, alpha], consumer, {
      emitModule(module) {
        if (module.name === 'Bad') throw createBackendEmissionFailure('fixture', module, 'unsupported bad value');
        return [{ contents: module.name, path: `${module.name}.txt` }];
      },
      name: 'fixture',
    });

    expect(result.report.modules.find((module) => module.module.name === 'Consumer')).toMatchObject({
      refusals: [],
      status: 'emitted',
    });
    expect(getFixtureDependencyTargets(result, 'Consumer')).toEqual(['Alpha', 'Beta']);
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
    const value = source('@local/source', 'source', 'value.ts', 'export const retained = 1;\ndebugger; debugger;');
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

describe('compileTypeScriptPackageGraph finalization refusal evidence', () => {
  it('hands the backend one deterministic refusal entry per refused module in best-effort', () => {
    const consumer = source(
      '@local/source',
      'source',
      'consumer.ts',
      "import { values } from './provider.js';\nimport { values as alphaValues } from './alpha.js';\nexport { alphaValues, values };",
    );
    const provider = source('@local/source', 'source', 'provider.ts', 'export const values: number[] = [1, 2];');
    const alpha = source('@local/source', 'source', 'alpha.ts', 'export const values: number[] = [3];');
    const consumerIdentity = identity(consumer, 'Consumer');
    const providerIdentity = identity(provider, 'Provider');
    const alphaIdentity = identity(alpha, 'Alpha');
    const received: CompilerBackendPackageGraphFinalization[] = [];
    const backend: CompilerBackend = {
      createEmissionSession: () => ({
        emitModule(module) {
          if (module.source.endsWith('provider.ts')) {
            throw createBackendEmissionFailure(
              'fixture',
              module,
              'provider values are not representable',
              'fixture-provider-values',
            );
          }
          if (module.source.endsWith('alpha.ts')) {
            throw createBackendEmissionFailure(
              'fixture',
              module,
              'alpha values are not representable',
              'fixture-alpha-values',
            );
          }
          return [{ contents: module.name, path: `${module.name}.txt` }];
        },
        finalizePackageGraph(finalization) {
          received.push(finalization);
          return { packageFiles: [] };
        },
      }),
      emitModule: () => {
        throw new Error('the emission session must be used');
      },
      name: 'fixture',
    };
    const compile = (sources: readonly ReturnType<typeof source>[]) =>
      compileTypeScriptPackageGraph({
        backend,
        backendOptions: {},
        bestEffort: true,
        graph: graph(
          [consumerIdentity],
          [
            { importer: consumerIdentity, specifier: './provider.js', target: providerIdentity },
            { importer: consumerIdentity, specifier: './alpha.js', target: alphaIdentity },
          ],
          [{ dependencies: [], name: '@local/source', root: consumer.packageRoot }],
        ),
        sources,
      });

    compile([consumer, provider, alpha]);
    compile([alpha, provider, consumer]);

    expect(received).toHaveLength(2);
    for (const finalization of received) {
      expect(finalization.moduleFiles.map(({ module }) => module.source)).toEqual(['packages/source/src/consumer.ts']);
      expect(finalization.refusals).toEqual([
        {
          code: 'fixture-alpha-values',
          message:
            'fixture emission failed for @local/source/packages/source/src/alpha.ts: alpha values are not representable',
          module: alphaIdentity,
        },
        {
          code: 'fixture-provider-values',
          message:
            'fixture emission failed for @local/source/packages/source/src/provider.ts: provider values are not representable',
          module: providerIdentity,
        },
      ]);
    }
  });
});

describe('isCompilerBackendFinalizationFailure', () => {
  it('recognizes a complete finalization failure and rejects incomplete or unrelated values', () => {
    const failure = Object.assign(new Error('finalization failed'), {
      backend: 'rust',
      code: 'rust-source-tree-import-target-absent',
      kind: 'compiler-backend-finalization',
      subjects: ['subject'],
    });
    const change = (changes: Readonly<Record<string, unknown>>) =>
      Object.assign(new Error('changed'), { ...failure }, changes);

    expect(isCompilerBackendFinalizationFailure(failure)).toBe(true);
    expect(isCompilerBackendFinalizationFailure(change({ code: undefined, subjects: undefined }))).toBe(true);
    expect(isCompilerBackendFinalizationFailure(new Error('plain'))).toBe(false);
    expect(isCompilerBackendFinalizationFailure(change({ kind: 'backend-emission' }))).toBe(false);
    expect(isCompilerBackendFinalizationFailure(change({ backend: '' }))).toBe(false);
    expect(isCompilerBackendFinalizationFailure(change({ code: '' }))).toBe(false);
    expect(isCompilerBackendFinalizationFailure(change({ code: 1 }))).toBe(false);
    expect(isCompilerBackendFinalizationFailure(change({ subjects: [] }))).toBe(false);
    expect(isCompilerBackendFinalizationFailure(change({ subjects: [''] }))).toBe(false);
    expect(isCompilerBackendFinalizationFailure(change({ subjects: [1] }))).toBe(false);
  });
});
