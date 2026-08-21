import type { IrModule } from '../../compiler-types/src/index.js';
import { getIrModuleTraversalPathValue } from './compilerIntermediateRepresentationTraversalPath.js';

describe('getIrModuleTraversalPathValue', () => {
  it('resolves root, property, and array segments without changing the module', () => {
    const module = {
      declarations: [],
      exports: [{ expression: { kind: 'literal', value: 1 }, kind: 'default' }],
      imports: [],
      name: 'Value',
      packageName: '@flighthq/traversal',
      source: 'packages/traversal/src/value.ts',
    } as const satisfies IrModule;
    const before = structuredClone(module);

    expect(getIrModuleTraversalPathValue(module, [])).toBe(module);
    expect(getIrModuleTraversalPathValue(module, ['exports', 0, 'expression'])).toBe(module.exports[0].expression);
    expect(getIrModuleTraversalPathValue(module, ['exports', 0, 'expression', 'value'])).toBe(1);
    expect(module).toEqual(before);
  });

  it('fails loudly when a segment is absent or attempts to descend through a primitive', () => {
    const module = {
      declarations: [],
      exports: [],
      imports: [],
      name: 'Value',
      packageName: '@flighthq/traversal',
      source: 'packages/traversal/src/value.ts',
    } satisfies IrModule;

    expect(() => getIrModuleTraversalPathValue(module, ['missing'])).toThrow(
      'IR traversal path does not resolve at ["missing"]',
    );
    expect(() => getIrModuleTraversalPathValue(module, ['name', 'length'])).toThrow(
      'IR traversal path does not resolve at ["name","length"]',
    );
  });
});
