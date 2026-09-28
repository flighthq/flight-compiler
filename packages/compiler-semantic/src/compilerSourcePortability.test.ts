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

  it('requires tray-style failure results to normalize unknown error payloads at their producer boundary', () => {
    const opaque = input(
      'Tray.ts',
      `export type TrayCreateResult =
         | { readonly outcome: 'created' }
         | { readonly error?: unknown; readonly outcome: 'invalid-icon' }
         | { readonly error?: unknown; readonly outcome: 'tray-create-failed' };
       interface UnrelatedState { readonly payload: unknown }`,
    );
    const closed = input(
      'PortableTray.ts',
      `interface TrayErrorPayload {
         readonly code: string | null;
         readonly message: string;
       }
       export type TrayCreateResult =
         | { readonly outcome: 'created' }
         | { readonly error?: TrayErrorPayload; readonly outcome: 'invalid-icon' }
         | { readonly error?: TrayErrorPayload; readonly outcome: 'tray-create-failed' };`,
    );

    const findings = analyzeTypeScriptSourcePortability([opaque]).findings;
    const errorFindings = findings.filter(({ subject }) => subject.endsWith('/property:error'));
    expect(errorFindings).toHaveLength(2);
    expect(errorFindings.map(({ subject }) => subject)).toEqual([
      'type:TrayCreateResult/arm:outcome=invalid-icon/property:error',
      'type:TrayCreateResult/arm:outcome=tray-create-failed/property:error',
    ]);
    for (const finding of errorFindings) {
      expect(finding).toMatchObject({ rule: 'opaque-value-domain' });
      expect(finding.message).toContain('exposes unknown as an optional error payload');
      expect(finding.message).toContain('JavaScript permits throwing values of any type');
      expect(finding.message).toContain(
        'Normalize every producer at the catch or provider boundary into a named closed error payload',
      );
      expect(finding.message).toContain('record a reviewed source-portability exception');
      expect(finding.message).toContain(
        'will not infer Error, stringify the value, or choose a target-specific Any carrier',
      );
    }
    // The specialized remediation is scoped to the error boundary; other opaque properties retain the
    // general closed-domain guidance, while one named portable payload clears every result arm.
    const unrelated = findings.find(({ subject }) => subject === 'interface:UnrelatedState/property:payload');
    expect(unrelated?.message).toContain('Replace it with a named closed value type');
    expect(unrelated?.message).not.toContain('JavaScript permits throwing values');
    expect(analyzeTypeScriptSourcePortability([closed]).findings).toEqual([]);
  });

  it('requires a closed handle domain or a reviewed exception for intentional erasure', () => {
    const erased = input('appLoop.ts', 'interface LoopState { frameHandle: unknown }');
    const report = analyzeTypeScriptSourcePortability([erased]);
    const finding = report.findings[0];
    if (!finding) throw new Error('Expected an opaque loop handle finding');
    const closed = input(
      'portable-appLoop.ts',
      `type AppLoopFrameHandle = number;
       interface AppLoopBackend {
         requestFrame(callback: (time: number) => void): AppLoopFrameHandle;
         cancelFrame(handle: AppLoopFrameHandle): void;
       }
       interface LoopState { frameHandle: AppLoopFrameHandle | null }`,
    );

    expect(report.findings).toMatchObject([
      {
        message: expect.stringContaining(
          'Replace it with a named closed value type shared by the boundary, its storage, and its consumers; when intentional erasure is the contract, record a reviewed source-portability exception instead.',
        ),
        rule: 'opaque-value-domain',
        subject: 'interface:LoopState/property:frameHandle',
      },
    ]);
    expect(analyzeTypeScriptSourcePortability([closed]).findings).toEqual([]);
    expect(
      analyzeTypeScriptSourcePortability([erased], {
        exceptionPolicy: {
          exceptions: [
            {
              findingIdentity: finding.identity,
              reason: 'The handle is an opaque token returned only to its provider.',
              rule: 'opaque-value-domain',
            },
          ],
          schema: 'flight-compiler-source-portability-exceptions/1',
        },
      }),
    ).toMatchObject({
      acceptedExceptions: [{ finding: { identity: finding.identity } }],
      findings: [],
    });
  });

  it('keeps optional nullable callbacks as mixed absence until the API elects one state model', () => {
    const mixed = input(
      'AnimationPlayer.ts',
      `interface AnimationClipEvent { readonly name: string }
       interface Signal<T> { readonly id: number }
       interface AnimationPlayer {
         onEvent?: Signal<(event: Readonly<AnimationClipEvent>) => void> | null;
         onFinished?: Signal<() => void> | null;
         onLooped?: Signal<() => void> | null;
       }`,
    );
    const optional = input(
      'OptionalAnimationPlayer.ts',
      `interface Signal<T> { readonly id: number }
       interface AnimationPlayer { onFinished?: Signal<() => void> }`,
    );
    const nullable = input(
      'NullableAnimationPlayer.ts',
      `interface AnimationClipEvent { readonly name: string }
       interface Signal<T> { readonly id: number }
       interface AnimationPlayer {
         onEvent: Signal<(event: Readonly<AnimationClipEvent>) => void> | null;
         onFinished: Signal<() => void> | null;
         onLooped: Signal<() => void> | null;
       }`,
    );
    const explicit = input(
      'ExplicitAnimationPlayer.ts',
      `interface Signal<T> { readonly id: number }
       type CallbackState =
         | { readonly state: 'unset' }
         | { readonly state: 'disabled' }
         | { readonly signal: Signal<() => void>; readonly state: 'bound' };
       interface AnimationPlayer { onFinished: CallbackState }`,
    );

    // A callback-bearing Signal does not make the two implicit absence spellings one source contract. The
    // measured constructors write null, and every direct use collapses null and undefined with `== null`, so
    // making these properties required-nullable is the exact narrow source fix. The declaration nevertheless
    // exposes three distinguishable states to other consumers until it chooses that one sentinel (or names
    // all three states explicitly), so the gate must not infer the choice from current downstream uses.
    expect(analyzeTypeScriptSourcePortability([mixed]).findings).toMatchObject([
      {
        message:
          'interface:AnimationPlayer/property:onEvent combines an optional property with null; choose one absence representation or make all three states explicit.',
        rule: 'mixed-absence',
        subject: 'interface:AnimationPlayer/property:onEvent',
      },
      {
        message:
          'interface:AnimationPlayer/property:onFinished combines an optional property with null; choose one absence representation or make all three states explicit.',
        rule: 'mixed-absence',
        subject: 'interface:AnimationPlayer/property:onFinished',
      },
      {
        message:
          'interface:AnimationPlayer/property:onLooped combines an optional property with null; choose one absence representation or make all three states explicit.',
        rule: 'mixed-absence',
        subject: 'interface:AnimationPlayer/property:onLooped',
      },
    ]);
    expect(
      analyzeTypeScriptSourcePortability([optional, nullable, explicit]).findings.filter(
        (finding) => finding.rule === 'mixed-absence',
      ),
    ).toEqual([]);
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

  it('requires declared mutable storage for an intentionally open effect domain', () => {
    const asserted = input(
      'effectDefaults.ts',
      `interface Effect { readonly kind: string }
       export function normalizeEffect(effect: Readonly<Effect>, out: Effect): boolean {
         const effectRec = effect as Record<string, unknown>;
         const outRec = out as unknown as Record<string, unknown>;
         for (const key of Object.keys(effectRec)) outRec[key] = effectRec[key];
         return true;
       }`,
    );
    const indexed = input(
      'portable-effectDefaults.ts',
      `interface Effect {
         readonly kind: string;
         [property: string]: unknown;
       }
       export function normalizeEffect(effect: Readonly<Effect>, out: Effect): boolean {
         for (const key of Object.keys(effect)) out[key] = effect[key];
         return true;
       }`,
    );

    expect(analyzeTypeScriptSourcePortability([asserted]).findings).toMatchObject([
      {
        message:
          'function:normalizeEffect uses a double assertion through unknown to claim mutable index-signature storage; the bridge neither proves nor creates writable dynamic cells on the source owner. For an intentionally open key or extension domain, declare a mutable string index signature on the base/output type and construct every value in that carrier; a registry of keys or roles does not recover cells on an owner that lacks them. If the keys are closed, replace the dynamic writes with a finite union of declared members. A reviewed exception can record the source contract but cannot supply that storage; copying or materializing a Record, or adding side storage, would change object identity.',
        rule: 'unchecked-double-assertion',
        subject: 'function:normalizeEffect',
      },
    ]);
    expect(analyzeTypeScriptSourcePortability([indexed]).findings).toEqual([]);
  });

  it('keeps open effect interpolation storage on its base/output carrier', () => {
    const asserted = input(
      'effectInterpolation.ts',
      `interface Effect { readonly kind: string }
       type EffectFieldRole = 'boolean' | 'number';
       type EffectFieldRoles = Readonly<Record<string, Readonly<Record<string, EffectFieldRole>>>>;
       const EFFECT_FIELD_ROLES: EffectFieldRoles = {};
       export function lerpEffect(
         a: Readonly<Effect>,
         b: Readonly<Effect>,
         t: number,
         out: Effect,
         roles: EffectFieldRoles = EFFECT_FIELD_ROLES,
       ): boolean {
         if (a.kind !== b.kind) return false;
         const aRec = a as Record<string, unknown>;
         const bRec = b as Record<string, unknown>;
         const outRecord = out as unknown as Record<string, unknown>;
         for (const key of Object.keys(aRec)) {
           if (roles[a.kind]?.[key] === 'number') outRecord[key] = t;
           else outRecord[key] = bRec[key];
         }
         return true;
       }`,
    );
    const indexed = input(
      'indexed-effectInterpolation.ts',
      `interface Effect {
         readonly kind: string;
         [field: string]: unknown;
       }
       export function lerpEffect(a: Readonly<Effect>, b: Readonly<Effect>, out: Effect): boolean {
         if (a.kind !== b.kind) return false;
         for (const key of Object.keys(a)) out[key] = b[key];
         return true;
       }`,
    );
    const closed = input(
      'closed-effectInterpolation.ts',
      `interface BlurEffect { amount: number; readonly kind: 'blur' }
       interface ToggleEffect { enabled: boolean; readonly kind: 'toggle' }
       type Effect = BlurEffect | ToggleEffect;
       export function lerpEffect(a: Readonly<Effect>, b: Readonly<Effect>, out: Effect): boolean {
         if (a.kind === 'blur' && b.kind === 'blur' && out.kind === 'blur') out.amount = b.amount;
         else if (a.kind === 'toggle' && b.kind === 'toggle' && out.kind === 'toggle') out.enabled = b.enabled;
         else return false;
         return true;
       }`,
    );
    const report = analyzeTypeScriptSourcePortability([asserted]);
    const finding = report.findings[0];
    if (!finding) throw new Error('Expected an effect interpolation assertion finding');

    expect(report.findings).toMatchObject([
      {
        message:
          'function:lerpEffect uses a double assertion through unknown to claim mutable index-signature storage; the bridge neither proves nor creates writable dynamic cells on the source owner. For an intentionally open key or extension domain, declare a mutable string index signature on the base/output type and construct every value in that carrier; a registry of keys or roles does not recover cells on an owner that lacks them. If the keys are closed, replace the dynamic writes with a finite union of declared members. A reviewed exception can record the source contract but cannot supply that storage; copying or materializing a Record, or adding side storage, would change object identity.',
        rule: 'unchecked-double-assertion',
        subject: 'function:lerpEffect',
      },
    ]);
    expect(analyzeTypeScriptSourcePortability([indexed, closed]).findings).toEqual([]);
    expect(
      analyzeTypeScriptSourcePortability([asserted], {
        exceptionPolicy: {
          exceptions: [
            {
              findingIdentity: finding.identity,
              reason: 'Effect kinds and registered field roles are an intentionally open web contract.',
              rule: 'unchecked-double-assertion',
            },
          ],
          schema: 'flight-compiler-source-portability-exceptions/1',
        },
      }),
    ).toMatchObject({
      acceptedExceptions: [{ finding: { identity: finding.identity } }],
      findings: [],
    });
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
