import { describe, expect, it } from 'vitest';

import type { HaxeDualBindingGateFailure, HaxeDualBindingLocatorHooks } from './haxeDualBindingGate.js';
import { evaluateHaxeDualBindingGates, sortHaxeDualBindingGateFailures } from './haxeDualBindingGate.js';
import type { HaxeDualBindingCppLocator, HaxeDualBindingPlan } from './haxeDualBindingPlan.js';
import { parseHaxeDualBindingPlanArtifact } from './haxeDualBindingPlan.js';

function plan(bindings: readonly Record<string, unknown>[]): Readonly<HaxeDualBindingPlan> {
  const result = parseHaxeDualBindingPlanArtifact({ bindings, schema: 'flight-haxe-dual-binding-plan/1' });
  if (result.kind !== 'haxe-dual-binding-plan-parsed') throw new Error(`Expected a parsed plan: ${result.rule}`);
  return result.plan;
}

function callableBinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cpp: {
      availability: 'available',
      locator: {
        carrier: 'function',
        include: 'flight/render/draw.hpp',
        namespace: 'flight::render',
        spelling: 'draw',
      },
    },
    identity: {
      declarationIdentity: 'sha256:draw',
      exportRoute: 'flight.render',
      packageName: '@flight/render',
      source: 'packages/render/src/draw.ts',
      space: 'value',
    },
    javascript: { availability: 'available', locator: { exportedName: 'draw', specifier: '@flight/render' } },
    key: 'draw',
    publicHaxe: {
      kind: 'function',
      name: 'draw',
      owner: '',
      qualifiedName: 'flight.render.draw',
      signature: 'draw(context, image): void',
      typeIdentity: 'sha256:draw-type',
    },
    ...overrides,
  };
}

function typeBinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cpp: {
      availability: 'available',
      locator: {
        carrier: 'interface',
        include: 'flight/render/surface.hpp',
        namespace: 'flight::render',
        spelling: 'Surface',
      },
    },
    identity: {
      declarationIdentity: 'sha256:surface',
      exportRoute: 'flight.render',
      packageName: '@flight/render',
      source: 'packages/render/src/surface.ts',
      space: 'type',
    },
    javascript: { availability: 'available', locator: { exportedName: 'Surface', specifier: '@flight/render' } },
    key: 'surface',
    publicHaxe: {
      kind: 'type',
      name: 'Surface',
      owner: '',
      qualifiedName: 'flight.render.Surface',
      typeIdentity: 'sha256:surface-type',
    },
    ...overrides,
  };
}

function presentHooks(overrides: Partial<HaxeDualBindingLocatorHooks> = {}): HaxeDualBindingLocatorHooks {
  return {
    resolveCppSymbol: () => ({ status: 'present' }),
    resolveJavaScriptExport: () => ({ status: 'present' }),
    ...overrides,
  };
}

function rules(failures: readonly HaxeDualBindingGateFailure[]): readonly string[] {
  return failures.map((failure) => failure.rule);
}

describe('evaluateHaxeDualBindingGates', () => {
  it('passes a plan whose both backings exist for a callable and a type', () => {
    const report = evaluateHaxeDualBindingGates(plan([callableBinding(), typeBinding()]), presentHooks());

    expect(report.failures).toEqual([]);
    expect(report.kind).toBe('haxe-dual-binding-gate-report');
    expect(report.bindings).toBe(2);
    expect(report.lanes).toEqual([
      { kind: 'cpp', skipped: [], verified: { callables: 1, types: 1 } },
      { kind: 'javascript', skipped: [], verified: { callables: 1, types: 1 } },
    ]);
  });

  it('refuses a callable that publishes no signature, because its backings cannot be compared', () => {
    const binding = callableBinding();
    const withoutSignature = plan([
      { ...binding, publicHaxe: { ...(binding['publicHaxe'] as object), signature: undefined } },
      typeBinding(),
    ]);

    const report = evaluateHaxeDualBindingGates(withoutSignature, presentHooks());

    expect(rules(report.failures)).toEqual(['haxe-dual-binding-gate-signature-parity']);
    expect(report.failures[0]?.subject).toBe('binding:draw');
    expect(report.failures[0]?.detail).toContain('with no published signature');
  });

  it('refuses a refused backing and quotes the producer refusal', () => {
    const refusedCpp = plan([
      callableBinding({
        cpp: {
          availability: 'refused',
          refusal: {
            code: 'cpp-declaration-missing',
            detailCode: 'interface-inheritance',
            message: 'the C++ declaration could not be named for this export route',
            subject: 'flight.render.draw',
          },
        },
      }),
      typeBinding(),
    ]);
    const refusedJavaScript = plan([
      callableBinding({
        javascript: {
          availability: 'refused',
          refusal: {
            code: 'js-module-refused',
            message: 'the JavaScript module refused',
            subject: 'flight.render.draw',
          },
        },
      }),
      typeBinding(),
    ]);

    const cppReport = evaluateHaxeDualBindingGates(refusedCpp, presentHooks());
    expect(rules(cppReport.failures)).toContain('haxe-dual-binding-gate-backing-refused');
    expect(cppReport.failures[0]?.detail).toContain('cpp-declaration-missing refused flight.render.draw');
    expect(cppReport.failures[0]?.detail).toContain('the C++ declaration could not be named');
    // The JavaScript backing still verified the callable, and the C++ lane still verified the type, so the
    // only failures are the refusal and the callable the C++ lane never verified.
    expect(cppReport.lanes).toEqual([
      { kind: 'cpp', skipped: [], verified: { callables: 0, types: 1 } },
      { kind: 'javascript', skipped: [], verified: { callables: 1, types: 1 } },
    ]);

    const jsReport = evaluateHaxeDualBindingGates(refusedJavaScript, presentHooks());
    expect(jsReport.failures.map((failure) => [failure.rule, failure.subject])).toContainEqual([
      'haxe-dual-binding-gate-backing-refused',
      'binding:draw',
    ]);
  });

  it('asks each lane for its own locator and reports one that is absent', () => {
    const asked: unknown[] = [];
    const report = evaluateHaxeDualBindingGates(
      plan([callableBinding(), typeBinding()]),
      presentHooks({
        resolveCppSymbol: (locator: Readonly<HaxeDualBindingCppLocator>) => {
          asked.push(locator);
          return { detail: 'the header declares no such symbol', status: 'absent' };
        },
        resolveJavaScriptExport: (locator) => {
          asked.push(locator);
          return { status: 'present' };
        },
      }),
    );

    expect(asked).toEqual([
      { carrier: 'function', include: 'flight/render/draw.hpp', namespace: 'flight::render', spelling: 'draw' },
      { exportedName: 'draw', specifier: '@flight/render' },
      { carrier: 'interface', include: 'flight/render/surface.hpp', namespace: 'flight::render', spelling: 'Surface' },
      { exportedName: 'Surface', specifier: '@flight/render' },
    ]);
    expect(report.failures).toEqual([
      {
        detail:
          'flight.render.draw is not at flight/render/draw.hpp flight::render::draw: the header declares no such symbol',
        kind: 'haxe-dual-binding-gate-failure',
        rule: 'haxe-dual-binding-gate-locator-absent',
        subject: 'binding:draw',
      },
      {
        detail:
          'flight.render.Surface is not at flight/render/surface.hpp flight::render::Surface: the header declares no such symbol',
        kind: 'haxe-dual-binding-gate-failure',
        rule: 'haxe-dual-binding-gate-locator-absent',
        subject: 'binding:surface',
      },
      {
        detail: 'the cpp backing verified no type; a gate that checks nothing passes nothing',
        kind: 'haxe-dual-binding-gate-failure',
        rule: 'haxe-dual-binding-gate-vacuous',
        subject: 'lane:cpp',
      },
      {
        detail: 'the cpp backing verified no callable; a gate that checks nothing passes nothing',
        kind: 'haxe-dual-binding-gate-failure',
        rule: 'haxe-dual-binding-gate-vacuous',
        subject: 'lane:cpp',
      },
    ]);
  });

  it('records an unchecked binding as unchecked instead of counting it as a pass', () => {
    const report = evaluateHaxeDualBindingGates(
      plan([callableBinding(), typeBinding()]),
      presentHooks({ resolveCppSymbol: () => ({ detail: 'no C++ compiler is installed', status: 'skipped' }) }),
    );

    expect(report.lanes[0]).toEqual({
      kind: 'cpp',
      skipped: [
        'binding:draw (flight/render/draw.hpp flight::render::draw)',
        'binding:surface (flight/render/surface.hpp flight::render::Surface)',
      ],
      verified: { callables: 0, types: 0 },
    });
    expect(rules(report.failures)).toEqual(['haxe-dual-binding-gate-vacuous', 'haxe-dual-binding-gate-vacuous']);
    expect(report.failures[0]?.detail).toContain('2 bindings were not checked');
    expect(report.failures[0]?.detail).toContain('binding:surface');
  });

  it('refuses a lane that verified no type or no callable', () => {
    const onlyTypes = evaluateHaxeDualBindingGates(plan([typeBinding()]), presentHooks());
    const nothing = evaluateHaxeDualBindingGates(plan([]), presentHooks());

    expect(onlyTypes.failures.map((failure) => [failure.subject, failure.rule])).toEqual([
      ['lane:cpp', 'haxe-dual-binding-gate-vacuous'],
      ['lane:javascript', 'haxe-dual-binding-gate-vacuous'],
    ]);
    expect(onlyTypes.failures[0]?.detail).toContain('verified no callable');
    expect(onlyTypes.lanes[0]?.verified).toEqual({ callables: 0, types: 1 });

    expect(nothing.failures).toHaveLength(4);
    expect(nothing.bindings).toBe(0);
  });

  it('answers the same report twice, in the same order, for the same plan', () => {
    const shared = plan([callableBinding(), typeBinding()]);
    const hooks = presentHooks({ resolveJavaScriptExport: () => ({ detail: 'absent', status: 'absent' }) });

    const first = evaluateHaxeDualBindingGates(shared, hooks);
    const second = evaluateHaxeDualBindingGates(shared, hooks);

    expect(first).toEqual(second);
    expect(first.failures.map((failure) => failure.subject)).toEqual([
      'binding:draw',
      'binding:surface',
      'lane:javascript',
      'lane:javascript',
    ]);
  });
});

describe('sortHaxeDualBindingGateFailures', () => {
  it('orders failures by subject and then rule without mutating the caller list', () => {
    const failures: HaxeDualBindingGateFailure[] = [
      {
        detail: 'b',
        kind: 'haxe-dual-binding-gate-failure',
        rule: 'haxe-dual-binding-gate-vacuous',
        subject: 'lane:javascript',
      },
      {
        detail: 'a',
        kind: 'haxe-dual-binding-gate-failure',
        rule: 'haxe-dual-binding-gate-vacuous',
        subject: 'lane:cpp',
      },
      {
        detail: 'c',
        kind: 'haxe-dual-binding-gate-failure',
        rule: 'haxe-dual-binding-gate-locator-absent',
        subject: 'lane:cpp',
      },
    ];
    const before = [...failures];

    expect(sortHaxeDualBindingGateFailures(failures).map((failure) => [failure.subject, failure.rule])).toEqual([
      ['lane:cpp', 'haxe-dual-binding-gate-locator-absent'],
      ['lane:cpp', 'haxe-dual-binding-gate-vacuous'],
      ['lane:javascript', 'haxe-dual-binding-gate-vacuous'],
    ]);
    expect(failures).toEqual(before);
  });
});
