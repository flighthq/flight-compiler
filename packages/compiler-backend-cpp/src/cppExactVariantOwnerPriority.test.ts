import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import { emitIrModuleCpp } from './cppCompilerBackend.js';

function emit(source: string): string {
  const sourceFile = ts.createSourceFile(
    '/flight/packages/math/src/variantOwner.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const result = lowerTypeScriptSource(sourceFile, {
    packageName: '@flighthq/math',
    upstreamDirectory: '/flight',
  });
  expect(result.diagnostics).toEqual([]);
  return emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' }).contents;
}

describe('exact C++ variant owner priority', () => {
  it('selects exact owners before equivalent shapes and widens a heterogeneous common property', () => {
    const contents = emit(
      `interface Source { kind: string }
       interface Bitmap extends Source { kind: 'bitmap'; pixels: number }
       interface Target extends Source { kind: 'target'; target: number }
       type SourceValue = Source | Bitmap | Target;
       interface T2 { readonly dimension: '2d'; source: SourceValue | null; common: number }
       interface T3 { readonly dimension: '3d'; source: SourceValue | null; common: number }
       interface TC { readonly dimension: 'cube'; sources: readonly (SourceValue | null)[]; common: number }
       interface RT extends T2 { source: Target }
       type T2Value = Readonly<T2> | Readonly<RT>;
       type Value = Readonly<T2> | Readonly<T3> | Readonly<TC> | Readonly<RT>;
       function source2d(value: T2Value): SourceValue | null { return value.source; }
       export function source(value: Value): SourceValue | null {
         if (value.dimension === '2d') return source2d(value as T2Value);
         if (value.dimension === '3d') return value.source;
         return null;
       }
       export function target(value: Value): number {
         const render = value as Readonly<RT>;
         return render.source.target;
       }`,
    );

    expect(contents).toContain('if (value.index() == 3) {');
    expect(contents).not.toContain('value.index() == 1 || value.index() == 3');
    expect(contents).toContain('std::in_place_type<flight::Ref<Target>>, value->source');
    expect(contents).toContain('inline double target(Value value)');
  });

  it('widens a present nominal variant into a nullable readonly-view variant', () => {
    const contents = emit(
      `interface First { readonly kind: 'first'; first: number }
       interface Second { readonly kind: 'second'; second: number }
       type Value = First | Second;
       type ReadonlyValue = Readonly<First> | Readonly<Second>;
       export function view(value: Value | null): ReadonlyValue | null {
         if (value === null) return null;
         return value;
       }`,
    );

    expect(contents).toContain('std::visit');
    expect(contents).toContain('std::optional<std::variant<flight::StructuralRef<');
  });

  it('widens a present nullable union subset to unique readonly structural views', () => {
    const contents = emit(
      `interface Texture2D { readonly dimension: '2d'; version: number; source: number; runtime: number }
       interface TextureCube { readonly dimension: 'cube'; version: number; sources: readonly number[]; runtime: number }
       interface Texture3D { readonly dimension: '3d'; version: number; depth: number; runtime: number }
       type Texture2DLike = Omit<Texture2D, 'runtime'>;
       type TextureCubeLike = Omit<TextureCube, 'runtime'>;
       type Texture = Texture2D | TextureCube;
       type TextureView = Readonly<Texture2DLike> | Readonly<TextureCubeLike> | Readonly<Texture3D>;
       function read(value: TextureView): number { return value.version; }
       export function readMutable(value: Readonly<Texture> | null): number {
         if (value === null) return 0;
         return read(value);
       }`,
    );

    expect(contents).toContain('std::is_same_v<contextual_union_value_type, flight::Ref<Texture2D>>');
    expect(contents).toContain('flight::StructuralRef<flight::RowReadonly<flight::RowOf<flight::Ref<Texture2DLike>>>>');
    expect(contents).toContain(
      'flight::StructuralRef<flight::RowReadonly<flight::RowOf<flight::Ref<TextureCubeLike>>>>',
    );
    expect(contents).toContain('value.value()');
  });
});
