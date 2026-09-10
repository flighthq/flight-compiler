import { createIrStatementValueCallSemantics } from '../../compiler-completion/src/index.js';
import { analyzeIrModuleTraversal, getIrModuleTraversalPathValue } from '../../compiler-ir-traversal/src/index.js';
import type {
  CompilerIrTraversalPath,
  CompilerLoweringPass,
  IrCallSemantics,
  IrExpression,
  IrInvocationSignatureSemantics,
  IrModule,
  IrStatement,
} from '../../compiler-types/src/index.js';
import { createCompilerLoweringFailure } from './compilerLoweringPass.js';

const compilerLoweringPassNameExtraArgumentErasure = 'extra-argument-erasure';

export function createCompilerLoweringPassExtraArgumentErasure(): CompilerLoweringPass {
  return {
    idempotent: true,
    lowerIrModule: lowerIrModuleExtraArgumentErasure,
    name: compilerLoweringPassNameExtraArgumentErasure,
    runsAfter: [],
    verifyIrModule(module) {
      return hasIrModuleExtraArgumentErasureResidual(module)
        ? { kind: 'invalid', reason: 'fixed extra call arguments remain after erasure' }
        : { kind: 'valid' };
    },
  };
}

function createIrCallExpressionExtraArgumentErasure(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
): Extract<IrExpression, { kind: 'call' }> {
  const evidence = expression.semantics.extraArguments;
  const signature = expression.semantics.signature;
  if (!evidence || !signature || typeof signature.providedArgumentCount !== 'number') return expression;
  const call: Extract<IrExpression, { kind: 'call' }> = {
    ...expression,
    arguments: evidence.argumentBindings.slice(0, signature.parameterCount).map((binding) => ({
      kind: 'identifier',
      reference: { binding, kind: 'binding' },
    })),
    semantics: createIrCallSemanticsExtraArgumentErasure(expression.semantics, signature),
  };
  return {
    arguments: [],
    callee: {
      async: false,
      body: [
        ...evidence.argumentBindings.map(
          (binding, index): IrStatement => ({
            declarations: [
              {
                binding,
                initializer: expression.arguments[index]!,
                mutable: false,
              },
            ],
            kind: 'variable',
          }),
        ),
        { expression: call, kind: 'return' },
      ],
      kind: 'function',
      parameters: [],
      returns: evidence.resultType,
      thisMode: 'lexical',
      typeParameters: [],
    },
    kind: 'call',
    optional: false,
    semantics: {
      resultType: evidence.resultType,
      statementValue: createIrStatementValueCallSemantics(),
    },
    typeArguments: [],
  };
}

function createIrCallSemanticsExtraArgumentErasure(
  semantics: Readonly<IrCallSemantics>,
  signature: Readonly<IrInvocationSignatureSemantics>,
): IrCallSemantics {
  const retained = { ...semantics };
  delete retained.extraArguments;
  return {
    ...retained,
    ...(semantics.defaultParameters
      ? {
          defaultParameters: {
            ...semantics.defaultParameters,
            omitted: [],
            providedArgumentCount: signature.parameterCount,
          },
        }
      : {}),
    ...(semantics.optionalParameters
      ? {
          optionalParameters: {
            ...semantics.optionalParameters,
            omitted: [],
            providedArgumentCount: signature.parameterCount,
          },
        }
      : {}),
    signature: { ...signature, providedArgumentCount: signature.parameterCount },
  };
}

function hasIrCallExpressionExtraArgumentErasureResidual(
  expression: Readonly<IrExpression>,
): expression is Readonly<Extract<IrExpression, { kind: 'call' }>> {
  if (expression.kind !== 'call') return false;
  const signature = expression.semantics.signature;
  return (
    signature !== undefined &&
    typeof signature.providedArgumentCount === 'number' &&
    signature.providedArgumentCount > signature.parameterCount &&
    signature.restParameter === undefined
  );
}

function hasIrModuleExtraArgumentErasureResidual(module: Readonly<IrModule>): boolean {
  let residual = false;
  analyzeIrModuleTraversal(module, {
    expression(expression) {
      if (!hasIrCallExpressionExtraArgumentErasureResidual(expression)) return;
      residual = true;
      return false;
    },
  });
  return residual;
}

function isCompilerIrTraversalContainer(value: unknown): value is Record<number | string, unknown> {
  return typeof value === 'object' && value !== null;
}

function lowerIrModuleExtraArgumentErasure(module: Readonly<IrModule>): IrModule {
  const lowered = structuredClone(module);
  const paths: CompilerIrTraversalPath[] = [];
  let unsupported = false;
  analyzeIrModuleTraversal(lowered, {
    expression(expression, path) {
      if (!hasIrCallExpressionExtraArgumentErasureResidual(expression)) return;
      if (expression.semantics.extraArguments) paths.push(path);
      else unsupported = true;
    },
  });
  if (unsupported) {
    throw createCompilerLoweringFailure(
      'unsupported-ir',
      compilerLoweringPassNameExtraArgumentErasure,
      module,
      'fixed extra call arguments remain after erasure',
    );
  }
  for (const path of paths.reverse()) {
    const expression = getIrModuleTraversalPathValue(lowered, path);
    if (!isIrCallExpressionExtraArgumentErasureCandidate(expression)) {
      throw createCompilerLoweringFailure(
        'malformed-ir',
        compilerLoweringPassNameExtraArgumentErasure,
        module,
        `extra-argument traversal path does not identify eligible call evidence at ${JSON.stringify(path)}`,
      );
    }
    setCompilerIrTraversalPathValue(lowered, path, createIrCallExpressionExtraArgumentErasure(expression));
  }
  return lowered;
}

function isIrCallExpressionExtraArgumentErasureCandidate(
  value: unknown,
): value is Extract<IrExpression, { kind: 'call' }> {
  return (
    isCompilerIrTraversalContainer(value) &&
    value.kind === 'call' &&
    isCompilerIrTraversalContainer(value.semantics) &&
    value.semantics.extraArguments !== undefined &&
    hasIrCallExpressionExtraArgumentErasureResidual(value as unknown as IrExpression)
  );
}

function setCompilerIrTraversalPathValue(
  root: Readonly<IrModule>,
  path: CompilerIrTraversalPath,
  value: unknown,
): void {
  const segment = path.at(-1);
  if (segment === undefined) throw new TypeError('IR traversal replacement path cannot be the module root');
  const parent = getIrModuleTraversalPathValue(root, path.slice(0, -1));
  if (!isCompilerIrTraversalContainer(parent) || !(segment in parent)) {
    throw new TypeError(`IR traversal replacement path does not resolve at ${JSON.stringify(path)}`);
  }
  parent[segment] = value;
}
