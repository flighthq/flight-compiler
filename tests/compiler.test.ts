import {
  applySemanticPatches,
  BackendEmissionError,
  compileTypeScriptModules,
  CompilerDiagnosticsError,
  defineSemanticPatches,
  haxeBackend,
  lowerTypeScriptSource,
  parseTypeScriptSource,
  rustBackend,
} from '../src/index.ts';

const sourceText = `
export type Range = { min: number; max: number };

export const EPSILON: number = 0.000001;

export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
`;

describe('compiler orchestration', () => {
  it('lowers one neutral module and emits deterministic Haxe and Rust source', () => {
    const source = parseTypeScriptSource('/flight/packages/math/src/clamp.ts', sourceText);
    const input = {
      packageName: '@flighthq/math',
      sourceFile: source,
      upstreamDirectory: '/flight',
    };

    const haxe = compileTypeScriptModules({ backend: haxeBackend, backendOptions: {}, sources: [input] });
    const rust = compileTypeScriptModules({ backend: rustBackend, backendOptions: {}, sources: [input] });

    expect(haxe.report).toEqual({
      backend: 'haxe',
      emittedFiles: 1,
      modules: 1,
      schema: 'flight-compiler-report/1',
    });
    expect(haxe.compilation.files[0]?.path).toBe('flighthq/math/Clamp.hx');
    expect(haxe.compilation.files[0]?.contents).toContain(
      'public static function clamp(value:Float, min:Float, max:Float):Float',
    );
    expect(haxe.compilation.files[0]?.contents).toContain('typedef Range = { min:Float, max:Float };');
    expect(rust.compilation.files[0]?.path).toBe('clamp.rs');
    expect(rust.compilation.files[0]?.contents).toContain('pub fn clamp(value: f64, min: f64, max: f64) -> f64');
    expect(rust.compilation.files[0]?.contents).toContain('pub struct Range');
    expect(rust.compilation.files[0]?.contents).toContain('pub const EPSILON: f64 = 0.000001;');
    expect(compileTypeScriptModules({ backend: haxeBackend, backendOptions: {}, sources: [input] })).toEqual(haxe);
  });

  it('applies neutral and backend-scoped patches by exact declaration identity', () => {
    const source = parseTypeScriptSource('/flight/packages/math/src/clamp.ts', sourceText);
    const lowered = lowerTypeScriptSource(source, {
      packageName: '@flighthq/math',
      upstreamDirectory: '/flight',
    });
    const clamp = lowered.module.declarations.find((item) => item.name === 'clamp');
    if (!clamp) throw new Error('Expected clamp declaration');
    const base = {
      expect: { fingerprint: clamp.origin.fingerprint, kind: 'function' as const },
      reason: 'Exercise stable compiler patch identity.',
      target: { export: 'clamp', package: '@flighthq/math', source: 'packages/math/src/clamp.ts' },
    };
    const patches = defineSemanticPatches([
      { ...base, id: 'math.clamp.rename', name: 'clampValue', operation: 'rename', scope: { kind: 'neutral' } },
      {
        ...base,
        id: 'math.clamp.rust-rename',
        name: 'rustClamp',
        operation: 'rename',
        scope: { backend: 'rust', kind: 'backend' },
      },
    ] as const);

    const rust = applySemanticPatches([lowered.module], patches, 'rust');
    expect(rust.modules[0]?.declarations.find((item) => item.kind === 'function')?.name).toBe('rustClamp');
    expect(rust.audit.summary).toEqual({ applied: 2, skipped: 0 });
    const haxe = applySemanticPatches([lowered.module], patches, 'haxe');
    expect(haxe.modules[0]?.declarations.find((item) => item.kind === 'function')?.name).toBe('clampValue');
    expect(haxe.audit.summary).toEqual({ applied: 1, skipped: 1 });
    expect(lowered.module.declarations.find((item) => item.kind === 'function')?.name).toBe('clamp');

    const stale = [{ ...patches[0], expect: { ...patches[0].expect, fingerprint: 'sha256:stale' } }];
    expect(() => applySemanticPatches([lowered.module], stale, 'haxe')).toThrow('Stale semantic patch');
  });

  it('refuses unsupported lowering and backend approximations', () => {
    const destructuring = parseTypeScriptSource(
      '/flight/packages/math/src/destructure.ts',
      'export function read({ value }: { value: number }): number { return value; }',
    );
    expect(() =>
      compileTypeScriptModules({
        backend: haxeBackend,
        backendOptions: {},
        sources: [{ packageName: '@flighthq/math', sourceFile: destructuring, upstreamDirectory: '/flight' }],
      }),
    ).toThrow(CompilerDiagnosticsError);

    const asyncSource = parseTypeScriptSource(
      '/flight/packages/math/src/asyncValue.ts',
      'export async function read(): Promise<number> { return 1; }',
    );
    expect(() =>
      compileTypeScriptModules({
        backend: haxeBackend,
        backendOptions: {},
        sources: [{ packageName: '@flighthq/math', sourceFile: asyncSource, upstreamDirectory: '/flight' }],
      }),
    ).toThrow(BackendEmissionError);
  });
});
