import {
  compileTypeScriptModules,
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
