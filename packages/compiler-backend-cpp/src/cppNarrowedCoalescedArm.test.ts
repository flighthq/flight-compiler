import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import { emitIrModuleCpp } from './cppCompilerBackend.js';

function emit(source: string): string {
  const sourceFile = ts.createSourceFile('/flight/packages/x/src/x.ts', source, ts.ScriptTarget.Latest, true);
  const result = lowerTypeScriptSource(sourceFile, { packageName: '@flighthq/x', upstreamDirectory: '/flight' });
  return emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' }).contents;
}

// `@flighthq/types` TrayDestroyCapabilityResult and TrayDestroyResult. `{ outcome: 'destroyed' }` is
// stored as the shared `{ outcome }` shape struct in both aliases; spelled alone, it names a different struct.
const results = `export interface F { readonly error?: unknown; readonly step: 'native-resource' }
export type DC = { readonly outcome: 'destroyed' } | { readonly failures: readonly F[]; readonly outcome: 'tray-destroy-failed' };
export type DR = DC | { readonly outcome: 'already-destroyed' };
`;

describe('a binding narrowed to one arm enters a wider union as its stored slot', () => {
  it('returns the narrowed destroyTrayRuntime result as the very slot it is stored in', () => {
    const emitted = emit(
      `${results}export function n(result: DC): DR { if (result.outcome === 'destroyed') { return result; } return result; }`,
    );

    expect(emitted).toContain('if (result.index() == 1) {');
    expect(emitted).toMatch(/\{std::in_place_type<flight::Ref<outcome_[0-9a-f]+>>, std::get<1>\(result\)\};/u);
  });

  it('refuses a value whose declared type is the single-arm struct itself', () => {
    expect(() => emit(`${results}export function s(d: { readonly outcome: 'destroyed' }): DR { return d; }`)).toThrow(
      /is not a represented runtime domain/u,
    );
  });

  it('refuses a narrowed property read, which is not a narrowed binding', () => {
    expect(() =>
      emit(
        `${results}export interface H { r: DC } export function p(h: H): DR { if (h.r.outcome === 'destroyed') { return h.r; } return h.r; }`,
      ),
    ).toThrow(/is not a represented runtime domain/u);
  });

  it('refuses a narrowed binding whose storage also admits absence', () => {
    expect(() =>
      emit(
        `${results}export function o(result: DC | null): DR | null { if (result !== null && result.outcome === 'destroyed') { return result; } return null; }`,
      ),
    ).toThrow(/is not a represented runtime domain/u);
  });
});
