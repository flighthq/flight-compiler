import { describe, expect, it } from 'vitest';

import { createRustCompilerPublicBindingBackend } from './rustCompilerPublicBindingBackend.js';

describe('createRustCompilerPublicBindingBackend', () => {
  it('attaches the versioned public binding planner without changing the emission backend', () => {
    const backend = createRustCompilerPublicBindingBackend();

    expect(backend.name).toBe('rust');
    expect(
      backend.createPublicBindingPlan?.({
        facade: {
          modules: [],
          schema: 'flight-compiler-module-facade/1',
          semantics: {
            bindingAccess: 'live',
            explicitPrecedence: 'named-over-star',
            starAmbiguity: 'refuse-distinct-resolutions',
            starDefault: 'excluded',
            typeValueLanes: 'independent',
          },
        },
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
  });
});
