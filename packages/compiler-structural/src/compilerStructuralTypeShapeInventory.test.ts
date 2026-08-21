import type { IrModule, IrObjectTypeProperty, IrType } from '../../compiler-types/src/index.js';
import { collectIrModulesStructuralTypeShapes } from './compilerStructuralTypeShapeInventory.js';

const numberType = { kind: 'primitive', name: 'number' } as const satisfies IrType;
const stringType = { kind: 'primitive', name: 'string' } as const satisfies IrType;

describe('collectIrModulesStructuralTypeShapes', () => {
  it('coalesces canonical shapes across modules and inventories nested occurrences', () => {
    const common = [property('label', stringType, true), property('value', numberType)];
    const alpha = createModule('Alpha', { kind: 'object', properties: common });
    const beta = createModule('Beta', {
      kind: 'object',
      properties: [property('nested', { kind: 'object', properties: [...common].reverse() })],
    });
    const modules = [beta, alpha];
    const snapshot = structuredClone(modules);

    const inventory = collectIrModulesStructuralTypeShapes(modules);
    const reversed = collectIrModulesStructuralTypeShapes([...modules].reverse());

    expect(inventory).toEqual(reversed);
    expect(inventory).toMatchObject({
      modules: 2,
      schema: 'flight-compiler-structural-type-shapes/1',
      shapes: [{ occurrences: expect.any(Array) }, { occurrences: expect.any(Array) }],
    });
    expect(inventory.shapes.map((shape) => shape.occurrences.length).sort()).toEqual([2, 4]);
    expect(inventory.shapes.flatMap((shape) => shape.occurrences.map((occurrence) => occurrence.name))).toEqual(
      expect.arrayContaining(['Alpha', 'Beta', 'Beta']),
    );
    expect(modules).toEqual(snapshot);
    expect(Object.isFrozen(inventory)).toBe(true);
    expect(Object.isFrozen(inventory.shapes)).toBe(true);
    expect(inventory.shapes.every((shape) => Object.isFrozen(shape.occurrences))).toBe(true);
  });

  it('returns a versioned empty identity without retaining caller arrays', () => {
    const modules: IrModule[] = [];
    const inventory = collectIrModulesStructuralTypeShapes(modules);

    expect(inventory).toEqual({ modules: 0, schema: 'flight-compiler-structural-type-shapes/1', shapes: [] });
    expect(inventory.shapes).not.toBe(modules);
  });

  it('deduplicates an identical module occurrence without hiding the supplied module count', () => {
    const module = createModule('Value', { kind: 'object', properties: [property('value', numberType)] });
    const inventory = collectIrModulesStructuralTypeShapes([module, module]);

    expect(inventory.modules).toBe(2);
    expect(inventory.shapes).toHaveLength(1);
    expect(inventory.shapes[0]?.occurrences).toHaveLength(2);
  });
});

function createModule(name: string, returns: IrType): IrModule {
  const origin = {
    column: 1,
    fingerprint: `sha256:${'0'.repeat(64)}` as const,
    line: 1,
    packageName: '@flighthq/structural',
    source: 'packages/structural/src/shared.ts',
  };
  return {
    declarations: [
      {
        async: false,
        binding: {
          ...origin,
          id: `binding:${name}`,
          kind: 'function',
          name: 'create',
          scope: 'module',
          space: 'value',
        },
        body: [],
        exported: true,
        kind: 'function',
        origin,
        overloads: [],
        parameters: [
          {
            binding: {
              ...origin,
              id: `binding:${name}:input`,
              kind: 'parameter',
              name: 'input',
              scope: 'function',
              space: 'value',
            },
            optional: false,
            rest: false,
            type: returns,
          },
        ],
        returns,
        typeParameters: [],
      },
    ],
    exports: [],
    imports: [],
    name,
    packageName: '@flighthq/structural',
    source: 'packages/structural/src/shared.ts',
  };
}

function property(name: string, type: IrType, optional = false): IrObjectTypeProperty {
  return { name, optional, readonly: false, type };
}
