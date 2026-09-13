import ts from 'typescript';

import { analyzeIrModuleTraversal } from '../../compiler-ir-traversal/src/index.js';
import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { IrExpression, IrModule, IrNamedVariable, IrType } from '../../compiler-types/src/index.js';
import { collectIrModuleBindingTypesCpp } from './cppBindingTypeInference.js';

describe('collectIrModuleBindingTypesCpp', () => {
  it.each([
    ['a forward dependency chain', () => createBindingTypeInferenceChain(8, false)],
    ['a reverse dependency chain', () => createBindingTypeInferenceChain(8, true)],
    ['an unseeded inference cycle', createBindingTypeInferenceCycle],
    ['a concretely seeded inference cycle', createSeededBindingTypeInferenceCycle],
    ['conditional branch chronology', createConditionalBindingTypeInferenceModule],
    ['explicit unknown evidence', createUnknownBindingTypeInferenceModule],
  ] as const)('matches full-scan inference for %s', (_name, createModule) => {
    const module = createModule();

    expect([...collectIrModuleBindingTypesCpp(module)]).toEqual([...collectIrModuleBindingTypesCppReference(module)]);
  });
});

function collectIrModuleBindingTypesCppReference(module: Readonly<IrModule>): ReadonlyMap<string, Readonly<IrType>> {
  const result = new Map<string, Readonly<IrType>>();
  const inferred = new Map<string, Readonly<IrExpression>>();
  analyzeIrModuleTraversal(module, {
    parameter(parameter) {
      result.set(parameter.binding.id, parameter.type);
    },
    variable(variable) {
      if (!('binding' in variable)) return;
      if (variable.type) result.set(variable.binding.id, variable.type);
      if (variable.initializer) inferred.set(variable.binding.id, variable.initializer);
    },
  });
  let changed = true;
  while (changed) {
    changed = false;
    for (const [bindingId, initializer] of inferred) {
      const existing = result.get(bindingId);
      if (existing && existing.kind !== 'unknown') continue;
      const type = inferIrExpressionTypeCppReference(initializer, result);
      if (!type || type.kind === 'unknown') continue;
      result.set(bindingId, type);
      changed = true;
    }
  }
  return result;
}

function createBindingTypeInferenceChain(length: number, reverse: boolean): IrModule {
  const variables = Array.from({ length }, (_, index) => {
    const initializer = reverse
      ? index === length - 1
        ? 'seed'
        : `value${String(index + 1)}`
      : index === 0
        ? 'seed'
        : `value${String(index - 1)}`;
    return `const value${String(index)} = ${initializer};`;
  });
  const module = lowerBindingTypeInferenceSource(`
    export function chain(seed: number): number {
      ${variables.join('\n')}
      return value${String(reverse ? 0 : length - 1)};
    }
  `);
  stripCompilerCppBindingTypeInferenceVariableTypes(module);
  return module;
}

function createBindingTypeInferenceCycle(): IrModule {
  const module = lowerBindingTypeInferenceSource(`
    export function cycle(seed: number): number {
      const first = seed;
      const second = first;
      return second;
    }
  `);
  stripCompilerCppBindingTypeInferenceVariableTypes(module);
  setCompilerCppBindingTypeInferenceVariableInitializer(
    module,
    'first',
    createCompilerCppBindingTypeInferenceIdentifier(module, 'second'),
  );
  return module;
}

function createConditionalBindingTypeInferenceModule(): IrModule {
  const module = lowerBindingTypeInferenceSource(`
    export function choose(flag: boolean, seed: number): unknown {
      const falseSeed: string = 'fallback';
      const trueAlias = seed;
      const choice = flag ? trueAlias : falseSeed;
      const trueSeed = seed;
      return choice;
    }
  `);
  stripCompilerCppBindingTypeInferenceVariableTypes(module);
  setCompilerCppBindingTypeInferenceVariableType(module, 'falseSeed', { kind: 'primitive', name: 'string' });
  setCompilerCppBindingTypeInferenceVariableInitializer(
    module,
    'trueAlias',
    createCompilerCppBindingTypeInferenceIdentifier(module, 'trueSeed'),
  );
  return module;
}

function createCompilerCppBindingTypeInferenceIdentifier(module: Readonly<IrModule>, name: string): IrExpression {
  const variable = getCompilerCppBindingTypeInferenceVariable(module, name);
  return { kind: 'identifier', reference: { binding: variable.binding, kind: 'binding', path: [] } };
}

function createSeededBindingTypeInferenceCycle(): IrModule {
  const module = createBindingTypeInferenceCycle();
  setCompilerCppBindingTypeInferenceVariableType(module, 'second', { kind: 'primitive', name: 'number' });
  return module;
}

function createUnknownBindingTypeInferenceModule(): IrModule {
  const module = lowerBindingTypeInferenceSource(`
    export function resolve(seed: number): number {
      const value: unknown = seed;
      return value as number;
    }
  `);
  setCompilerCppBindingTypeInferenceVariableType(module, 'value', { kind: 'unknown', source: 'unknown' });
  return module;
}

function getCompilerCppBindingTypeInferenceVariable(module: Readonly<IrModule>, name: string): IrNamedVariable {
  let result: IrNamedVariable | undefined;
  analyzeIrModuleTraversal(module, {
    variable(variable) {
      if ('binding' in variable && variable.binding.name === name) result = variable;
    },
  });
  if (!result) throw new Error(`Binding type inference fixture has no variable ${name}`);
  return result;
}

function inferIrExpressionTypeCppReference(
  expression: Readonly<IrExpression>,
  bindingTypes: ReadonlyMap<string, Readonly<IrType>>,
): Readonly<IrType> | undefined {
  switch (expression.kind) {
    case 'assignment':
      return expression.left.kind === 'identifier' && expression.left.reference.kind === 'binding'
        ? bindingTypes.get(expression.left.reference.binding.id)
        : undefined;
    case 'call':
      return expression.semantics.resultType.kind === 'unknown' ? undefined : expression.semantics.resultType;
    case 'cast':
      return expression.type;
    case 'conditional':
      return (
        inferIrExpressionTypeCppReference(expression.whenTrue, bindingTypes) ??
        inferIrExpressionTypeCppReference(expression.whenFalse, bindingTypes)
      );
    case 'identifier':
      return expression.reference.kind === 'binding' ? bindingTypes.get(expression.reference.binding.id) : undefined;
    case 'new':
      return expression.callee.kind === 'identifier' && expression.callee.reference.kind === 'binding'
        ? {
            kind: 'named',
            reference: { binding: expression.callee.reference.binding, kind: 'binding', path: [] },
            typeArguments: expression.typeArguments,
          }
        : undefined;
    case 'object':
      return expression.type;
    case 'undefinedValue':
      return expression.type;
    case 'array':
    case 'await':
    case 'binary':
    case 'element':
    case 'function':
    case 'literal':
    case 'objectRest':
    case 'property':
    case 'regexp':
    case 'spread':
    case 'template':
    case 'tuple':
    case 'tupleRest':
    case 'tupleSpread':
    case 'tupleSuffix':
    case 'unary':
    case 'undefinedDefault':
      return undefined;
  }
}

function lowerBindingTypeInferenceSource(source: string): IrModule {
  const sourceFile = ts.createSourceFile(
    '/flight/packages/math/src/inference.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  return structuredClone(
    lowerTypeScriptSource(sourceFile, { packageName: '@flighthq/math', upstreamDirectory: '/flight' }).module,
  );
}

function setCompilerCppBindingTypeInferenceVariableInitializer(
  module: Readonly<IrModule>,
  name: string,
  initializer: Readonly<IrExpression>,
): void {
  (getCompilerCppBindingTypeInferenceVariable(module, name) as { initializer?: Readonly<IrExpression> }).initializer =
    initializer;
}

function setCompilerCppBindingTypeInferenceVariableType(
  module: Readonly<IrModule>,
  name: string,
  type: Readonly<IrType>,
): void {
  (getCompilerCppBindingTypeInferenceVariable(module, name) as { type?: Readonly<IrType> }).type = type;
}

function stripCompilerCppBindingTypeInferenceVariableTypes(module: Readonly<IrModule>): void {
  analyzeIrModuleTraversal(module, {
    variable(variable) {
      if ('binding' in variable) delete (variable as { type?: Readonly<IrType> }).type;
    },
  });
}
