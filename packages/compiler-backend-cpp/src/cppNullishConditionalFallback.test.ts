import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { isBackendEmissionFailure } from '../../compiler-emission/src/index.js';
import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import { emitIrModuleCpp } from './cppCompilerBackend.js';

function emit(source: string): string {
  const sourceFile = ts.createSourceFile('/flight/packages/x/src/x.ts', source, ts.ScriptTarget.Latest, true);
  const result = lowerTypeScriptSource(sourceFile, { packageName: '@flighthq/x', upstreamDirectory: '/flight' });
  expect(result.diagnostics).toEqual([]);
  return emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' }).contents;
}

function declaration(contents: string, name: string): string {
  return (
    contents
      .split('\n')
      .find((line) => new RegExp(`\\b${name} = `, 'u').test(line))
      ?.trim() ?? ''
  );
}

function refusal(source: string) {
  try {
    emit(source);
  } catch (error) {
    if (isBackendEmissionFailure(error)) return error;
    throw error;
  }
  throw new Error('Expected C++ emission to refuse the source');
}

const group = 'export interface Group { width: number }\n';
const captured = (sentinel: 'null' | 'undefined') =>
  `${group}export function read(groups: Group[]): number { let active: Group | ${sentinel} = ${sentinel}; ` +
  `function step(): number { const target = active ?? (groups.length > 0 ? groups[groups.length - 1] : ${sentinel}); ` +
  `if (target && target.width > 0) return target.width; return -1; } ` +
  `function reset(): void { active = ${sentinel}; } reset(); return step(); }`;

describe('a nullish coalesce with a conditional absent fallback', () => {
  it.each(['null', 'undefined'] as const)('keeps a literal %s arm absent', (sentinel) => {
    const target = declaration(emit(captured(sentinel)), 'target');

    expect(target).toContain(
      '-> std::optional<flight::Ref<Group>> { auto nullish_coalesce_left = active_capture.read_binding();',
    );
    expect(target).toContain('if (!contextual_union_source.has_value()) return std::nullopt;');
    expect(target).not.toContain('nullptr');
  });

  it('keeps a dual-sentinel fallback refused when the conditional has no value evidence', () => {
    const failure = refusal(
      `${group}export function select(
         current: Group | null,
         choose: boolean,
       ): Group | null | undefined {
         return current ?? (choose ? null : undefined);
       }`,
    );

    expect(failure.rule).toBe('cpp-contextual-union-missing-expression-type:dualSentinelVariant');
  });

  it('evaluates the receiver, condition, and selected value once', () => {
    const target = declaration(
      emit(
        `${group}export function read(
           current: () => Group | null,
           choose: () => boolean,
           fallback: () => Group,
         ): number {
           const target = current() ?? (choose() ? fallback() : null);
           return target ? target.width : -1;
         }`,
      ),
      'target',
    );

    expect(target.match(/current\(\)/gu)).toHaveLength(1);
    expect(target.match(/choose\(\)/gu)).toHaveLength(1);
    expect(target.match(/fallback\(\)/gu)).toHaveLength(1);
  });

  it('retains the declared reference owner through a readonly result', () => {
    const contents = emit(
      `${group}export function select(
         current: Readonly<Group> | null,
         choose: boolean,
         fallback: () => Group,
       ): Readonly<Group> | null {
         return current ?? (choose ? fallback() : null);
       }`,
    );

    expect(contents).toContain(
      'std::optional<flight::StructuralRef<flight::RowReadonly<flight::RowOf<flight::Ref<Group>>>>> select(',
    );
    expect(contents).toContain('flight::RowOf<flight::Ref<Group>>');
    expect(contents).toContain('flight::structural_ref_cast<');
    expect(contents).not.toContain('make_ref<');
    expect(contents).not.toContain('materialize_row');
    expect(contents).not.toContain('anonymous_');
  });

  it('does not invent a wider owner when the retained reference lacks its cells', () => {
    const failure = refusal(
      `interface Base { width: number }
       interface Extended extends Base { height: number }
       export function select(
         current: Base | null,
         choose: boolean,
         fallback: Extended,
       ): Extended | null {
         return (current as Extended | null) ?? (choose ? fallback : null);
       }`,
    );

    expect(failure.rule).toBe('cpp-structural-assertion-owner-unproven');
  });

  it('leaves present and non-conditional fallbacks unchanged', () => {
    expect(
      declaration(
        emit(`${group}export function read(active: Group | null, fallback: Group): number {
          const target = active ?? fallback; return target.width;
        }`),
        'target',
      ),
    ).toBe('auto target = (active.has_value() ? active.value() : fallback);');
    expect(
      declaration(
        emit('export function read(active: number | null): number { const target = active ?? 0; return target; }'),
        'target',
      ),
    ).toBe('const double target = (active.has_value() ? active.value() : 0.0);');
  });
});
