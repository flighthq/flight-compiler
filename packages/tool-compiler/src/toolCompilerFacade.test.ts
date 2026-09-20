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
});
