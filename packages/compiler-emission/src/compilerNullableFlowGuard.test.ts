import { describe, expect, it } from 'vitest';

import type { CompilerSourceOrigin, IrModule, IrType } from '../../compiler-types/src/index.js';
import { collectIrModuleNullableBindingIds, hasIrTypeAbsentMember } from './compilerNullableFlowGuard.js';

describe('hasIrTypeAbsentMember', () => {
  it('finds an absent member wherever a union puts one, and nowhere else', () => {
    const number: IrType = { kind: 'primitive', name: 'number' };
    const nullable: IrType = { kind: 'union', types: [number, { kind: 'null' }] };
    const optional: IrType = { kind: 'union', types: [number, { kind: 'undefined' }] };
    const nested: IrType = { kind: 'union', types: [number, nullable] };

    expect(hasIrTypeAbsentMember({ kind: 'null' })).toBe(true);
    expect(hasIrTypeAbsentMember({ kind: 'undefined' })).toBe(true);
    expect(hasIrTypeAbsentMember(nullable)).toBe(true);
    expect(hasIrTypeAbsentMember(optional)).toBe(true);
    expect(hasIrTypeAbsentMember(nested)).toBe(true);
    expect(hasIrTypeAbsentMember(number)).toBe(false);
    expect(hasIrTypeAbsentMember({ element: number, kind: 'array', readonly: false })).toBe(false);
    expect(hasIrTypeAbsentMember(undefined)).toBe(false);
  });
});

describe('collectIrModuleNullableBindingIds', () => {
  it('collects parameters that admit an absent value, and no others', () => {
    const number: IrType = { kind: 'primitive', name: 'number' };
    const optional: IrType = { kind: 'union', types: [number, { kind: 'undefined' }] };
    const origin: CompilerSourceOrigin = {
      column: 1,
      fingerprint: `sha256:${'0'.repeat(64)}`,
      line: 1,
      packageName: '@flighthq/math',
      source: 'nullable.ts',
    };
    const parameter = (id: string, type: IrType) => ({
      binding: {
        ...origin,
        id,
        kind: 'parameter' as const,
        name: id,
        scope: 'function' as const,
        space: 'value' as const,
      },
      optional: false,
      rest: false,
      type,
    });
    const module: IrModule = {
      declarations: [
        {
          async: false,
          binding: { ...origin, id: 'read', kind: 'function', name: 'read', scope: 'module', space: 'value' } as const,
          body: [],
          exported: true,
          kind: 'function',
          origin,
          overloads: [],
          parameters: [parameter('optionalParameter', optional), parameter('plainParameter', number)],
          returns: number,
          typeParameters: [],
        },
      ],
      exports: [],
      imports: [],
      name: 'Nullable',
      packageName: '@flighthq/math',
      source: 'nullable.ts',
    };

    expect([...collectIrModuleNullableBindingIds(module)]).toEqual(['optionalParameter']);
  });

  it('collects optional parameters whose type has no absent member', () => {
    const number: IrType = { kind: 'primitive', name: 'number' };
    const origin: CompilerSourceOrigin = {
      column: 1,
      fingerprint: `sha256:${'0'.repeat(64)}`,
      line: 1,
      packageName: '@flighthq/math',
      source: 'optional.ts',
    };
    const module: IrModule = {
      declarations: [
        {
          async: false,
          binding: { ...origin, id: 'add', kind: 'function', name: 'add', scope: 'module', space: 'value' } as const,
          body: [],
          exported: true,
          kind: 'function',
          origin,
          overloads: [],
          parameters: [
            {
              binding: { ...origin, id: 'a', kind: 'parameter', name: 'a', scope: 'function', space: 'value' } as const,
              optional: false,
              rest: false,
              type: number,
            },
            {
              binding: { ...origin, id: 'b', kind: 'parameter', name: 'b', scope: 'function', space: 'value' } as const,
              optional: true,
              rest: false,
              type: number,
            },
          ],
          returns: number,
          typeParameters: [],
        },
      ],
      exports: [],
      imports: [],
      name: 'Optional',
      packageName: '@flighthq/math',
      source: 'optional.ts',
    };

    const ids = [...collectIrModuleNullableBindingIds(module)];
    expect(ids).toContain('b');
    expect(ids).not.toContain('a');
  });

  it('collects named variables whose type admits an absent value', () => {
    const number: IrType = { kind: 'primitive', name: 'number' };
    const optional: IrType = { kind: 'union', types: [number, { kind: 'undefined' }] };
    const origin: CompilerSourceOrigin = {
      column: 1,
      fingerprint: `sha256:${'0'.repeat(64)}`,
      line: 1,
      packageName: '@flighthq/math',
      source: 'variable.ts',
    };
    const module: IrModule = {
      declarations: [
        {
          async: false,
          binding: { ...origin, id: 'read', kind: 'function', name: 'read', scope: 'module', space: 'value' } as const,
          body: [
            {
              declarations: [
                {
                  binding: {
                    ...origin,
                    id: 'nullable',
                    kind: 'variable',
                    name: 'nullable',
                    scope: 'block',
                    space: 'value',
                  } as const,
                  mutable: false,
                  type: optional,
                },
                {
                  binding: {
                    ...origin,
                    id: 'plain',
                    kind: 'variable',
                    name: 'plain',
                    scope: 'block',
                    space: 'value',
                  } as const,
                  mutable: false,
                  type: number,
                },
              ],
              kind: 'variable' as const,
            },
          ],
          exported: true,
          kind: 'function',
          origin,
          overloads: [],
          parameters: [],
          returns: number,
          typeParameters: [],
        },
      ],
      exports: [],
      imports: [],
      name: 'Variable',
      packageName: '@flighthq/math',
      source: 'variable.ts',
    };

    const ids = [...collectIrModuleNullableBindingIds(module)];
    expect(ids).toContain('nullable');
    expect(ids).not.toContain('plain');
  });

  it('excludes optional parameters that have a default initializer', () => {
    const number: IrType = { kind: 'primitive', name: 'number' };
    const origin: CompilerSourceOrigin = {
      column: 1,
      fingerprint: `sha256:${'0'.repeat(64)}`,
      line: 1,
      packageName: '@flighthq/math',
      source: 'defaulted.ts',
    };
    const module: IrModule = {
      declarations: [
        {
          async: false,
          binding: { ...origin, id: 'add', kind: 'function', name: 'add', scope: 'module', space: 'value' } as const,
          body: [],
          exported: true,
          kind: 'function',
          origin,
          overloads: [],
          parameters: [
            {
              binding: {
                ...origin,
                id: 'defaulted',
                kind: 'parameter',
                name: 'defaulted',
                scope: 'function',
                space: 'value',
              } as const,
              initializer: { kind: 'literal', value: 0 },
              optional: true,
              rest: false,
              type: number,
            },
            {
              binding: {
                ...origin,
                id: 'bare',
                kind: 'parameter',
                name: 'bare',
                scope: 'function',
                space: 'value',
              } as const,
              optional: true,
              rest: false,
              type: number,
            },
          ],
          returns: number,
          typeParameters: [],
        },
      ],
      exports: [],
      imports: [],
      name: 'Defaulted',
      packageName: '@flighthq/math',
      source: 'defaulted.ts',
    };

    const ids = [...collectIrModuleNullableBindingIds(module)];
    expect(ids).toContain('bare');
    expect(ids).not.toContain('defaulted');
  });
});
