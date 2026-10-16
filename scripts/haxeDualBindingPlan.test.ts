import { describe, expect, it } from 'vitest';

import type { HaxeDualBindingPlanParseFailure } from './haxeDualBindingPlan.js';
import { parseHaxeDualBindingPlanArtifact, sortHaxeDualBindingPlanFailures } from './haxeDualBindingPlan.js';

function binding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function artifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bindings: [
      binding(),
      binding({
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
      }),
    ],
    schema: 'flight-haxe-dual-binding-plan/1',
    ...overrides,
  };
}

function ruleOf(result: ReturnType<typeof parseHaxeDualBindingPlanArtifact>): string {
  return 'rule' in result ? result.rule : 'parsed';
}

describe('parseHaxeDualBindingPlanArtifact', () => {
  it('reads a complete plan and preserves its declared bindings, identities, and locators', () => {
    const result = parseHaxeDualBindingPlanArtifact(artifact());

    expect(result.kind).toBe('haxe-dual-binding-plan-parsed');
    if (result.kind !== 'haxe-dual-binding-plan-parsed') throw new Error('Expected a parsed plan');
    expect(result.plan.schema).toBe('flight-haxe-dual-binding-plan/1');
    expect(result.plan.bindings.map((entry) => entry.key)).toEqual(['draw', 'surface']);
    expect(result.plan.bindings.map((entry) => entry.publicHaxe.kind)).toEqual(['function', 'type']);
    expect(result.plan.bindings[0]?.identity.exportRoute).toBe('flight.render');
    expect(result.plan.bindings[1]?.cpp).toEqual({
      availability: 'available',
      locator: {
        carrier: 'interface',
        include: 'flight/render/surface.hpp',
        namespace: 'flight::render',
        spelling: 'Surface',
      },
    });
  });

  it('refuses an artifact that is not an object, or carries another schema', () => {
    expect(ruleOf(parseHaxeDualBindingPlanArtifact(undefined))).toBe('haxe-dual-binding-plan-shape-invalid');
    expect(ruleOf(parseHaxeDualBindingPlanArtifact([]))).toBe('haxe-dual-binding-plan-shape-invalid');
    expect(ruleOf(parseHaxeDualBindingPlanArtifact(artifact({ bindings: undefined })))).toBe(
      'haxe-dual-binding-plan-shape-invalid',
    );
    expect(ruleOf(parseHaxeDualBindingPlanArtifact(artifact({ schema: 'flight-haxe-dual-binding-plan/2' })))).toBe(
      'haxe-dual-binding-plan-schema-unsupported',
    );
  });

  it('refuses duplicate binding keys and one public name bound twice', () => {
    const duplicateKey = artifact({
      bindings: [binding(), binding({ identity: { ...(binding()['identity'] as object) } })],
    });
    expect(ruleOf(parseHaxeDualBindingPlanArtifact(duplicateKey))).toBe('haxe-dual-binding-plan-key-duplicate');

    const duplicateName = artifact({
      bindings: [binding(), binding({ key: 'draw-again' })],
    });
    expect(ruleOf(parseHaxeDualBindingPlanArtifact(duplicateName))).toBe(
      'haxe-dual-binding-plan-public-name-duplicate',
    );

    const disagreeingSignature = artifact({
      bindings: [
        binding(),
        binding({
          key: 'draw-again',
          publicHaxe: { ...(binding()['publicHaxe'] as object), signature: 'draw(): void' },
        }),
      ],
    });
    const failure = parseHaxeDualBindingPlanArtifact(disagreeingSignature);
    expect(ruleOf(failure)).toBe('haxe-dual-binding-plan-public-name-duplicate');
    expect('detail' in failure ? failure.detail : '').toContain('different signatures');
  });

  it('requires every refused backing to name its refusal completely', () => {
    const refused = artifact({
      bindings: [
        binding({
          cpp: {
            availability: 'refused',
            refusal: {
              code: 'cpp-declaration-missing',
              message: 'no C++ declaration was emitted',
              subject: 'flight.render.draw',
            },
          },
        }),
      ],
    });
    expect(ruleOf(parseHaxeDualBindingPlanArtifact(refused))).toBe('parsed');

    const withoutMessage = artifact({
      bindings: [
        binding({ cpp: { availability: 'refused', refusal: { code: 'cpp-declaration-missing', subject: 'x' } } }),
      ],
    });
    expect(ruleOf(parseHaxeDualBindingPlanArtifact(withoutMessage))).toBe(
      'haxe-dual-binding-plan-availability-incomplete',
    );

    const unknownAvailability = artifact({ bindings: [binding({ javascript: { availability: 'maybe' } })] });
    expect(ruleOf(parseHaxeDualBindingPlanArtifact(unknownAvailability))).toBe(
      'haxe-dual-binding-plan-availability-incomplete',
    );

    const availableWithoutLocator = artifact({ bindings: [binding({ javascript: { availability: 'available' } })] });
    expect(ruleOf(parseHaxeDualBindingPlanArtifact(availableWithoutLocator))).toBe(
      'haxe-dual-binding-plan-availability-incomplete',
    );
  });

  it('refuses a carrier outside the published set and an incomplete locator', () => {
    const unknownCarrier = artifact({
      bindings: [
        binding({
          cpp: {
            availability: 'available',
            locator: { carrier: 'macro', include: 'x.hpp', namespace: 'x', spelling: 'y' },
          },
        }),
      ],
    });
    expect(ruleOf(parseHaxeDualBindingPlanArtifact(unknownCarrier))).toBe('haxe-dual-binding-plan-carrier-unsupported');

    const incomplete = artifact({
      bindings: [binding({ cpp: { availability: 'available', locator: { carrier: 'function', include: 'x.hpp' } } })],
    });
    expect(ruleOf(parseHaxeDualBindingPlanArtifact(incomplete))).toBe('haxe-dual-binding-plan-shape-invalid');

    const incompleteJs = artifact({ bindings: [binding({ javascript: { availability: 'available', locator: {} } })] });
    expect(ruleOf(parseHaxeDualBindingPlanArtifact(incompleteJs))).toBe('haxe-dual-binding-plan-shape-invalid');

    const badKind = artifact({
      bindings: [binding({ publicHaxe: { ...(binding()['publicHaxe'] as object), kind: 'constant' } })],
    });
    expect(ruleOf(parseHaxeDualBindingPlanArtifact(badKind))).toBe('haxe-dual-binding-plan-shape-invalid');

    const badIdentity = artifact({ bindings: [binding({ identity: { declarationIdentity: 'x' } })] });
    expect(ruleOf(parseHaxeDualBindingPlanArtifact(badIdentity))).toBe('haxe-dual-binding-plan-shape-invalid');
  });

  it('leaves the serialized artifact it was handed untouched', () => {
    const input = artifact();
    const before = structuredClone(input);

    parseHaxeDualBindingPlanArtifact(input);

    expect(input).toEqual(before);
  });
});

describe('sortHaxeDualBindingPlanFailures', () => {
  it('orders failures by subject and then rule without mutating the caller list', () => {
    const failures: HaxeDualBindingPlanParseFailure[] = [
      {
        detail: 'b',
        kind: 'haxe-dual-binding-plan-parse-failure',
        rule: 'haxe-dual-binding-plan-shape-invalid',
        subject: 'bindings[1]',
      },
      {
        detail: 'a',
        kind: 'haxe-dual-binding-plan-parse-failure',
        rule: 'haxe-dual-binding-plan-shape-invalid',
        subject: 'bindings[0]',
      },
      {
        detail: 'c',
        kind: 'haxe-dual-binding-plan-parse-failure',
        rule: 'haxe-dual-binding-plan-key-duplicate',
        subject: 'bindings[0]',
      },
    ];
    const before = [...failures];

    expect(sortHaxeDualBindingPlanFailures(failures).map((failure) => [failure.subject, failure.rule])).toEqual([
      ['bindings[0]', 'haxe-dual-binding-plan-key-duplicate'],
      ['bindings[0]', 'haxe-dual-binding-plan-shape-invalid'],
      ['bindings[1]', 'haxe-dual-binding-plan-shape-invalid'],
    ]);
    expect(failures).toEqual(before);
  });
});
