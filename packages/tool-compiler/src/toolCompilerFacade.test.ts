import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  compileTypeScriptModules,
  compileTypeScriptPackageGraph,
  createCppCompilerBackend,
  createHaxeCompilerBackend,
  createRustCompilerBackend,
  parseTypeScriptSource,
} from './index.js';
import type { CompilerRustPublicBindingPlan, EmittedFile } from './index.js';

const rustcAvailable = spawnSync('rustc', ['--version'], { stdio: 'ignore' }).status === 0;

function compileFinalizedRustSourceTree(files: readonly Readonly<EmittedFile>[]): void {
  const directory = mkdtempSync(path.join(tmpdir(), 'flight-rust-public-linking-'));
  try {
    for (const file of files) writeFileSync(path.join(directory, file.path), file.contents);
    const build = spawnSync(
      'rustc',
      [
        '--edition',
        '2021',
        '--crate-type=lib',
        '--emit=metadata',
        '-o',
        path.join(directory, 'subject.rmeta'),
        path.join(directory, 'lib.rs'),
      ],
      { encoding: 'utf8' },
    );
    if (build.status !== 0) throw new Error(`${build.stdout ?? ''}${build.stderr ?? ''}`.trim());
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

const sourceText = `
export type Range = { min: number; max: number };

export const EPSILON: number = 0.000001;

export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
`;

describe('@flighthq/tool-compiler', () => {
  it('exposes one deterministic compiler with Haxe and Rust backends', () => {
    const input = {
      packageName: '@flighthq/math',
      sourceFile: parseTypeScriptSource('/flight/packages/math/src/clamp.ts', sourceText),
      upstreamDirectory: '/flight',
    };
    const haxeBackend = createHaxeCompilerBackend();
    const rustBackend = createRustCompilerBackend();
    const haxe = compileTypeScriptModules({ backend: haxeBackend, backendOptions: {}, sources: [input] });
    const rust = compileTypeScriptModules({ backend: rustBackend, backendOptions: {}, sources: [input] });

    expect(haxe.compilation.files[0]?.path).toBe('flighthq/math/Clamp.hx');
    expect(haxe.compilation.files[0]?.contents).toContain('function clamp(value:Float, min:Float, max:Float):Float');
    expect(rust.compilation.files[0]?.path).toBe('clamp.rs');
    expect(rust.compilation.files[0]?.contents).toContain('pub fn clamp(value: f64, min: f64, max: f64) -> f64');
    expect(compileTypeScriptModules({ backend: haxeBackend, backendOptions: {}, sources: [input] })).toEqual(haxe);
  });

  it('reports the Rust public binding plan deterministically through the public facade', () => {
    const sources = [
      {
        packageName: '@scope/math',
        packageRoot: '/flight/packages/math',
        sourceFile: parseTypeScriptSource(
          '/flight/packages/math/src/nested/add.ts',
          'export function add(left: number, right: number): number { return left + right; }',
        ),
        upstreamDirectory: '/flight',
      },
      {
        packageName: '@scope/math',
        packageRoot: '/flight/packages/math',
        sourceFile: parseTypeScriptSource(
          '/flight/packages/math/src/nested/scale.ts',
          'export function scale(value: number): number { return value * 2; }',
        ),
        upstreamDirectory: '/flight',
      },
    ];
    const backend = createRustCompilerBackend();
    const compile = (orderedSources: typeof sources) =>
      compileTypeScriptPackageGraph({
        backend,
        backendOptions: {},
        graph: {
          entries: [],
          moduleDependencies: [],
          packages: [{ dependencies: [], name: '@scope/math', root: '/flight/packages/math' }],
          schema: 'flight-compiler-package-graph/1',
        },
        sources: orderedSources,
      });
    const first = compile(sources);
    const second = compile([...sources].reverse());

    expect(first.report.publicBindings).toEqual(second.report.publicBindings);
    expect(first.report.publicBindings).toMatchObject({
      crates: [{ cargoName: 'scope-math', packageName: '@scope/math', rustName: 'scope_math' }],
      modules: expect.arrayContaining([
        expect.objectContaining({ locator: expect.objectContaining({ modulePath: ['nested', 'add'] }) }),
        expect.objectContaining({ locator: expect.objectContaining({ modulePath: ['nested', 'scale'] }) }),
      ]),
      schema: 'flight-rust-public-binding-plan/2',
    });
  });

  it('reports a namespace module locator that agrees with finalized files reaching target compilation', () => {
    const entry = {
      packageName: '@scope/math',
      packageRoot: '/flight/packages/math',
      sourceFile: parseTypeScriptSource(
        '/flight/packages/math/src/index.ts',
        "export * as geometryTools from './geometry/tools.js';",
      ),
      upstreamDirectory: '/flight',
    };
    const tools = {
      packageName: '@scope/math',
      packageRoot: '/flight/packages/math',
      sourceFile: parseTypeScriptSource('/flight/packages/math/src/geometry/tools.ts', 'export const answer = 42;'),
      upstreamDirectory: '/flight',
    };
    const compile = (sources: readonly (typeof entry)[]) => {
      let compiledFiles: readonly Readonly<{ contents: string; path: string }>[] = [];
      const result = compileTypeScriptPackageGraph({
        backend: createRustCompilerBackend(),
        backendOptions: {},
        graph: {
          entries: [{ name: 'Index', packageName: '@scope/math', source: 'packages/math/src/index.ts' }],
          moduleDependencies: [],
          packages: [{ dependencies: [], name: '@scope/math', root: '/flight/packages/math' }],
          schema: 'flight-compiler-package-graph/1',
        },
        sources,
        targetCompilationSmoke: {
          compileEmittedSources(files) {
            compiledFiles = files;
            return [];
          },
          name: 'rustc-fixture',
          supportsEmittedSource: ({ path }) => path.endsWith('.rs'),
        },
      });
      return { compiledFiles, result };
    };
    const first = compile([entry, tools]);
    const second = compile([tools, entry]);

    expect(first.result.report.publicBindings).toBeDefined();
    expect(second.result.report.publicBindings).toEqual(first.result.report.publicBindings);
    expect(second.result.compilation.files).toEqual(first.result.compilation.files);
    expect(isDeeplyFrozen(first.result.report.publicBindings, new WeakSet())).toBe(true);
    expect(first.compiledFiles.map(({ path }) => path)).toEqual(['geometry/mod.rs', 'geometry/tools.rs', 'lib.rs']);
    expect(first.compiledFiles.map(({ path }) => path)).not.toContain('index.rs');
    expect(first.result.compilation.files.map(({ path }) => path)).toEqual([
      'geometry/mod.rs',
      'geometry/tools.rs',
      'lib.rs',
    ]);
    expect(first.result.compilation.files.find(({ path }) => path === 'lib.rs')?.contents).toContain(
      'pub use crate::geometry::tools as geometry_tools;',
    );
    expect(first.result.compilation.files.find(({ path }) => path === 'geometry/mod.rs')?.contents).toBe(
      'pub mod tools;\n',
    );
    expect(first.result.report.publicBindings).toMatchObject({
      bindings: [
        {
          binding: {
            availability: 'available',
            locator: {
              carrier: 'module',
              module: { modulePath: [] },
              spelling: 'geometry_tools',
              target: { modulePath: ['geometry', 'tools'] },
            },
          },
        },
      ],
      dependencies: [
        {
          from: { modulePath: [] },
          kind: 'namespace-reexport',
          specifier: './geometry/tools.js',
          target: { modulePath: ['geometry', 'tools'] },
        },
      ],
      schema: 'flight-rust-public-binding-plan/2',
    });
  });

  it.skipIf(!rustcAvailable)(
    'links indirect locals, allocated import reexports, and grounded explicit chains in one finalized Rust crate',
    () => {
      const packageName = '@checkpoint/public-linking';
      const packageRoot = '/flight/packages/public-linking';
      const module = (file: string, source: string) => ({
        packageName,
        packageRoot,
        sourceFile: parseTypeScriptSource(`${packageRoot}/src/${file}`, source),
        upstreamDirectory: '/flight',
      });
      const identity = (name: string) => ({
        name: name[0]!.toUpperCase() + name.slice(1),
        packageName,
        source: `packages/public-linking/src/${name}.ts`,
      });
      const declarations = identity('declarations');
      const provider = identity('provider');
      const barrel = identity('barrel');
      const origin = identity('origin');
      const middle = identity('middle');
      const facade = identity('facade');
      const consumer = identity('consumer');
      let rustcInvocations = 0;
      const result = compileTypeScriptPackageGraph({
        backend: createRustCompilerBackend(),
        backendOptions: {},
        graph: {
          entries: [declarations, barrel, facade, consumer],
          moduleDependencies: [
            { importer: barrel, specifier: './provider.js', target: provider },
            { importer: middle, specifier: './origin.js', target: origin },
            { importer: facade, specifier: './middle.js', target: middle },
            { importer: consumer, specifier: './declarations.js', target: declarations },
            { importer: consumer, specifier: './barrel.js', target: barrel },
            { importer: consumer, specifier: './facade.js', target: facade },
          ],
          packages: [{ dependencies: [], name: packageName, root: packageRoot }],
          schema: 'flight-compiler-package-graph/1',
        },
        sources: [
          module(
            'declarations.ts',
            'function hiddenLocal(): number { return 1; }\nexport { hiddenLocal as publishedLocal };',
          ),
          module('provider.ts', 'export class F0 { value: number = 2; }'),
          module('barrel.ts', "import { F0 } from './provider.js';\nexport const f0 = 2;\nexport { F0 as PublicF0 };"),
          module('origin.ts', 'export const root = 3;'),
          module('middle.ts', "export { root as bridge } from './origin.js';"),
          module('facade.ts', "export { bridge as publicValue } from './middle.js';"),
          module(
            'consumer.ts',
            `import { publishedLocal } from './declarations.js';
             import type { PublicF0 } from './barrel.js';
             import { publicValue } from './facade.js';
             export function linked(_value: PublicF0): number { return publishedLocal() + publicValue; }`,
          ),
        ],
        targetCompilationSmoke: {
          compileEmittedSources(files) {
            rustcInvocations += 1;
            compileFinalizedRustSourceTree(files);
            return [];
          },
          name: 'rustc-public-linking-checkpoint',
          supportsEmittedSource: ({ path: filePath }) => filePath.endsWith('.rs'),
        },
      });
      const files = new Map(result.compilation.files.map((file) => [file.path, file.contents]));
      const publicBindings = result.report.publicBindings as CompilerRustPublicBindingPlan;
      const availableLocators = publicBindings.bindings.flatMap(({ binding }) =>
        binding.availability === 'available' && binding.locator.carrier !== 'module' ? [binding.locator] : [],
      );
      const missingOrPrivate = availableLocators.flatMap((locator) => {
        const filePath = `${locator.module.modulePath.join('/')}.rs`;
        const contents = files.get(filePath);
        const spelling = locator.spelling.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
        const declaration = new RegExp(`(?:^|\\n)pub (?:const|enum|fn|static|struct|trait|type) ${spelling}\\b`, 'u');
        const reexport = new RegExp(`(?:^|\\n)pub use [^;]+(?:\\bas ${spelling}|::${spelling});`, 'u');
        return contents !== undefined && (declaration.test(contents) || reexport.test(contents))
          ? []
          : [`${filePath}::${locator.spelling}`];
      });

      expect(rustcInvocations).toBe(1);
      expect(files.get('declarations.rs')).toContain('pub fn hidden_local()');
      expect(files.get('barrel.rs')).toContain('pub use crate::provider::F0 as F0_2;');
      expect(files.get('middle.rs')).toContain('pub use crate::origin::ROOT as bridge;');
      expect(files.get('facade.rs')).toContain('pub use crate::middle::bridge as public_value;');
      expect(files.get('consumer.rs')).toContain('use crate::facade::public_value;');
      expect(availableLocators).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            carrier: 'function',
            module: expect.objectContaining({ modulePath: ['declarations'] }),
            spelling: 'hidden_local',
          }),
          expect.objectContaining({
            carrier: 'class',
            module: expect.objectContaining({ modulePath: ['barrel'] }),
            spelling: 'F0_2',
          }),
          expect.objectContaining({
            carrier: 'value',
            module: expect.objectContaining({ modulePath: ['facade'] }),
            spelling: 'public_value',
          }),
        ]),
      );
      expect(missingOrPrivate).toEqual([]);
    },
  );

  it('compiles the neighboring declarations and closed Tray exclusions through a C++ session', () => {
    const sourceFile = parseTypeScriptSource(
      '/flight/packages/types/src/Tray.ts',
      `export interface Signal<T> { readonly emit: T; }
       export interface TrayEventProvider<Event extends object> {
         getSignal(): Signal<(event: Readonly<Event>) => void> | null;
       }
       export interface Entity { readonly id: string; }
       export interface TrayIcon extends Entity { destroy(): void; }
       export type TrayCreateProviderResult =
         | { outcome: 'created' }
         | { outcome: 'cancelled' }
         | { error?: unknown; outcome: 'runtime-api-unavailable' }
         | { error?: unknown; outcome: 'invalid-icon' }
         | { error?: unknown; outcome: 'tray-create-failed' };
       export type TrayCreateResult<Tray extends TrayIcon = TrayIcon> =
         | (Entity & { outcome: 'created'; tray: Tray })
         | (Entity & Exclude<TrayCreateProviderResult, { outcome: 'created' }>);
       export type TrayImageUpdateResult =
         | { outcome: 'updated' }
         | { outcome: 'tray-destroyed' }
         | { error?: unknown; outcome: 'invalid-icon' }
         | { error?: unknown; outcome: 'image-update-failed' };
       export type TrayAnimationStartResult =
         | { outcome: 'started'; release: () => void }
         | { outcome: 'empty' }
         | Exclude<TrayImageUpdateResult, { outcome: 'updated' }>;`,
    );
    const result = compileTypeScriptModules({
      backend: createCppCompilerBackend(),
      backendOptions: { runtimeProfile: 'flight-cpp' },
      sources: [{ packageName: '@flighthq/types', sourceFile, upstreamDirectory: '/flight' }],
    });
    const [header] = result.compilation.files;

    expect(result.diagnostics).toEqual([]);
    expect(result.compilation.files).toHaveLength(1);
    expect(header?.path).toBe('tray.hpp');
    expect(header?.contents).toContain('TrayAnimationStartResult');
    expect(header?.contents).toContain('TrayCreateResult');
    expect(header?.contents).toContain('TrayEventProvider');
    expect(header?.contents).not.toContain('Exclude<');
  });

  it('resolves CubeTexture Extract across the imported union module boundary', () => {
    const moduleResolution = {
      edges: [
        {
          specifier: './Texture',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/Texture.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1' as const,
    };
    const result = compileTypeScriptModules({
      backend: createCppCompilerBackend(),
      backendOptions: { runtimeProfile: 'flight-cpp' },
      moduleResolution,
      sources: [
        {
          packageName: '@flighthq/types',
          sourceFile: parseTypeScriptSource(
            '/flight/packages/types/src/Texture.ts',
            `interface Entity { readonly entity: symbol }
             interface TextureUvTransform { readonly uv: number }
             interface Sampler { readonly sampler: number }
             interface TextureSource extends Entity { readonly source: number }
             interface VoxelGrid extends Entity { readonly voxel: number }
             type TextureColorSpace = 'linear' | 'srgb';
             type TextureSourceCubeFaces = readonly [
               TextureSource | null, TextureSource | null, TextureSource | null,
               TextureSource | null, TextureSource | null, TextureSource | null,
             ];
             interface TextureCommon extends Entity, TextureUvTransform {
               colorSpace: TextureColorSpace;
               sampler: Sampler;
               version: number;
             }
             export interface Texture2D extends TextureCommon {
               readonly dimension: '2d';
               source: TextureSource | null;
             }
             export type Texture =
               | Texture2D
               | (TextureCommon & {
                   readonly dimension: '2d-array';
                   sources: readonly (TextureSource | null)[];
                 })
               | (TextureCommon & {
                   readonly dimension: '3d';
                   source: VoxelGrid | null;
                 })
               | (TextureCommon & {
                   readonly dimension: 'cube';
                   sources: TextureSourceCubeFaces;
                 });`,
          ),
          upstreamDirectory: '/flight',
        },
        {
          packageName: '@flighthq/types',
          sourceFile: parseTypeScriptSource(
            '/flight/packages/types/src/CubeTexture.ts',
            `import type { Texture } from './Texture';
             export type CubeTexture = Extract<Texture, { dimension: 'cube' }>;`,
          ),
          upstreamDirectory: '/flight',
        },
      ],
    });
    const cubeTexture = result.compilation.files.find((file) => file.path === 'cube_texture.hpp');

    expect(result.diagnostics).toEqual([]);
    expect(cubeTexture?.contents).toMatch(/using CubeTexture = flight::Ref<[^;]+>;/u);
    expect(cubeTexture?.contents).not.toContain('using CubeTexture = void;');
    expect(cubeTexture?.contents).not.toContain('Extract');
  });
});

function isDeeplyFrozen(value: unknown, seen: WeakSet<object>): boolean {
  if (!value || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((child) => isDeeplyFrozen(child, seen));
}

describe('@flighthq/tool-compiler best-effort Rust imported targets', () => {
  type RustBestEffortOutcome =
    | Readonly<{
        error: Readonly<{
          backend?: string;
          code?: string;
          kind?: string;
          message?: string;
          subjects?: readonly string[];
        }>;
      }>
    | Readonly<{ result: ReturnType<typeof compileTypeScriptPackageGraph> }>;
  function rustBestEffortRun(
    sources: readonly (typeof provider)[],
    emitPathPrefixes?: readonly string[],
  ): RustBestEffortOutcome {
    try {
      const result = compileTypeScriptPackageGraph({
        backend: createRustCompilerBackend(),
        backendOptions: {},
        bestEffort: true,
        ...(emitPathPrefixes === undefined ? {} : { emitPathPrefixes }),
        graph: {
          entries: [{ name: 'Consumer', packageName: '@scope/math', source: 'packages/math/src/consumer.ts' }],
          moduleDependencies: [
            {
              importer: { name: 'Consumer', packageName: '@scope/math', source: 'packages/math/src/consumer.ts' },
              specifier: './provider.js',
              target: { name: 'Provider', packageName: '@scope/math', source: 'packages/math/src/provider.ts' },
            },
          ],
          packages: [{ dependencies: [], name: '@scope/math', root: '/flight/packages/math' }],
          schema: 'flight-compiler-package-graph/1',
        },
        sources,
      });
      return { result };
    } catch (error) {
      return {
        error: error as Readonly<{
          backend?: string;
          code?: string;
          kind?: string;
          message?: string;
          subjects?: readonly string[];
        }>,
      };
    }
  }

  const provider = {
    packageName: '@scope/math',
    packageRoot: '/flight/packages/math',
    sourceFile: parseTypeScriptSource(
      '/flight/packages/math/src/provider.ts',
      'export function convert(value: unknown): { value: number } { return value as { value: number }; }',
    ),
    upstreamDirectory: '/flight',
  };
  const consumer = {
    packageName: '@scope/math',
    packageRoot: '/flight/packages/math',
    sourceFile: parseTypeScriptSource(
      '/flight/packages/math/src/consumer.ts',
      "import { convert } from './provider.js';\nexport { convert };",
    ),
    upstreamDirectory: '/flight',
  };

  it('leaves a refusal placeholder for an imported refused module instead of aborting', () => {
    const first = rustBestEffortRun([consumer, provider]);
    const second = rustBestEffortRun([provider, consumer]);

    expect('error' in first ? first.error : undefined).toBeUndefined();
    const files = 'result' in first ? first.result.compilation.files : [];
    expect(files.map((file) => file.path)).toEqual(['consumer.rs', 'lib.rs', 'provider.rs']);
    const placeholder = files.find((file) => file.path === 'provider.rs');
    expect(placeholder?.contents).toContain('BEST-EFFORT PLACEHOLDER');
    expect(placeholder?.contents).toContain('refusal: rust-cast-requires-type-directed-lowering');
    expect(placeholder?.contents).toContain('cast to object requires Rust type-directed');
    expect(placeholder?.contents).toContain('//   function convert(');
    expect(placeholder?.contents).not.toMatch(/^\s*(?:pub\s+)?(?:fn|struct|enum|type|const)\b/mu);
    const skeleton = files.find((file) => file.path === 'lib.rs');
    expect(skeleton?.contents).toContain('mod consumer;');
    expect(skeleton?.contents).toContain('mod provider;');
    expect('result' in second ? second.result.compilation.files : []).toEqual(files);
  });

  it('attributes an import of a module outside the requested emit paths to selection', () => {
    const outcome = rustBestEffortRun([consumer, provider], ['packages/math/src/consumer.ts']);
    const failure = 'error' in outcome ? outcome.error : undefined;

    expect(failure?.kind).toBe('compiler-backend-finalization');
    expect(failure?.backend).toBe('rust');
    expect(failure?.code).toBe('rust-source-tree-import-target-unselected');
    expect(failure?.message).toContain('which is not selected for this output');
  });

  it('attributes an ungrounded explicit reexport to the refused target module', () => {
    const consumerIdentity = { name: 'Consumer', packageName: '@scope/math', source: 'packages/math/src/consumer.ts' };
    const facadeIdentity = { name: 'Facade', packageName: '@scope/math', source: 'packages/math/src/facade.ts' };
    const leafIdentity = { name: 'Leaf', packageName: '@scope/math', source: 'packages/math/src/leaf.ts' };
    const sources = [
      {
        packageName: '@scope/math',
        packageRoot: '/flight/packages/math',
        sourceFile: parseTypeScriptSource(
          '/flight/packages/math/src/consumer.ts',
          "import { ok } from './facade.js';\nexport function read(): number { return ok; }",
        ),
        upstreamDirectory: '/flight',
      },
      {
        packageName: '@scope/math',
        packageRoot: '/flight/packages/math',
        sourceFile: parseTypeScriptSource(
          '/flight/packages/math/src/facade.ts',
          "export const ok = 1;\nexport { missing } from './leaf.js';",
        ),
        upstreamDirectory: '/flight',
      },
      {
        packageName: '@scope/math',
        packageRoot: '/flight/packages/math',
        sourceFile: parseTypeScriptSource('/flight/packages/math/src/leaf.ts', 'export const other = 2;'),
        upstreamDirectory: '/flight',
      },
    ];
    const run = (orderedSources: typeof sources) => {
      try {
        return {
          result: compileTypeScriptPackageGraph({
            backend: createRustCompilerBackend(),
            backendOptions: {},
            bestEffort: true,
            graph: {
              entries: [consumerIdentity],
              moduleDependencies: [
                { importer: consumerIdentity, specifier: './facade.js', target: facadeIdentity },
                { importer: facadeIdentity, specifier: './leaf.js', target: leafIdentity },
              ],
              packages: [{ dependencies: [], name: '@scope/math', root: '/flight/packages/math' }],
              schema: 'flight-compiler-package-graph/1',
            },
            sources: orderedSources,
          }),
        };
      } catch (error) {
        return { error: error as Readonly<{ code?: string; kind?: string; message?: string }> };
      }
    };
    const first = run(sources);
    const second = run([...sources].reverse());

    expect('error' in first ? first.error : undefined).toBeUndefined();
    const files = 'result' in first ? first.result.compilation.files : [];
    const placeholder = files.find((file) => file.contents.includes('BEST-EFFORT PLACEHOLDER'));
    expect(placeholder?.path).toBe('facade.rs');
    expect(placeholder?.contents).toContain('refusal: rust-export-name-ungrounded');
    expect(placeholder?.contents).toContain('has no grounded declaration');
    expect('result' in second ? second.result.compilation.files : []).toEqual(files);
  });
});

describe('@flighthq/tool-compiler package subpath imports', () => {
  const compile = (
    consumerSource: string,
    betaSource: string,
    betaFile: string,
    specifier: string,
    betaSourcePath: string,
  ) => {
    const sources = [
      {
        packageName: '@alpha/app',
        upstreamDirectory: '/flight',
        sourceFile: parseTypeScriptSource('/flight/packages/app/src/consumer.ts', consumerSource),
      },
      {
        packageName: '@beta/lib',
        upstreamDirectory: '/flight',
        sourceFile: parseTypeScriptSource(betaSourcePath, betaSource),
      },
    ];
    return compileTypeScriptModules({
      backend: createRustCompilerBackend(),
      backendOptions: {},
      moduleResolution: {
        edges: [{ specifier, target: { packageName: '@beta/lib', source: betaFile } }],
        schema: 'flight-compiler-module-resolution/1',
      },
      sources,
    });
  };

  it('spells a subpath lane with its module path for a value and a type, deterministically', () => {
    const source = (): string =>
      "import { helper } from '@beta/lib/sub.js';\nimport type { Value } from '@beta/lib/sub.js';\nexport { helper };\nexport type Alias = Value;";
    const beta = 'export interface Value { size: number }\nexport function helper(): number { return 1; }';
    const first = compile(
      source(),
      beta,
      'packages/lib/src/sub.ts',
      '@beta/lib/sub.js',
      '/flight/packages/lib/src/sub.ts',
    );
    const second = compile(
      source(),
      beta,
      'packages/lib/src/sub.ts',
      '@beta/lib/sub.js',
      '/flight/packages/lib/src/sub.ts',
    );
    const consumerFile = first.compilation.files.find(({ path }) => path === 'alpha-app/src/consumer.rs');

    expect(consumerFile?.contents).toContain('use beta_lib::sub::helper;');
    expect(consumerFile?.contents).toContain('use beta_lib::sub::Value;');
    expect(second.compilation.files).toEqual(first.compilation.files);
  });

  it('keeps a root-lane package import at the crate root', () => {
    const result = compile(
      "import { helper } from '@beta/lib';\nexport { helper };",
      'export function helper(): number { return 1; }',
      'packages/lib/src/index.ts',
      '@beta/lib',
      '/flight/packages/lib/src/index.ts',
    );
    const consumerFile = result.compilation.files.find(({ path }) => path === 'alpha-app/src/consumer.rs');

    expect(consumerFile?.contents).toContain('use beta_lib::helper;');
  });
});

describe('@flighthq/tool-compiler Rust allocator agreement', () => {
  type PlanBinding = Readonly<{
    binding: Readonly<{ availability: string; locator?: Readonly<{ spelling: string }> | undefined }>;
    identity: Readonly<{ exportRoute: string }>;
  }>;

  function locatorSpelling(
    result: Readonly<{ report: Readonly<{ publicBindings?: unknown }> }>,
    exportName: string,
  ): string | undefined {
    return locatorSpellings(result, exportName)[0];
  }

  function locatorSpellings(
    result: Readonly<{ report: Readonly<{ publicBindings?: unknown }> }>,
    exportName: string,
  ): readonly string[] {
    const bindings = (result.report.publicBindings as Readonly<{ bindings: readonly PlanBinding[] }> | undefined)
      ?.bindings;
    return (bindings ?? [])
      .filter(
        (binding) =>
          binding.binding.availability === 'available' &&
          binding.identity.exportRoute.includes(`${JSON.stringify(exportName)}`),
      )
      .flatMap((binding) => (binding.binding.locator ? [binding.binding.locator.spelling] : []))
      .sort();
  }

  const provider = (source: string) => ({
    packageName: '@probe/pkg',
    packageRoot: '/flight/packages/pkg',
    upstreamDirectory: '/flight',
    sourceFile: parseTypeScriptSource('/flight/packages/pkg/src/provider.ts', source),
  });
  const consumer = (source: string) => ({
    packageName: '@probe/pkg',
    packageRoot: '/flight/packages/pkg',
    upstreamDirectory: '/flight',
    sourceFile: parseTypeScriptSource('/flight/packages/pkg/src/consumer.ts', source),
  });
  const consumerIdentity = { name: 'Consumer', packageName: '@probe/pkg', source: 'packages/pkg/src/consumer.ts' };
  const providerIdentity = { name: 'Provider', packageName: '@probe/pkg', source: 'packages/pkg/src/provider.ts' };
  const compile = (sources: readonly ReturnType<typeof consumer>[]) =>
    compileTypeScriptPackageGraph({
      backend: createRustCompilerBackend(),
      backendOptions: {},
      graph: {
        entries: [consumerIdentity],
        moduleDependencies: [{ importer: consumerIdentity, specifier: './provider.js', target: providerIdentity }],
        packages: [{ dependencies: [], name: '@probe/pkg', root: '/flight/packages/pkg' }],
        schema: 'flight-compiler-package-graph/1',
      },
      sources,
    });

  it('reports the emitted spelling for a directly exported colliding function', () => {
    const result = compile([
      consumer("import { Widget } from './provider.js';\nexport function widget(): Widget { return new Widget(); }"),
      provider('export class Widget { value: number = 1; }'),
    ]);
    const consumerFile = result.compilation.files.find(({ path }) => path === 'consumer.rs');

    expect(consumerFile?.contents).toContain('pub fn widget()');
    expect(locatorSpelling(result, 'widget')).toBe('widget');
  });

  it('allocates an indirect export and its imports exactly as the emitter does', () => {
    const result = compile([
      consumer(
        "import { F0, Widget } from './provider.js';\nfunction widget(): Widget { return new Widget(); }\nexport { widget };\nexport const f0: F0 = new F0();",
      ),
      provider('export class F0 { v: number = 0; }\nexport class Widget { value: number = 1; }'),
    ]);
    const consumerFile = result.compilation.files.find(({ path }) => path === 'consumer.rs');

    // Emitter output is unchanged by the shared rules: the uppercase import keeps its type-shaped name
    // (the constant forces the `F0_2` alias), and the indirect function keeps its base name.
    expect(consumerFile?.contents).toContain('use crate::provider::{F0 as F0_2, Widget};');
    expect(consumerFile?.contents).toContain('pub fn widget()');
    expect(consumerFile?.contents).toContain('pub const F0: F0_2');
    expect(locatorSpelling(result, 'widget')).toBe('widget');
    expect(locatorSpelling(result, 'f0')).toBe('F0');
  });

  it('publishes an imported local allocation that a downstream consumer can name', () => {
    const barrelIdentity = { name: 'Barrel', packageName: '@probe/pkg', source: 'packages/pkg/src/barrel.ts' };
    const sources = [
      {
        packageName: '@probe/pkg',
        packageRoot: '/flight/packages/pkg',
        upstreamDirectory: '/flight',
        sourceFile: parseTypeScriptSource(
          '/flight/packages/pkg/src/barrel.ts',
          "import { F0 } from './provider.js';\nexport const f0: F0 = new F0();\nexport { F0 as PublicF0 };",
        ),
      },
      consumer(
        "import { PublicF0 as Seen } from './barrel.js';\nexport function read(value: Seen): number { return value.v; }",
      ),
      provider('export class F0 { v: number = 0; }'),
    ];
    const result = compileTypeScriptPackageGraph({
      backend: createRustCompilerBackend(),
      backendOptions: {},
      graph: {
        entries: [barrelIdentity, consumerIdentity],
        moduleDependencies: [
          { importer: barrelIdentity, specifier: './provider.js', target: providerIdentity },
          { importer: consumerIdentity, specifier: './barrel.js', target: barrelIdentity },
        ],
        packages: [{ dependencies: [], name: '@probe/pkg', root: '/flight/packages/pkg' }],
        schema: 'flight-compiler-package-graph/1',
      },
      sources,
    });
    const barrelFile = result.compilation.files.find(({ path }) => path === 'barrel.rs');
    const consumerFile = result.compilation.files.find(({ path }) => path === 'consumer.rs');

    expect(barrelFile?.contents).toContain('pub use crate::provider::F0 as F0_2;');
    expect(barrelFile?.contents).not.toContain('\nuse crate::provider::F0 as F0_2;');
    expect(consumerFile?.contents).toContain('use crate::barrel::F0_2 as Seen;');
    expect(locatorSpellings(result, 'PublicF0')).toEqual(['F0_2', 'F0_2']);
  });

  it('answers the same plan and files when the sources are ordered differently', () => {
    const sources = [
      consumer(
        "import { F0, Widget } from './provider.js';\nfunction widget(): Widget { return new Widget(); }\nexport { widget };\nexport const f0: F0 = new F0();",
      ),
      provider('export class F0 { v: number = 0; }\nexport class Widget { value: number = 1; }'),
    ];
    const first = compile(sources);
    const second = compile([...sources].reverse());

    expect(second.report.publicBindings).toEqual(first.report.publicBindings);
    expect(second.compilation.files).toEqual(first.compilation.files);
  });
});
