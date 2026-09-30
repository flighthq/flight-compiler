import {
  isFlightWorkspaceProductionSource,
  isFlightWorkspaceTestSource,
} from './flightWorkspaceSourceClassification.js';

describe('Flight workspace source classification', () => {
  it('excludes only documented colocated test conventions from production discovery', () => {
    const testSources = [
      'packages/render/src/gl.test.ts',
      'packages/render/src/gl.spec.tsx',
      'packages/render/src/glTestHelper.ts',
      'packages/render/src/glTestHelper.tsx',
    ];
    const productionSources = [
      'packages/render/src/contestHelper.ts',
      'packages/render/src/glTestHelpers.ts',
      'packages/render/src/TestHelperFactory.ts',
      'packages/render/src/value.ts',
      'packages/render/src/view.tsx',
    ];

    expect(testSources.every(isFlightWorkspaceTestSource)).toBe(true);
    expect(testSources.some(isFlightWorkspaceProductionSource)).toBe(false);
    expect(productionSources.some(isFlightWorkspaceTestSource)).toBe(false);
    expect(productionSources.every(isFlightWorkspaceProductionSource)).toBe(true);
    expect(isFlightWorkspaceProductionSource('packages/render/src/public.d.ts')).toBe(false);
    expect(isFlightWorkspaceTestSource('packages/render/src/public.d.ts')).toBe(false);
  });
});
