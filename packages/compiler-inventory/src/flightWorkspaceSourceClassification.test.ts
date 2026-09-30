import {
  isFlightWorkspaceProductionSource,
  isFlightWorkspaceTestSource,
} from './flightWorkspaceSourceClassification.js';

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

describe('isFlightWorkspaceProductionSource', () => {
  it('excludes only documented colocated test conventions while preserving similar names', () => {
    expect(testSources.some(isFlightWorkspaceProductionSource)).toBe(false);
    expect(productionSources.every(isFlightWorkspaceProductionSource)).toBe(true);
    expect(isFlightWorkspaceProductionSource('packages/render/src/public.d.ts')).toBe(false);
  });
});

describe('isFlightWorkspaceTestSource', () => {
  it('recognizes the documented test conventions without broad substring matching', () => {
    expect(testSources.every(isFlightWorkspaceTestSource)).toBe(true);
    expect(productionSources.some(isFlightWorkspaceTestSource)).toBe(false);
    expect(isFlightWorkspaceTestSource('packages/render/src/public.d.ts')).toBe(false);
  });
});
