import type { CompilerRuntimeExternalConstructorAbiPlan } from '../../compiler-types/src/index.js';
import {
  analyzeCompilerRuntimeExternalConstructorAbiCompleteness,
  isCompilerRuntimeExternalConstructorAbiContractMismatchFailure,
} from './compilerRuntimeExternalConstructorAbiCompleteness.js';

describe('analyzeCompilerRuntimeExternalConstructorAbiCompleteness', () => {
  it('accepts normalized fixed and dynamic constructor ABIs deterministically', () => {
    const plan: CompilerRuntimeExternalConstructorAbiPlan = {
      constructors: [
        {
          dynamicArguments: true,
          externalSymbol: { sourceName: 'Ma\u0301p', space: 'value' },
          fixedArgumentCounts: [0, 1],
        },
      ],
      contract: 'flight-runtime-constructor-abi/1',
    };
    const required = [
      { externalSymbol: { sourceName: 'Máp', space: 'value' as const }, providedArgumentCount: 'dynamic' as const },
      { externalSymbol: { sourceName: 'Máp', space: 'value' as const }, providedArgumentCount: 1 },
      { externalSymbol: { sourceName: 'Ma\u0301p', space: 'value' as const }, providedArgumentCount: 1 },
      { externalSymbol: { sourceName: 'Máp', space: 'value' as const }, providedArgumentCount: 0 },
    ];
    const snapshot = structuredClone(plan);
    const expected = {
      contract: 'flight-runtime-constructor-abi/1',
      kind: 'complete',
      requiredExternalConstructors: [
        { externalSymbol: { sourceName: 'Máp', space: 'value' }, providedArgumentCount: 0 },
        { externalSymbol: { sourceName: 'Máp', space: 'value' }, providedArgumentCount: 1 },
        { externalSymbol: { sourceName: 'Máp', space: 'value' }, providedArgumentCount: 'dynamic' },
      ],
      schema: 'flight-runtime-constructor-abi-completeness/1',
    } as const;

    expect(analyzeCompilerRuntimeExternalConstructorAbiCompleteness(required, plan)).toEqual(expected);
    expect(analyzeCompilerRuntimeExternalConstructorAbiCompleteness([...required].reverse(), plan)).toEqual(expected);
    expect(plan).toEqual(snapshot);
  });

  it('reports every missing, duplicate, and invalid constructor ABI', () => {
    const result = analyzeCompilerRuntimeExternalConstructorAbiCompleteness(
      [
        { externalSymbol: { sourceName: 'Array', space: 'value' }, providedArgumentCount: 1 },
        { externalSymbol: { sourceName: 'Map', space: 'value' }, providedArgumentCount: 0 },
        { externalSymbol: { sourceName: 'Set', space: 'value' }, providedArgumentCount: 'dynamic' },
      ],
      {
        constructors: [
          {
            dynamicArguments: false,
            externalSymbol: { sourceName: 'Array', space: 'value' },
            fixedArgumentCounts: [0],
          },
          {
            dynamicArguments: false,
            externalSymbol: { sourceName: 'Map', space: 'value' },
            fixedArgumentCounts: [0],
          },
          {
            dynamicArguments: false,
            externalSymbol: { sourceName: 'Map', space: 'value' },
            fixedArgumentCounts: [0],
          },
          {
            dynamicArguments: false,
            externalSymbol: { sourceName: 'Set', space: 'value' },
            fixedArgumentCounts: [1, 1],
          },
        ],
        contract: 'flight-runtime-constructor-abi/1',
      },
    );

    expect(result).toEqual({
      contract: 'flight-runtime-constructor-abi/1',
      duplicateExternalConstructors: [{ sourceName: 'Map', space: 'value' }],
      invalidExternalConstructors: [{ sourceName: 'Set', space: 'value' }],
      kind: 'incomplete',
      missingExternalConstructors: [
        { externalSymbol: { sourceName: 'Array', space: 'value' }, providedArgumentCount: 1 },
        { externalSymbol: { sourceName: 'Map', space: 'value' }, providedArgumentCount: 0 },
        { externalSymbol: { sourceName: 'Set', space: 'value' }, providedArgumentCount: 'dynamic' },
      ],
      requiredExternalConstructors: [
        { externalSymbol: { sourceName: 'Array', space: 'value' }, providedArgumentCount: 1 },
        { externalSymbol: { sourceName: 'Map', space: 'value' }, providedArgumentCount: 0 },
        { externalSymbol: { sourceName: 'Set', space: 'value' }, providedArgumentCount: 'dynamic' },
      ],
      schema: 'flight-runtime-constructor-abi-completeness/1',
    });
  });

  it('treats empty names, negative counts, unsafe counts, and unordered counts as invalid', () => {
    const constructors = [
      { sourceName: '', fixedArgumentCounts: [0] },
      { sourceName: 'Negative', fixedArgumentCounts: [-1] },
      { sourceName: 'Unsafe', fixedArgumentCounts: [Number.MAX_SAFE_INTEGER + 1] },
      { sourceName: 'Unordered', fixedArgumentCounts: [1, 0] },
    ].map(({ fixedArgumentCounts, sourceName }) => ({
      dynamicArguments: false,
      externalSymbol: { sourceName, space: 'value' as const },
      fixedArgumentCounts,
    }));

    expect(
      analyzeCompilerRuntimeExternalConstructorAbiCompleteness([], {
        constructors,
        contract: 'flight-runtime-constructor-abi/1',
      }),
    ).toMatchObject({
      invalidExternalConstructors: [
        { sourceName: '', space: 'value' },
        { sourceName: 'Negative', space: 'value' },
        { sourceName: 'Unordered', space: 'value' },
        { sourceName: 'Unsafe', space: 'value' },
      ],
      kind: 'incomplete',
    });
  });

  it('refuses a plan for another constructor ABI contract version', () => {
    const plan = {
      constructors: [],
      contract: 'flight-runtime-constructor-abi/2',
    } as unknown as CompilerRuntimeExternalConstructorAbiPlan;

    expect(() => analyzeCompilerRuntimeExternalConstructorAbiCompleteness([], plan)).toThrow(
      'Runtime external constructor ABI plan uses flight-runtime-constructor-abi/2; expected flight-runtime-constructor-abi/1',
    );
    try {
      analyzeCompilerRuntimeExternalConstructorAbiCompleteness([], plan);
      expect.unreachable('Expected constructor ABI contract mismatch');
    } catch (error) {
      expect(isCompilerRuntimeExternalConstructorAbiContractMismatchFailure(error)).toBe(true);
      expect(error).toMatchObject({
        expected: 'flight-runtime-constructor-abi/1',
        kind: 'runtime-external-constructor-abi-contract-mismatch',
        received: 'flight-runtime-constructor-abi/2',
      });
    }
  });
});

describe('isCompilerRuntimeExternalConstructorAbiContractMismatchFailure', () => {
  it('rejects plain, partial, and incorrectly versioned lookalikes', () => {
    const valid = Object.assign(new Error('mismatch'), {
      expected: 'flight-runtime-constructor-abi/1',
      kind: 'runtime-external-constructor-abi-contract-mismatch',
      received: 'flight-runtime-constructor-abi/2',
    });

    expect(isCompilerRuntimeExternalConstructorAbiContractMismatchFailure(valid)).toBe(true);
    expect(isCompilerRuntimeExternalConstructorAbiContractMismatchFailure({ ...valid })).toBe(false);
    expect(isCompilerRuntimeExternalConstructorAbiContractMismatchFailure(new Error('mismatch'))).toBe(false);
    expect(
      isCompilerRuntimeExternalConstructorAbiContractMismatchFailure(
        Object.assign(new Error('mismatch'), { ...valid, expected: 'flight-runtime-constructor-abi/2' }),
      ),
    ).toBe(false);
  });
});
