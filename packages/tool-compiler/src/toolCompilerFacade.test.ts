import {
  compileTypeScriptModules,
  compileTypeScriptPackageGraph,
  createCppCompilerBackend,
  createHaxeCompilerBackend,
  createRustCompilerBackend,
  parseTypeScriptSource,
} from './index.js';

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
  function rustBestEffortRun(
    sources: readonly (typeof provider)[],
    emitPathPrefixes?: readonly string[],
  ): Readonly<{ code?: string; message?: string }> | undefined {
    try {
      compileTypeScriptPackageGraph({
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
      return undefined;
    } catch (error) {
      return error as Readonly<{ code?: string; message?: string }>;
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

  it('attributes an import of a refused module to that refusal', () => {
    const first = rustBestEffortRun([consumer, provider]);
    const second = rustBestEffortRun([provider, consumer]);

    expect(first?.code).toBe('rust-source-tree-import-target-refused');
    expect(first?.message).toContain('@scope/math/packages/math/src/provider.ts#Provider');
    expect(first?.message).toContain('which was refused: rust-cast-requires-type-directed-lowering:');
    expect(first?.message).toContain('cast to object requires Rust type-directed lowering');
    expect(second?.code).toBe(first?.code);
    expect(second?.message).toBe(first?.message);
  });

  it('attributes an import of a module outside the requested emit paths to selection', () => {
    const failure = rustBestEffortRun([consumer, provider], ['packages/math/src/consumer.ts']);

    expect(failure?.code).toBe('rust-source-tree-import-target-unselected');
    expect(failure?.message).toContain('which is not selected for this output');
  });
});
