import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import { emitIrModuleCpp } from './cppCompilerBackend.js';

function emit(source: string): string {
  const sourceFile = ts.createSourceFile('/flight/packages/x/src/x.ts', source, ts.ScriptTarget.Latest, true);
  const result = lowerTypeScriptSource(sourceFile, { packageName: '@flighthq/x', upstreamDirectory: '/flight' });
  expect(result.diagnostics).toEqual([]);
  return emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' }).contents;
}

function returned(contents: string, functionName = 'test'): string {
  const functionStart = contents.indexOf(` ${functionName}(`);
  expect(functionStart).toBeGreaterThanOrEqual(0);
  const line = contents
    .slice(functionStart)
    .split('\n')
    .find((candidate) => candidate.trim().startsWith('return '));
  expect(line).toBeDefined();
  return line!.trim();
}

const declarations = `
  export interface Device { readonly id: number }
  export interface Group { readonly device?: Device; readonly nullable: Device | null; readonly count: number }
  export interface Host { readonly audio: Group }
`;

describe('emitIrModuleCpp declared-present reference chain', () => {
  it('guards a declared-present reference while retaining its optional member carrier', () => {
    const contents = emit(
      `${declarations}
       export function test(host: Host): Device | null { return host.audio?.device ?? null; }`,
    );

    expect(returned(contents)).toBe(
      'return ([&]() -> std::optional<flight::Ref<Device>> { auto optional_chain_receiver = host->audio; if (!optional_chain_receiver) return std::nullopt; return optional_chain_receiver->device; }());',
    );
  });

  it('keeps a readonly owner projection on its structural absence lane', () => {
    const readonlyOwner = emit(
      `${declarations}
       export function test(host: Readonly<Host>): Device | null { return host.audio?.device ?? null; }`,
    );

    expect(returned(readonlyOwner)).toBe(
      'return ([&]() -> std::optional<flight::Ref<Device>> { auto optional_chain_receiver = flight::row_get<flight::RowKey<"audio">>(host); if (!optional_chain_receiver.has_value()) return std::nullopt; return optional_chain_receiver.value()->device; }());',
    );
  });

  it('evaluates a computed reference receiver once', () => {
    const contents = emit(
      `${declarations}
       export function select(host: Host): Group { return host.audio; }
       export function test(host: Host): Device | null { return select(host)?.device ?? null; }`,
    );
    const result = returned(contents);

    expect(result).toContain('auto optional_chain_receiver = select(host);');
    expect(result.match(/select\(host\)/gu)).toHaveLength(1);
    expect(result).toContain('return optional_chain_receiver->device;');
  });

  it('does not guard a direct read or widen a required member', () => {
    const direct = emit(
      `${declarations}
       export function test(host: Host): Device | null { return host.audio.device ?? null; }`,
    );
    const required = emit(
      `${declarations}
       export function test(host: Host): number { return host.audio?.count; }`,
    );

    expect(returned(direct)).toBe('return host->audio->device;');
    expect(returned(required)).toBe('return host->audio->count;');
  });

  it('does not reuse a null-only member carrier for receiver undefined', () => {
    const contents = emit(
      `${declarations}
       export function test(host: Host): Device | null { return host.audio?.nullable; }`,
    );

    expect(returned(contents)).toBe('return host->audio->nullable;');
    expect(returned(contents)).not.toContain('optional_chain_receiver');
  });

  it('keeps value and structural-row receivers on their existing lanes', () => {
    const value = emit('export function test(text: string): number { return text?.length; }');
    const structural = emit(
      `${declarations}
       export function test(group: Readonly<{ readonly device?: Device }>): Device | null {
         return group?.device ?? null;
       }`,
    );

    expect(returned(value)).not.toContain('optional_chain_receiver');
    expect(returned(structural)).toContain('if (!optional_chain_receiver.has_value()) return std::nullopt;');
    expect(returned(structural)).toContain(
      'flight::row_get<flight::RowKey<"device">>(optional_chain_receiver.value())',
    );
    expect(returned(structural)).not.toContain('if (!optional_chain_receiver) return std::nullopt;');
  });
});
