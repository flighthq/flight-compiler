import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import { emitIrModuleCpp } from './cppCompilerBackend.js';

function emit(source: string): string {
  const sourceFile = ts.createSourceFile('/flight/packages/x/src/x.ts', source, ts.ScriptTarget.Latest, true);
  const result = lowerTypeScriptSource(sourceFile, { packageName: '@flighthq/x', upstreamDirectory: '/flight' });
  return emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' }).contents;
}

function body(source: string, name: string): string {
  const lines = emit(source).split('\n');
  const start = lines.findIndex((line) => line.includes(` ${name}(`) && line.startsWith('inline '));
  const end = lines.findIndex((line, index) => index > start && line === '}');
  return lines.slice(start, end + 1).join('\n');
}

// `@flighthq/types` TrayCreateCapabilityResult. The two discriminant-only arms are one C++ struct, and the
// three `error` arms are another, so the variant has two alternatives for five source members.
const result = `export type R =
  | { readonly outcome: 'created' }
  | { readonly outcome: 'cancelled' }
  | { readonly error?: unknown; readonly outcome: 'runtime-api-unavailable' }
  | { readonly error?: unknown; readonly outcome: 'invalid-icon' }
  | { readonly error?: unknown; readonly outcome: 'tray-create-failed' };
`;

describe('narrowing across members that share one C++ alternative', () => {
  it('lowers the createTrayIcon failure read: excluding created keeps cancelled reachable', () => {
    const emitted = body(
      `${result}export function f(result: R): unknown {
        if (result.outcome !== 'created') { return 'error' in result ? result.error : undefined; }
        return undefined;
      }`,
      'f',
    );
    expect(emitted).toContain(
      'if (!((result.index() == 1 && std::get<1>(result)->outcome == flight::String("created")))) {',
    );
    // The member test is an alternative test over the whole variant, never a projection of one alternative.
    expect(emitted).toContain('return (result.index() == 0 ? std::visit(');
    expect(emitted).not.toContain('std::get<0>(result)');
    expect(emitted).not.toContain(' in ');
  });

  it('passes a narrowing that still covers every alternative as the binding itself', () => {
    const emitted = body(
      `${result}function use(r: R): string { return r.outcome; }
      export function k(r: R): string { if (r.outcome !== 'created') { return use(r); } return 'x'; }`,
      'k',
    );
    expect(emitted).toContain('return use(r);');
  });

  it('reads a member of the complement over every alternative it still contains', () => {
    const emitted = body(
      `${result}export function k(r: R): string { if (r.outcome !== 'created') { return r.outcome; } return 'x'; }`,
      'k',
    );
    expect(emitted).toContain('std::is_same_v<Value, flight::Ref<outcome_');
    expect(emitted).toContain('std::is_same_v<Value, flight::Ref<error_outcome_');
  });

  it('refuses, rather than projecting one alternative, when the excluded member shares its alternative', () => {
    // `a` and `c` are one struct. Before, excluding `a` dropped that whole alternative, so `'x' in v` was
    // emitted as source text over `std::get<1>(v)` -- a value that is `c` would have been read as `b`.
    expect(() =>
      emit(`type D = { kind: 'a'; x: number } | { kind: 'b'; y: string } | { kind: 'c'; x: number };
      export function d(v: D): number { if (v.kind !== 'a') { return 'x' in v ? v.x : 0; } return -1; }`),
    ).toThrow(/requires proven union member access/);
  });

  it('keeps members with different C++ types in different alternatives', () => {
    const emitted = body(
      `type A = { kind: 'a'; x: number } | { kind: 'b'; x: string } | { kind: 'c'; y: number };
      export function a(v: A): unknown { if ('x' in v) { return v.x; } return 0; }`,
      'a',
    );
    expect(emitted).toContain('if (v.index() == 0 || v.index() == 1) {');
    expect(emitted).toContain('std::variant<double, flight::String>');
  });

  it('leaves a narrowing that still admits absence on its own path', () => {
    const emitted = body(
      `${result}export function n(r: R | null): R | null { if (r !== null && r.outcome !== 'created') { return r; } return null; }`,
      'n',
    );
    expect(emitted).not.toContain('std::get<');
  });
  it('projects the arm a member aliases, when the alias is what the variant slot holds', () => {
    // `A` is an alias of `Embedded`, so the slot's own member node is `A` while the discriminant test names
    // `Embedded`. The two render as one C++ alternative but are not the same node, so the complement cannot
    // subtract the tested member by identity. Subtracting nothing would leave that member in the complement,
    // claiming every alternative still reachable and handing the destination the whole variant where its
    // parameter takes one arm.
    const emitted = body(
      `interface Base { name: string | null; state: string }
      export interface Embedded extends Base { kind: 'Embedded'; bytes: number }
      export interface External extends Base { kind: 'External'; uri: string; basePath: string | null }
      type A = Embedded;
      export type Ref = A | External;
      function decode(bytes: number): Promise<string | null> { return Promise.resolve(null); }
      function take(ref: Readonly<External>): Promise<string | null> { return Promise.resolve(null); }
      export async function f(ref: Ref, signal: number): Promise<string | null> {
        const decoded = ref.kind === 'Embedded' ? await decode(ref.bytes) : await take(ref);
        return decoded;
      }`,
      'f',
    );
    expect(emitted).toContain('std::get<0>(ref)');
    expect(emitted).not.toContain('take(ref)');
  });
});
