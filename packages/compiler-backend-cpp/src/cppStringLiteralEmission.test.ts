import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import { emitIrModuleCpp } from './cppCompilerBackend.js';

function emit(source: string): string {
  const sourceFile = ts.createSourceFile('/flight/packages/x/src/literal.ts', source, ts.ScriptTarget.Latest, true);
  const result = lowerTypeScriptSource(sourceFile, { packageName: '@flighthq/x', upstreamDirectory: '/flight' });
  expect(result.diagnostics).toEqual([]);
  return emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' }).contents;
}

function lengthCarrying(literal: string): string {
  return `flight::String(std::string_view(${literal}, sizeof(${literal}) - 1))`;
}

describe('C++ source string literal emission', () => {
  it('carries the exact extent of leading, interior, trailing, and repeated NUL data', () => {
    const contents = emit(String.raw`
      export function leading(): string { return '\u0000ab'; }
      export function interior(): string { return 'a\u0000b'; }
      export function trailing(): string { return 'ab\u0000'; }
      export function repeated(): string { return '\u0000a\u0000\u0000b'; }
    `);

    for (const literal of ['"\\u0000ab"', '"a\\u0000b"', '"ab\\u0000"', '"\\u0000a\\u0000\\u0000b"']) {
      expect(contents).toContain(lengthCarrying(literal));
      expect(contents).not.toContain(`flight::String(${literal})`);
    }
    expect(contents).toContain('#include <string_view>');
  });

  it('uses the extent-aware form for template chunks, object values, and string enums', () => {
    const contents = emit(
      'export function joined(left: string, right: string): string { return `${left}\\u0000${right}`; }\n' +
        "export const value = { key: 'a\\u0000b' } as const;\n" +
        "export enum Kind { Key = 'a\\u0000b' }",
    );

    expect(contents.match(/flight::String\(std::string_view\("\\u0000", sizeof\("\\u0000"\) - 1\)\)/gu)).toHaveLength(
      1,
    );
    expect(contents).toContain(`.key = ${lengthCarrying('"a\\u0000b"')}`);
    expect(contents).toContain(`Kind::Key{${lengthCarrying('"a\\u0000b"')}};`);
  });

  it('keeps ordinary escape spellings byte-for-byte', () => {
    const contents = emit(
      String.raw`export function escaped(): string { return 'quote:" slash:\\ newline:\n tab:\t'; }`,
    );

    expect(contents).toContain('return flight::String("quote:\\" slash:\\\\ newline:\\n tab:\\t");');
    expect(contents).not.toContain('std::string_view');
  });

  it('keeps plain and empty strings in their existing form', () => {
    const contents = emit(`
      export function plain(): string { return 'plain'; }
      export function empty(): string { return ''; }
    `);

    expect(contents).toContain('return flight::String("plain");');
    expect(contents).toContain('return flight::String("");');
    expect(contents).not.toContain('std::string_view');
  });

  it('keeps non-ASCII UTF-8 data on the existing runtime decoding path', () => {
    const contents = emit(`export function unicode(): string { return 'café 😀'; }`);

    expect(contents).toContain('return flight::String("café 😀");');
    expect(contents).not.toContain('std::string_view');
  });
});
