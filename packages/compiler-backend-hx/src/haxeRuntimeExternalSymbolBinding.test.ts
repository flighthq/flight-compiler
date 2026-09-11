import type { IrInterfaceDeclaration } from '../../compiler-types/src/index.js';
import {
  createCompilerRuntimeExternalSymbolBindingPlanHaxe,
  getCompilerAmbientUtilityHeritageTargetHaxe,
  getCompilerRuntimeExternalMemberTargetHaxe,
  getCompilerRuntimeExternalSymbolTargetHaxe,
} from './haxeRuntimeExternalSymbolBinding.js';

describe('createCompilerRuntimeExternalSymbolBindingPlanHaxe', () => {
  it('elects type and value decisions under the versioned runtime contract', () => {
    const plan = createCompilerRuntimeExternalSymbolBindingPlanHaxe();

    expect(plan.contract).toBe('flight-runtime-contract/2');
    expect(plan.bindings).toHaveLength(99);
    expect(plan.bindings.filter(({ externalSymbol }) => externalSymbol.sourceName === 'Promise')).toEqual([
      {
        capability: 'task',
        externalSymbol: { sourceName: 'Promise', space: 'type' },
        kind: 'runtime',
      },
      {
        capability: 'task',
        externalSymbol: { sourceName: 'Promise', space: 'value' },
        kind: 'runtime',
      },
    ]);
    expect(plan.bindings).toContainEqual({
      externalSymbol: { sourceName: 'Math', space: 'value' },
      kind: 'native',
    });
    expect(plan.bindings).toContainEqual({
      externalSymbol: { sourceName: 'Error', space: 'type' },
      kind: 'native',
    });
    expect(plan.bindings).toContainEqual({
      externalSymbol: { sourceName: 'Error', space: 'value' },
      kind: 'native',
    });
    expect(plan.bindings).toContainEqual({
      externalSymbol: { sourceName: 'Record', space: 'type' },
      kind: 'native',
    });
    expect(plan.bindings).toContainEqual({
      capability: 'map',
      externalSymbol: { sourceName: 'ReadonlyMap', space: 'type' },
      kind: 'runtime',
    });
    expect(plan.bindings).toContainEqual({
      externalSymbol: { sourceName: 'WebGLProgram', space: 'type' },
      kind: 'native',
    });
    expect(plan.bindings).toContainEqual({
      externalSymbol: { sourceName: 'GPUDevice', space: 'type' },
      kind: 'native',
    });
    expect(plan.bindings).not.toContainEqual({
      externalSymbol: { sourceName: 'Math', space: 'type' },
      kind: 'native',
    });
    expect(new Set(plan.bindings.map(({ externalSymbol }) => JSON.stringify(externalSymbol)))).toHaveLength(
      plan.bindings.length,
    );
  });

  it('creates independent plan records', () => {
    const first = createCompilerRuntimeExternalSymbolBindingPlanHaxe();
    const second = createCompilerRuntimeExternalSymbolBindingPlanHaxe();

    (first.bindings as unknown[]).pop();
    expect(second.bindings).toHaveLength(99);
  });
});

describe('getCompilerAmbientUtilityHeritageTargetHaxe', () => {
  it('widens a propertyless WebGL Pick interface to its Haxe host type', () => {
    const declaration = {
      extends: [
        {
          kind: 'named',
          reference: { kind: 'ambient', name: 'Pick' },
          typeArguments: [
            {
              kind: 'named',
              reference: { kind: 'ambient', name: 'WebGL2RenderingContext' },
              typeArguments: [],
            },
            { kind: 'literal', value: 'bindVertexArray' },
          ],
        },
      ],
      properties: [],
    } as unknown as IrInterfaceDeclaration;

    expect(getCompilerAmbientUtilityHeritageTargetHaxe(declaration)).toBe('js.html.webgl.WebGL2RenderingContext');
    expect(getCompilerAmbientUtilityHeritageTargetHaxe({ ...declaration, properties: [{}] } as never)).toBeUndefined();
  });
});

describe('getCompilerRuntimeExternalMemberTargetHaxe', () => {
  it.each([
    ['EPSILON', '2.220446049250313e-16'],
    ['MAX_SAFE_INTEGER', '9.007199254740991e15'],
    ['MIN_SAFE_INTEGER', '-9.007199254740991e15'],
    ['isFinite', 'Math.isFinite'],
    ['isNaN', 'Math.isNaN'],
  ] as const)('maps Number.%s to %s', (member, target) => {
    expect(getCompilerRuntimeExternalMemberTargetHaxe('Number', member)).toBe(target);
  });

  it('uses a finite float-preserving predicate for Number.isInteger', () => {
    expect(getCompilerRuntimeExternalMemberTargetHaxe('Number', 'isInteger')).toContain('Math.ffloor');
  });

  it('has no fallback for unsupported members or non-namespace values', () => {
    expect(getCompilerRuntimeExternalMemberTargetHaxe('Number', 'parseFloat')).toBeUndefined();
    expect(getCompilerRuntimeExternalMemberTargetHaxe('Array', 'isFinite')).toBeUndefined();
  });
});

describe('getCompilerRuntimeExternalSymbolTargetHaxe', () => {
  it.each([
    ['Array', 'type', 'Array'],
    ['Array', 'value', 'Array'],
    ['Boolean', 'type', 'Bool'],
    ['Date', 'type', 'flighthq._internal._Date'],
    ['Date', 'value', 'flighthq._internal._Date'],
    ['Error', 'type', 'haxe.Exception'],
    ['Error', 'value', 'haxe.Exception'],
    ['AbortSignal', 'type', 'js.html.AbortSignal'],
    ['AudioContext', 'type', 'js.html.audio.AudioContext'],
    ['CanvasRenderingContext2D', 'type', 'js.html.CanvasRenderingContext2D'],
    ['GPUDevice', 'type', 'Dynamic'],
    ['GPUTextureFormat', 'type', 'String'],
    ['HTMLCanvasElement', 'type', 'js.html.CanvasElement'],
    ['Float32Array', 'type', 'flighthq._internal._Float32Array'],
    ['Float32Array', 'value', 'flighthq._internal._Float32Array'],
    ['Float64Array', 'type', 'flighthq._internal._Float64Array'],
    ['Float64Array', 'value', 'flighthq._internal._Float64Array'],
    ['Int16Array', 'type', 'flighthq._internal._Int16Array'],
    ['Int16Array', 'value', 'flighthq._internal._Int16Array'],
    ['Int32Array', 'type', 'flighthq._internal._Int32Array'],
    ['Int32Array', 'value', 'flighthq._internal._Int32Array'],
    ['Int8Array', 'type', 'flighthq._internal._Int8Array'],
    ['Int8Array', 'value', 'flighthq._internal._Int8Array'],
    ['Map', 'type', 'flighthq._internal._Map'],
    ['Map', 'value', 'flighthq._internal._Map'],
    ['Math', 'value', 'Math'],
    ['Number', 'value', 'Number'],
    ['Promise', 'type', 'flighthq._internal._Promise'],
    ['Promise', 'value', 'flighthq._internal._Promise'],
    ['Record', 'type', 'haxe.DynamicAccess'],
    ['ReadonlyMap', 'type', 'flighthq._internal._Map'],
    ['Set', 'type', 'flighthq._internal._Set'],
    ['Set', 'value', 'flighthq._internal._Set'],
    ['String', 'type', 'String'],
    ['String', 'value', 'String'],
    ['Symbol', 'value', 'js.lib.Symbol'],
    ['Uint16Array', 'type', 'flighthq._internal._UInt16Array'],
    ['Uint16Array', 'value', 'flighthq._internal._UInt16Array'],
    ['Uint32Array', 'type', 'flighthq._internal._UInt32Array'],
    ['Uint32Array', 'value', 'flighthq._internal._UInt32Array'],
    ['Uint8Array', 'type', 'flighthq._internal._UInt8Array'],
    ['Uint8Array', 'value', 'flighthq._internal._UInt8Array'],
    ['Uint8ClampedArray', 'type', 'flighthq._internal._UInt8ClampedArray'],
    ['Uint8ClampedArray', 'value', 'flighthq._internal._UInt8ClampedArray'],
    ['WeakMap', 'type', 'flighthq._internal._WeakMap'],
    ['WeakMap', 'value', 'flighthq._internal._WeakMap'],
    ['WebGLProgram', 'type', 'js.html.webgl.Program'],
    ['WebGLPowerPreference', 'type', 'js.html.webgl.PowerPreference'],
    ['WritableStream', 'type', 'Dynamic'],
  ] as const)('maps %s in %s space to %s', (sourceName, space, targetName) => {
    expect(getCompilerRuntimeExternalSymbolTargetHaxe(sourceName, space)).toBe(targetName);
  });

  it('supports a configured runtime module and has no crossed-space or unknown fallback', () => {
    expect(getCompilerRuntimeExternalSymbolTargetHaxe('Uint8Array', 'value', 'custom.runtime')).toBe(
      'custom.runtime._UInt8Array',
    );
    expect(getCompilerRuntimeExternalSymbolTargetHaxe('Boolean', 'value')).toBeUndefined();
    expect(getCompilerRuntimeExternalSymbolTargetHaxe('Math', 'type')).toBeUndefined();
    expect(getCompilerRuntimeExternalSymbolTargetHaxe('Unmapped', 'type')).toBeUndefined();
  });
});
