import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { isBackendEmissionFailure } from '../../compiler-emission/src/index.js';
import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import { emitIrModuleCpp } from './cppCompilerBackend.js';

const hostLibrary = `
  declare const console: {
    debug(...data: unknown[]): void; log(...data: unknown[]): void; warn(...data: unknown[]): void;
  };
  declare const performance: { now(): number };
`;

const hostBindings = {
  bindings: [
    {
      headers: ['host/console.hpp'],
      members: ['debug', 'log', 'warn'].map((member) => ({
        sourceMember: member,
        targetName: `host::console_${member}`,
      })),
      nullability: 'non-null' as const,
      ownership: 'borrowed' as const,
      sourceName: 'console',
      space: 'value' as const,
      targetName: 'host::console',
    },
    {
      headers: ['host/performance.hpp'],
      members: [{ sourceMember: 'now', targetName: 'host::performance_now' }],
      nullability: 'non-null' as const,
      ownership: 'borrowed' as const,
      sourceName: 'performance',
      space: 'value' as const,
      targetName: 'host::performance',
    },
  ],
  schema: 'flight-cpp-external-bindings/1' as const,
};

function emit(source: string): string {
  const sourceFile = ts.createSourceFile(
    '/flight/packages/log/src/Host.ts',
    hostLibrary + source,
    ts.ScriptTarget.Latest,
    true,
  );
  const result = lowerTypeScriptSource(sourceFile, { packageName: '@flighthq/log', upstreamDirectory: '/flight' });
  expect(result.diagnostics).toEqual([]);
  return emitIrModuleCpp(result.module, {
    externalBindings: hostBindings,
    runtimeProfile: 'flight-cpp',
  }).contents;
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

describe('dynamic index on a bound host object', () => {
  it('refuses an any-cast open-key call instead of indexing the host carrier', () => {
    const failure = refusal(
      `export function write(name: string, line: string): void { (console as any)[name](line); }`,
    );

    expect(failure.rule).toBe('cpp-host-object-dynamic-index');
    expect(failure.message).toContain('bound host object console');
  });

  it('refuses a Record cast rather than emitting a keyed lookup on the host carrier', () => {
    const failure = refusal(
      `export function write(name: string, line: string): void {
         (console as unknown as Record<string, (message: string) => void>)[name]!(line);
       }`,
    );

    expect(failure.rule).toBe('cpp-host-object-dynamic-index');
  });

  it('refuses an any-cast open-key read on another bound host object', () => {
    const failure = refusal(`export function read(name: string): unknown { return (performance as any)[name]; }`);

    expect(failure.rule).toBe('cpp-host-object-dynamic-index');
    expect(failure.message).toContain('bound host object performance');
  });

  it('keeps an unsupported keyof host call on its existing refusal boundary', () => {
    expect(() =>
      emit(`export function write(name: keyof typeof console, line: string): void { console[name](line); }`),
    ).toThrow();
  });

  it('keeps a finite bound-member key on the closed dispatch lane', () => {
    const contents = emit(`export function write(kind: 'log' | 'warn', line: string): void { console[kind](line); }`);

    expect(contents).toContain('host::console_log(member_argument');
    expect(contents).toContain('host::console_warn(member_argument');
    expect(contents).not.toContain('static_cast<size_t>');
  });

  it('keeps named host members on their declared targets', () => {
    const contents = emit(`export function write(line: string): void { console.log(line); }`);

    expect(contents).toContain('host::console_log(line)');
  });

  it('leaves unrelated array and Record indexing on their existing lanes', () => {
    const contents = emit(
      `export function at(values: number[], index: number): number { return values[index]!; }
       export function lookup(values: Readonly<Record<string, number>>, key: string): number | undefined {
         return values[key];
       }`,
    );

    expect(contents).toContain('return values.element(index);');
    expect(contents).toContain('values.get(key)');
  });
});
