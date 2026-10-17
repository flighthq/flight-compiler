import { describe, expect, it } from 'vitest';

import { createRustCompilerPublicBindingBackend } from './rustCompilerPublicBindingBackend.js';

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
      schema: 'flight-rust-public-binding-plan/1',
    });
    expect(
      backend.createEmissionSession!({ modules: [], options: {} }).finalizePackageGraph?.({
        facade: emptyFacade,
        moduleFiles: [],
      }),
    ).toEqual({ moduleFileReplacements: [], packageFiles: [] });
  });
});
