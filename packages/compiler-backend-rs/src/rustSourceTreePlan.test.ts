import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type {
  CompilerModuleFacadePlan,
  CompilerModuleIdentity,
  CompilerModuleResolutionPlan,
  CompilerRustSourceTreePlan,
  CompilerRustSourceTreePlanningFailure,
  CompilerRustSourceTreePlanningFailureCode,
  CompilerRustSourceTreeUnavailableModule,
  IrModule,
} from '../../compiler-types/src/index.js';
import { createCompilerRustSourceTreePlan, isCompilerRustSourceTreePlanningFailure } from './rustSourceTreePlan.js';

describe('createCompilerRustSourceTreePlan', () => {
  it('combines root and nested index owners with their child declarations', () => {
    const root = lower('@scope/math', 'index.ts', 'export const root = 1;');
    const nested = lower('@scope/math', 'geometry/index.ts', 'export const geometry = 1;');
    const line = lower('@scope/math', 'geometry/line.ts', 'export interface Line { length: number }');
    const plan = createPlan([line, root, nested], [root]);
    const rootFile = findFile(plan, '@scope/math', []);
    const nestedFile = findFile(plan, '@scope/math', ['geometry']);

    expect(rootFile.declarations).toEqual([{ modulePath: ['geometry'], name: 'geometry', visibility: 'crate' }]);
    expect(rootFile).toMatchObject({
      filePath: 'lib.rs',
      ownership: { kind: 'source', module: identity(root) },
      sourceFragment: 'pub(crate) mod geometry;',
    });
    expect(nestedFile.declarations).toEqual([{ modulePath: ['geometry', 'line'], name: 'line', visibility: 'crate' }]);
    expect(nestedFile).toMatchObject({
      filePath: 'geometry/mod.rs',
      ownership: { kind: 'source', module: identity(nested) },
      sourceFragment: 'pub(crate) mod line;',
    });
    expect(plan.files).toHaveLength(3);
  });

  it('synthesizes missing root and intermediate indexes with descendant provenance', () => {
    const point = lower('@scope/math', 'geometry/shapes/point.ts', 'export interface Point { x: number }');
    const plan = createPlan([point], [point]);

    expect(findFile(plan, '@scope/math', [])).toEqual({
      declarations: [{ modulePath: ['geometry'], name: 'geometry', visibility: 'public' }],
      filePath: 'lib.rs',
      modulePath: [],
      ownership: { kind: 'skeleton', provenance: [identity(point)] },
      packageName: '@scope/math',
      sourceFragment: 'pub mod geometry;',
    });
    expect(findFile(plan, '@scope/math', ['geometry'])).toMatchObject({
      filePath: 'geometry/mod.rs',
      ownership: { kind: 'skeleton', provenance: [identity(point)] },
      sourceFragment: 'pub mod shapes;',
    });
    expect(findFile(plan, '@scope/math', ['geometry', 'shapes'])).toMatchObject({
      filePath: 'geometry/shapes/mod.rs',
      ownership: { kind: 'skeleton', provenance: [identity(point)] },
      sourceFragment: 'pub mod point;',
    });
    expect(findFile(plan, '@scope/math', ['geometry', 'shapes', 'point'])).toMatchObject({
      filePath: 'geometry/shapes/point.rs',
      ownership: { kind: 'source' },
      sourceFragment: '',
    });
  });

  it('marks only module edges required by actual facade visibility as public', () => {
    const root = lower('@scope/math', 'index.ts', 'export const root = 1;');
    const publicApi = lower('@scope/math', 'api/contract.ts', 'export const contract = 1;');
    const privateValue = lower('@scope/math', 'internal/value.ts', 'export const value = 1;');
    const plan = createPlan([privateValue, root, publicApi], [publicApi]);
    const rootFile = findFile(plan, '@scope/math', []);
    const internalFile = findFile(plan, '@scope/math', ['internal']);

    expect(rootFile.declarations).toEqual([
      { modulePath: ['api'], name: 'api', visibility: 'public' },
      { modulePath: ['internal'], name: 'internal', visibility: 'crate' },
    ]);
    expect(rootFile.sourceFragment).toBe('pub mod api;\npub(crate) mod internal;');
    expect(findFile(plan, '@scope/math', ['api']).sourceFragment).toBe('pub mod contract;');
    expect(internalFile.declarations).toEqual([
      { modulePath: ['internal', 'value'], name: 'value', visibility: 'crate' },
    ]);
    expect(internalFile).toMatchObject({
      ownership: { kind: 'skeleton' },
      sourceFragment: 'pub(crate) mod value;',
    });
  });

  it('makes the exact target path of a namespace facade slot public', () => {
    const entry = lower('@scope/math', 'index.ts', "export * as geometryTools from './geometry/tools.js';");
    const tools = lower('@scope/math', 'geometry/tools.ts', 'export const answer = 42;');
    const privateValue = lower('@scope/math', 'internal/value.ts', 'export const value = 1;');
    const facade = createFacade([entry]);
    const namespaceFacade: CompilerModuleFacadePlan = {
      ...facade,
      modules: [
        {
          module: identity(entry),
          slots: [
            {
              exportName: 'geometryTools',
              identity: 'fixture:value:geometryTools',
              lane: 'value',
              module: identity(entry),
              route: { kind: 'namespace', module: identity(tools) },
              source: { kind: 'module-namespace', specifier: './geometry/tools.js' },
              via: [
                {
                  kind: 'namespace-reexport',
                  module: identity(entry),
                  specifier: './geometry/tools.js',
                  target: identity(tools),
                },
              ],
            },
          ],
        },
      ],
    };
    const plan = createCompilerRustSourceTreePlan({
      facade: namespaceFacade,
      moduleResolution: {
        edges: [
          {
            importer: identity(entry),
            specifier: './geometry/tools.js',
            target: identity(tools),
          },
        ],
        schema: 'flight-compiler-module-resolution/1',
      },
      modules: [privateValue, tools, entry],
    });

    expect(findFile(plan, '@scope/math', []).sourceFragment).toBe('pub mod geometry;\npub(crate) mod internal;');
    expect(findFile(plan, '@scope/math', ['geometry']).sourceFragment).toBe('pub mod tools;');
    expect(findFile(plan, '@scope/math', ['internal']).sourceFragment).toBe('pub(crate) mod value;');
  });

  it('plans scoped multi-package files and canonical same- and cross-crate references', () => {
    const entry = lower('@alpha/math', 'index.ts', "import { useValue } from './nested/use.js'; export { useValue };");
    const use = lower(
      '@alpha/math',
      'nested/use.ts',
      "import type { Value } from '@beta/types/value'; export function useValue(value: Value): number { return value.size; }",
    );
    const value = lower('@beta/types', 'deep/value.ts', 'export interface Value { size: number }');
    const resolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          importer: identity(entry),
          specifier: './nested/use.js',
          target: identity(use),
        },
        {
          importer: identity(use),
          specifier: '@beta/types/value',
          target: identity(value),
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const facade = createFacade([entry]);
    const first = createCompilerRustSourceTreePlan({
      facade,
      moduleResolution: resolution,
      modules: [value, entry, use],
    });
    const second = createCompilerRustSourceTreePlan({
      facade: { ...facade, modules: [...facade.modules].reverse() },
      moduleResolution: { ...resolution, edges: [...resolution.edges].reverse() },
      modules: [use, entry, value],
    });

    expect(second).toEqual(first);
    expect(isDeeplyFrozen(first, new WeakSet())).toBe(true);
    expect(first.modules.map((module) => module.filePath)).toEqual([
      'alpha-math/src/lib.rs',
      'alpha-math/src/nested/use_.rs',
      'beta-types/src/deep/value.rs',
    ]);
    expect(first.references.map((reference) => [reference.specifier, reference.rustPath])).toEqual([
      ['./nested/use.js', 'crate::nested::use_'],
      ['@beta/types/value', 'beta_types::deep::value'],
    ]);
    expect(first.files.some((file) => /Cargo\.toml|Cargo\.lock/u.test(file.filePath))).toBe(false);
  });

  it('fails loudly on module, file, crate, public-facade, and import ambiguity', () => {
    const root = lower('@scope/math', 'index.ts', 'export const root = 1;');
    const lib = lower('@scope/math', 'lib.ts', 'export const lib = 1;');
    expectPlanningFailure([root, lib], [root], undefined, 'rust-source-tree-file-collision');

    const file = lower('@scope/math', 'values.ts', 'export const file = 1;');
    const index = lower('@scope/math', 'values/index.ts', 'export const index = 1;');
    expectPlanningFailure([file, index], [file], undefined, 'rust-source-tree-module-collision');

    const firstCrate = lower('@scope-a/model', 'first.ts', 'export const first = 1;');
    const secondCrate = lower('@scope_a/model', 'second.ts', 'export const second = 2;');
    expectPlanningFailure([firstCrate, secondCrate], [firstCrate], undefined, 'rust-source-tree-crate-collision');

    const absentPublicModule = lower('@scope/math', 'absent.ts', 'export const absent = 1;');
    expectPlanningFailure([root], [absentPublicModule], undefined, 'rust-source-tree-public-module-missing');

    const consumer = lower('@scope/math', 'consumer.ts', "import { value } from './value'; export { value };");
    const firstTarget = lower('@scope/math', 'first.ts', 'export const value = 1;');
    const secondTarget = lower('@scope/math', 'second.ts', 'export const value = 2;');
    expectPlanningFailure(
      [consumer, firstTarget, secondTarget],
      [consumer],
      {
        edges: [
          { importer: identity(consumer), specifier: './value', target: identity(firstTarget) },
          { importer: identity(consumer), specifier: './value', target: identity(secondTarget) },
        ],
        schema: 'flight-compiler-module-resolution/1',
      },
      'rust-source-tree-import-ambiguity',
    );
    expectPlanningFailure(
      [consumer, firstTarget, secondTarget],
      [consumer],
      {
        edges: [
          { importer: identity(consumer), specifier: './value', target: identity(firstTarget) },
          {
            importedNames: ['value'],
            importer: identity(consumer),
            specifier: './value',
            target: identity(secondTarget),
          },
        ],
        schema: 'flight-compiler-module-resolution/1',
      },
      'rust-source-tree-import-ambiguity',
    );
    expectPlanningFailure([consumer], [consumer], undefined, 'rust-source-tree-import-target-absent');
  });

  it('distinguishes a refused, unselected, and absent imported target', () => {
    const consumer = lower('@scope/math', 'consumer.ts', "import { value } from './value'; export { value };");
    const target = lower('@scope/math', 'value.ts', 'export const value = 1;');
    const refused: CompilerRustSourceTreeUnavailableModule = {
      code: 'rust-module-array-value-unrepresented',
      disposition: 'refused',
      message: 'module array value value requires runtime initialization',
      module: identity(target),
    };
    const unselected: CompilerRustSourceTreeUnavailableModule = {
      disposition: 'unselected',
      module: identity(target),
    };

    const refusedFailure = captureTargetFailure([consumer], undefined, [refused]);
    expect(refusedFailure.code).toBe('rust-source-tree-import-target-refused');
    expect(refusedFailure.message).toContain(
      'which was refused: rust-module-array-value-unrepresented: module array value value requires runtime initialization',
    );
    expect(refusedFailure.message).toContain('@scope/math/packages/math/src/value.ts#Value');
    expect(refusedFailure.message).not.toContain('\0');
    expect(refusedFailure.subjects).toHaveLength(2);

    const unselectedFailure = captureTargetFailure([consumer], undefined, [unselected]);
    expect(unselectedFailure.code).toBe('rust-source-tree-import-target-unselected');
    expect(unselectedFailure.message).toContain('which is not selected for this output');

    const absentFailure = captureTargetFailure([consumer], undefined, []);
    expect(absentFailure.code).toBe('rust-source-tree-import-target-absent');
    expect(absentFailure.message).toContain('has no target module in this compilation');
    expect(absentFailure.message).not.toContain('\0');
  });

  it('attributes an edge-resolved import from the same evidence', () => {
    const consumer = lower('@scope/math', 'consumer.ts', "import { value } from './value'; export { value };");
    const target = lower('@scope/math', 'value.ts', 'export const value = 1;');
    const moduleResolution: CompilerModuleResolutionPlan = {
      edges: [{ importer: identity(consumer), specifier: './value', target: identity(target) }],
      schema: 'flight-compiler-module-resolution/1',
    };
    const failure = captureTargetFailure([consumer], moduleResolution, [
      {
        code: 'rust-module-array-value-unrepresented',
        disposition: 'refused',
        message: 'module array value value requires runtime initialization',
        module: identity(target),
      },
    ]);

    expect(failure.code).toBe('rust-source-tree-import-target-refused');
    expect(failure.message).toContain('targets @scope/math/packages/math/src/value.ts#Value');
  });

  it('answers the same imported-target failure when the evidence order is reversed', () => {
    const consumer = lower('@scope/math', 'consumer.ts', "import { value } from './value'; export { value };");
    const target = lower('@scope/math', 'value.ts', 'export const value = 1;');
    const other = lower('@scope/math', 'other.ts', 'export const other = 1;');
    const evidence: readonly CompilerRustSourceTreeUnavailableModule[] = [
      {
        code: 'rust-module-array-value-unrepresented',
        disposition: 'refused',
        message: 'module array value value requires runtime initialization',
        module: identity(target),
      },
      { disposition: 'unselected', module: identity(other) },
    ];

    const first = captureTargetFailure([consumer], undefined, evidence);
    const second = captureTargetFailure([consumer], undefined, [...evidence].reverse());

    expect(second.code).toBe(first.code);
    expect(second.message).toBe(first.message);
    expect(second.subjects).toEqual(first.subjects);
  });

  it('does not mutate caller-owned graph facts', () => {
    const module = lower('@scope/math', 'value.ts', 'export const value = 1;');
    const input = { facade: createFacade([module]), modules: [module] } as const;
    const snapshot = structuredClone(input);

    createCompilerRustSourceTreePlan(input);

    expect(input).toEqual(snapshot);
  });
});

describe('isCompilerRustSourceTreePlanningFailure', () => {
  it('recognizes complete planning failures and rejects lookalikes', () => {
    const failure = Object.assign(new Error('collision'), {
      code: 'rust-source-tree-file-collision',
      kind: 'rust-source-tree-planning',
      subjects: ['first', 'second'],
    });

    expect(isCompilerRustSourceTreePlanningFailure(failure)).toBe(true);
    expect(isCompilerRustSourceTreePlanningFailure(new Error('plain'))).toBe(false);
    expect(isCompilerRustSourceTreePlanningFailure({ ...failure })).toBe(false);
    expect(
      isCompilerRustSourceTreePlanningFailure(Object.assign(new Error('empty'), { ...failure, subjects: [] })),
    ).toBe(false);
    expect(
      isCompilerRustSourceTreePlanningFailure(Object.assign(new Error('unknown'), { ...failure, code: 'unknown' })),
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

function createPlan(modules: readonly Readonly<IrModule>[], publicModules: readonly Readonly<IrModule>[]) {
  return createCompilerRustSourceTreePlan({ facade: createFacade(publicModules), modules });
}

function expectPlanningFailure(
  modules: readonly Readonly<IrModule>[],
  publicModules: readonly Readonly<IrModule>[],
  moduleResolution: Readonly<CompilerModuleResolutionPlan> | undefined,
  code: CompilerRustSourceTreePlanningFailureCode,
): void {
  let failure: unknown;
  try {
    createCompilerRustSourceTreePlan({
      facade: createFacade(publicModules),
      ...(moduleResolution ? { moduleResolution } : {}),
      modules,
    });
  } catch (error) {
    failure = error;
  }
  expect(isCompilerRustSourceTreePlanningFailure(failure)).toBe(true);
  if (!isCompilerRustSourceTreePlanningFailure(failure)) throw failure;
  expect(failure.code).toBe(code);
}

function captureTargetFailure(
  modules: readonly Readonly<IrModule>[],
  moduleResolution: Readonly<CompilerModuleResolutionPlan> | undefined,
  unavailableModules: readonly CompilerRustSourceTreeUnavailableModule[],
): CompilerRustSourceTreePlanningFailure {
  let failure: unknown;
  try {
    createCompilerRustSourceTreePlan({
      facade: createFacade(modules),
      ...(moduleResolution ? { moduleResolution } : {}),
      modules,
      ...(unavailableModules.length === 0 ? {} : { unavailableModules }),
    });
  } catch (error) {
    failure = error;
  }
  if (!isCompilerRustSourceTreePlanningFailure(failure)) {
    throw failure instanceof Error ? failure : new Error('expected a Rust source-tree planning failure');
  }
  return failure;
}

function findFile(plan: Readonly<CompilerRustSourceTreePlan>, packageName: string, modulePath: readonly string[]) {
  const file = plan.files.find(
    (candidate) =>
      candidate.packageName === packageName &&
      candidate.modulePath.length === modulePath.length &&
      candidate.modulePath.every((segment, index) => segment === modulePath[index]),
  );
  if (!file) throw new Error(`Missing source-tree file ${packageName}/${modulePath.join('/')}`);
  return file;
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
