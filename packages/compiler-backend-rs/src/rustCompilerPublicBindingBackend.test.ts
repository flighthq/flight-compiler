import { describe, expect, it } from 'vitest';

import { createCompilerModuleEvaluationPlan } from '../../compiler-module/src/index.js';
import type { CompilerRustModuleEvaluationExecutionPlan } from '../../compiler-types/src/index.js';
import { createRustCompilerPublicBindingBackend } from './rustCompilerPublicBindingBackend.js';
import { isCompilerRustPublicBindingPlanningFailure } from './rustPublicBindingPlan.js';

const emptyModuleEvaluation = createCompilerModuleEvaluationPlan({ dependencies: [], entries: [], modules: [] });

describe('createRustCompilerPublicBindingBackend', () => {
  it('attaches the versioned public binding planner without changing the emission backend', () => {
    const backend = createRustCompilerPublicBindingBackend();
    const emptyFacade = {
      modules: [],
      schema: 'flight-compiler-module-facade/1' as const,
      semantics: {
        bindingAccess: 'live' as const,
        explicitPrecedence: 'named-over-star' as const,
        starAmbiguity: 'refuse-distinct-resolutions' as const,
        starDefault: 'excluded' as const,
        typeValueLanes: 'independent' as const,
      },
    };

    expect(backend.name).toBe('rust');
    expect(
      backend.createPublicBindingPlan?.({
        facade: emptyFacade,
        modules: [],
        options: {},
        refusals: [],
      }),
    ).toEqual({
      bindings: [],
      crates: [],
      dependencies: [],
      modules: [],
      schema: 'flight-rust-public-binding-plan/2',
    });
    expect(
      backend.createEmissionSession!({
        moduleEvaluation: emptyModuleEvaluation,
        modules: [],
        options: {},
      }).finalizePackageGraph?.({ moduleEvaluation: emptyModuleEvaluation, facade: emptyFacade, moduleFiles: [] }),
    ).toEqual({ moduleFileReplacements: [], packageFiles: [] });
  });
});

describe('createRustCompilerPublicBindingBackend v3 forwarding', () => {
  const emptyFacade = {
    modules: [],
    schema: 'flight-compiler-module-facade/1' as const,
    semantics: {
      bindingAccess: 'live' as const,
      explicitPrecedence: 'named-over-star' as const,
      starAmbiguity: 'refuse-distinct-resolutions' as const,
      starDefault: 'excluded' as const,
      typeValueLanes: 'independent' as const,
    },
  };

  function executionPlan(
    overrides: Readonly<{
      errorCrate?: string;
      runtimeAbiSchema?: 'flight-rust-runtime-abi/3';
    }> = {},
  ): CompilerRustModuleEvaluationExecutionPlan {
    const value = {
      availability: { outcome: 'available' },
      entries: [],
      error: {
        crateName: overrides.errorCrate ?? 'flight_runtime',
        result: 'Result<(), FlightModuleEvaluationError>',
        targetName: 'FlightModuleEvaluationError',
      },
      modules: [],
      phases: [
        { invocations: [], kind: 'instantiate' },
        { invocations: [], kind: 'evaluate' },
      ],
      publicBindingSchema: 'flight-rust-public-binding-plan/3',
      representationSchema: 'flight-rust-module-evaluation-representation-plan/1',
      runtimeAbiSchema: overrides.runtimeAbiSchema ?? 'flight-rust-runtime-abi/4',
      schema: 'flight-rust-module-evaluation-execution-plan/1',
      semantics: {
        concurrency: 'serialized-by-bootstrap',
        facadeAccess: 'successful-bootstrap-before-value-access',
        failure: 'cache-first-error-stop-without-retry',
        groupOrder: 'flight-compiler-module-evaluation/1',
        phaseOrder: ['instantiate', 'evaluate'],
        reentrancy: 'reject',
        repeatedInvocation: 'cache-first-result',
        reservedNamespace: '__flight_',
      },
    };
    return value as unknown as CompilerRustModuleEvaluationExecutionPlan;
  }

  it('forwards the finalized execution plan into a v3 plan', () => {
    const backend = createRustCompilerPublicBindingBackend();
    const execution = executionPlan();
    const plan = backend.createPublicBindingPlan?.({
      facade: emptyFacade,
      moduleEvaluationExecution: execution,
      modules: [],
      options: {},
      refusals: [],
    });

    expect(plan).toMatchObject({
      bindings: [],
      crates: [],
      dependencies: [],
      initialization: { availability: 'available', required: 'before-value-access' },
      modules: [],
      schema: 'flight-rust-public-binding-plan/3',
    });
    expect(plan?.schema).toBe('flight-rust-public-binding-plan/3');
    if (plan?.schema !== 'flight-rust-public-binding-plan/3') throw new Error('Expected v3 plan');
    expect(plan.initialization).toEqual({
      availability: 'available',
      plan: execution,
      required: 'before-value-access',
    });
  });

  it('cannot silently downgrade when the wired execution plan is stale', () => {
    const backend = createRustCompilerPublicBindingBackend();
    let failure: unknown;
    try {
      backend.createPublicBindingPlan?.({
        facade: emptyFacade,
        moduleEvaluationExecution: executionPlan({ runtimeAbiSchema: 'flight-rust-runtime-abi/3' }),
        modules: [],
        options: {},
        refusals: [],
      });
    } catch (error) {
      failure = error;
    }
    expect(isCompilerRustPublicBindingPlanningFailure(failure)).toBe(true);
    if (!isCompilerRustPublicBindingPlanningFailure(failure)) throw failure;
    expect(failure.code).toBe('rust-public-binding-execution-schema-mismatch');
  });

  it('forwards the selected runtime crate to execution validation', () => {
    const backend = createRustCompilerPublicBindingBackend();
    expect(
      backend.createPublicBindingPlan?.({
        facade: emptyFacade,
        moduleEvaluationExecution: executionPlan({ errorCrate: 'custom_runtime' }),
        modules: [],
        options: { runtimeCrate: 'custom_runtime' },
        refusals: [],
      })?.schema,
    ).toBe('flight-rust-public-binding-plan/3');
    expect(() =>
      backend.createPublicBindingPlan?.({
        facade: emptyFacade,
        moduleEvaluationExecution: executionPlan({ errorCrate: 'flight_runtime' }),
        modules: [],
        options: { runtimeCrate: 'custom_runtime' },
        refusals: [],
      }),
    ).toThrow(expect.objectContaining({ code: 'rust-public-binding-execution-projection-mismatch' }));
  });
});
