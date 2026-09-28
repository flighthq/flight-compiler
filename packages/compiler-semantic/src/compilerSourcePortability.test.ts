import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import type { TypeScriptPackageGraphSource } from '../../compiler-types/src/index.js';
import { analyzeTypeScriptSourcePortability } from './compilerSourcePortability.js';

describe('analyzeTypeScriptSourcePortability', () => {
  it('reports stable actionable sites for the three Flight source gate concepts', () => {
    const source = input(
      'contract.ts',
      [
        'type NativeHandle = unknown;',
        'interface Contract {',
        '  payload: unknown;',
        '  error: unknown;',
        '  records: Readonly<Record<string, any>>;',
        '  maybe?: string | null;',
        '  required: string | null | undefined;',
        '  convert(value: any): unknown;',
        '}',
        'declare const source: string;',
        'const first = source as unknown as number;',
        'const second = <boolean><any>source;',
        'const third = source as never as symbol;',
        'const fourth = (source as unknown) as bigint;',
      ].join('\n'),
    );

    const report = analyzeTypeScriptSourcePortability([source]);

    expect(report.schema).toBe('flight-compiler-source-portability/1');
    expect(report.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual([
      { rule: 'mixed-absence', subject: 'interface:Contract/property:maybe' },
      { rule: 'mixed-absence', subject: 'interface:Contract/property:required' },
      { rule: 'opaque-value-domain', subject: 'interface:Contract/method:convert.parameter:value' },
      { rule: 'opaque-value-domain', subject: 'interface:Contract/method:convert.return' },
      { rule: 'opaque-value-domain', subject: 'interface:Contract/property:error' },
      { rule: 'opaque-value-domain', subject: 'interface:Contract/property:payload' },
      { rule: 'opaque-value-domain', subject: 'interface:Contract/property:records' },
      { rule: 'opaque-value-domain', subject: 'type:NativeHandle' },
      { rule: 'unchecked-double-assertion', subject: 'module' },
      { rule: 'unchecked-double-assertion', subject: 'module' },
      { rule: 'unchecked-double-assertion', subject: 'module' },
      { rule: 'unchecked-double-assertion', subject: 'module' },
    ]);
    expect(report.findings.every((finding) => finding.line > 0 && finding.column > 0)).toBe(true);
    expect(report.findings.every((finding) => finding.message.includes(finding.subject))).toBe(true);
    expect(report.findings.every((finding) => finding.identity.includes(finding.fingerprint))).toBe(true);
    expect(report.findings.some((finding) => finding.message.includes('through any'))).toBe(true);
    expect(report.findings.some((finding) => finding.message.includes('through unknown'))).toBe(true);
    expect(report.findings.some((finding) => finding.message.includes('through never'))).toBe(true);
    expect(report.acceptedExceptions).toEqual([]);
  });

  it('is input-order independent and keeps identities stable across trivia changes', () => {
    const compact = input('compact.ts', 'interface Value { payload: unknown }');
    const formatted = input('compact.ts', 'interface Value {\n  payload: unknown;\n}\n');
    const other = input('other.ts', 'interface Options { value?: string | null }');

    const first = analyzeTypeScriptSourcePortability([compact, other]);
    const reordered = analyzeTypeScriptSourcePortability([other, compact]);
    const reformatted = analyzeTypeScriptSourcePortability([formatted, other]);

    expect(reordered).toEqual(first);
    expect(reformatted.findings.map((finding) => finding.identity)).toEqual(
      first.findings.map((finding) => finding.identity),
    );
    expect(reformatted.findings[0]?.line).not.toBe(first.findings[0]?.line);
  });

  it('requires one shared closed domain for a nested opaque parameter property', () => {
    const opaque = input(
      'command.ts',
      `export function createSetNodePropertyCommandBatch(
         entries: readonly Readonly<{ property: string; value: unknown }>[],
       ): void { void entries; }`,
    );
    const explicit = input(
      'portable-command.ts',
      `type CommandPropertyValue = boolean | number | string | null;
       interface CommandPropertyEntry {
         readonly after: CommandPropertyValue;
         readonly before: CommandPropertyValue;
       }
       export function createSetNodePropertyCommandBatch(
         entries: readonly Readonly<{ property: string; value: CommandPropertyValue }>[],
       ): CommandPropertyEntry[] {
         return entries.map((entry) => ({ after: entry.value, before: entry.value }));
       }`,
    );

    expect(analyzeTypeScriptSourcePortability([opaque]).findings).toMatchObject([
      {
        message:
          'function:createSetNodePropertyCommandBatch/parameter:entries/property:value exposes unknown; no exact runtime value domain can be recovered from that annotation or its downstream uses. Replace it with a named closed value type shared by the boundary, its storage, and its consumers; when intentional erasure is the contract, record a reviewed source-portability exception instead.',
        rule: 'opaque-value-domain',
        subject: 'function:createSetNodePropertyCommandBatch/parameter:entries/property:value',
      },
    ]);
    expect(analyzeTypeScriptSourcePortability([explicit]).findings).toEqual([]);
  });

  it('requires real indexed storage instead of an asserted index-signature view', () => {
    const asserted = input(
      'command.ts',
      `interface NodeAny { readonly enabled: boolean }
       export function readNodeProperty(target: Readonly<NodeAny>, property: string): unknown {
         return (target as unknown as Readonly<Record<string, unknown>>)[property];
       }`,
    );
    const indexed = input(
      'portable-command.ts',
      `type CommandPropertyValue = boolean | number | string | null;
       interface CommandPropertyTarget {
         readonly [property: string]: CommandPropertyValue;
       }
       export function readNodeProperty(
         target: Readonly<CommandPropertyTarget>,
         property: string,
       ): CommandPropertyValue {
         return target[property];
       }`,
    );

    expect(analyzeTypeScriptSourcePortability([asserted]).findings).toMatchObject([
      {
        message:
          'function:readNodeProperty uses a double assertion through unknown to claim an index-signature view; the bridge neither checks that the source has indexed storage nor preserves an exact runtime carrier for computed access. Accept a declared Record or index-signature type at this boundary, or replace the dynamic key with checked access over a closed key/value domain; an assertion cannot create that storage.',
        rule: 'unchecked-double-assertion',
        subject: 'function:readNodeProperty',
      },
    ]);
    expect(analyzeTypeScriptSourcePortability([indexed]).findings).toEqual([]);
  });

  it('excludes declaration, test-only, and generated inputs before visiting their syntax', () => {
    const text = 'interface Value { payload: any; absent?: string | null }';
    const sources = [
      input('contract.d.ts', text),
      input('contract.test.ts', text),
      input('contract.spec.ts', text),
      input('contract.generated.ts', text),
      input('tests/contract.ts', text),
      input('generated/contract.ts', text),
      input('banner.ts', `// @generated\n${text}`),
    ];

    expect(analyzeTypeScriptSourcePortability(sources)).toEqual({
      acceptedExceptions: [],
      findings: [],
      schema: 'flight-compiler-source-portability/1',
    });
  });

  it('moves caller-owned exception identities out of debt and rejects stale or unexplained records', () => {
    const source = input(
      'value.ts',
      "type Result = { type: 'first'; payload: unknown } | { type: 'second'; payload: unknown };",
    );
    const initial = analyzeTypeScriptSourcePortability([source]);
    const findingIdentity = initial.findings[0]?.identity;
    if (!findingIdentity) throw new Error('Expected an opaque finding');

    expect(initial.findings.map((finding) => finding.subject)).toEqual([
      'type:Result/arm:type=first/property:payload',
      'type:Result/arm:type=second/property:payload',
    ]);
    expect(new Set(initial.findings.map((finding) => finding.identity)).size).toBe(2);

    const accepted = analyzeTypeScriptSourcePortability([source], {
      exceptionPolicy: {
        exceptions: [
          {
            findingIdentity,
            reason: 'The boundary intentionally receives untrusted input.',
            rule: 'opaque-value-domain',
          },
        ],
        schema: 'flight-compiler-source-portability-exceptions/1',
      },
    });

    expect(accepted.findings.map((finding) => finding.subject)).toEqual([
      'type:Result/arm:type=second/property:payload',
    ]);
    expect(accepted.acceptedExceptions).toMatchObject([
      { finding: { identity: findingIdentity }, reason: 'The boundary intentionally receives untrusted input.' },
    ]);
    expect(() =>
      analyzeTypeScriptSourcePortability([source], {
        exceptionPolicy: {
          exceptions: [{ findingIdentity: 'stale', reason: 'Old site.', rule: 'opaque-value-domain' }],
          schema: 'flight-compiler-source-portability-exceptions/1',
        },
      }),
    ).toThrow('Stale source portability exception stale');
    expect(() =>
      analyzeTypeScriptSourcePortability([source], {
        exceptionPolicy: {
          exceptions: [{ findingIdentity, reason: '  ', rule: 'opaque-value-domain' }],
          schema: 'flight-compiler-source-portability-exceptions/1',
        },
      }),
    ).toThrow(`Source portability exception ${findingIdentity} has no reason`);
    expect(() =>
      analyzeTypeScriptSourcePortability([source], {
        exceptionPolicy: {
          exceptions: [
            {
              findingIdentity,
              reason: 'Wrong rule.',
              rule: 'mixed-absence',
            },
          ],
          schema: 'flight-compiler-source-portability-exceptions/1',
        },
      }),
    ).toThrow(`Source portability exception ${findingIdentity} names mixed-absence`);
    expect(() =>
      analyzeTypeScriptSourcePortability([source], {
        exceptionPolicy: {
          exceptions: [
            { findingIdentity, reason: 'Exact intent.', rule: 'opaque-value-domain' },
            { findingIdentity, reason: 'Exact intent.', rule: 'opaque-value-domain' },
          ],
          schema: 'flight-compiler-source-portability-exceptions/1',
        },
      }),
    ).toThrow(`Duplicate source portability exception ${findingIdentity}`);
  });

  it('rejects a source outside the declared upstream checkout', () => {
    expect(() => analyzeTypeScriptSourcePortability([input('../outside.ts', 'const value = 1;')])).toThrow(
      'Source is outside upstream checkout',
    );
  });
});

function input(file: string, text: string): TypeScriptPackageGraphSource {
  const fileName = `/flight/${file}`;
  return {
    packageName: '@flighthq/example',
    packageRoot: '/flight',
    sourceFile: ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true),
    upstreamDirectory: '/flight',
  };
}
