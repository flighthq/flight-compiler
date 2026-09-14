import { analyzeIrModuleTraversal } from '../../compiler-ir-traversal/src/index.js';
import type {
  CompilerLoweringPass,
  IrBindingIdentity,
  IrExpression,
  IrModule,
  IrStatement,
  IrType,
} from '../../compiler-types/src/index.js';

// Haxe has no source-level `for await`. Delegate the iterator protocol to the versioned task
// runtime, while representing the serial body as an ordinary async callback so the existing task
// state-machine lowering owns every suspension inside it. The runtime operation must await each
// callback, close the iterator on callback rejection, and preserve iteration order.
export function createCompilerLoweringPassAsyncIterationHaxe(): CompilerLoweringPass {
  return {
    idempotent: true,
    lowerIrModule: (module) => lowerIrValueAsyncIterationHaxe(module) as IrModule,
    name: 'haxe-async-iteration',
    runsAfter: [],
    verifyIrModule(module) {
      let residual = false;
      analyzeIrModuleTraversal(module, {
        statement(statement) {
          if (statement.kind === 'forOf' && statement.await) residual = true;
        },
      });
      return residual
        ? {
            kind: 'invalid',
            reason:
              'async iteration with a binding pattern, label, or loop-local abrupt completion cannot be lowered safely',
          }
        : { kind: 'valid' };
    },
  };
}

function lowerIrValueAsyncIterationHaxe(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(lowerIrValueAsyncIterationHaxe);
  if (!value || typeof value !== 'object') return value;
  const lowered = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, lowerIrValueAsyncIterationHaxe(child)]),
  ) as Record<string, unknown>;
  if (!isIrAwaitForOfStatement(lowered)) return lowered;
  if (!('binding' in lowered.variable) || lowered.label || hasIrAsyncIterationLoopLocalAbruptCompletion(lowered.body)) {
    return lowered;
  }

  const voidType = { kind: 'primitive', name: 'void' } as const satisfies IrType;
  const taskType = {
    kind: 'named',
    reference: { kind: 'ambient', name: 'Promise' },
    typeArguments: [voidType],
  } as const satisfies IrType;
  const callbackBinding = {
    ...lowered.variable.binding,
    kind: 'parameter',
    scope: 'function',
  } as const;
  const callbackBody = replaceIrBindingIdentityAsyncIterationHaxe(
    lowered.body.kind === 'block' ? lowered.body.statements : [lowered.body],
    lowered.variable.binding.id,
    callbackBinding,
  ) as readonly IrStatement[];
  const callback: IrExpression = {
    async: true,
    body: callbackBody,
    kind: 'function',
    parameters: [
      {
        binding: callbackBinding,
        optional: false,
        rest: false,
        type: lowered.variable.type ?? { kind: 'unknown', source: 'any' },
      },
    ],
    returns: taskType,
    thisMode: 'lexical',
    typeParameters: [],
  };
  return {
    expression: {
      expression: {
        arguments: [lowered.iterable, callback],
        callee: {
          kind: 'property',
          name: 'forEachAsync',
          object: { kind: 'identifier', reference: { kind: 'ambient', name: 'AsyncIterable' } },
          optional: false,
        },
        kind: 'call',
        optional: false,
        semantics: {
          resultType: taskType,
          signature: { parameterCount: 2, providedArgumentCount: 2 },
        },
        typeArguments: [],
      },
      kind: 'await',
      semantics: {
        continuation: 'enqueue-after-settlement',
        fulfillment: 'resume-normal-with-value',
        operandEvaluation: 'once-before-suspension',
        rejection: 'resume-throw-with-reason',
        schema: 'flight-compiler-await-semantics/1',
        suspension: 'always-before-continuation',
        taskResolution: 'normalize-value-task-or-thenable',
      },
    },
    kind: 'expression',
  } as const satisfies IrStatement;
}

function replaceIrBindingIdentityAsyncIterationHaxe(
  value: unknown,
  bindingId: string,
  replacement: Readonly<IrBindingIdentity>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((child) => replaceIrBindingIdentityAsyncIterationHaxe(child, bindingId, replacement));
  }
  if (!value || typeof value !== 'object') return value;
  const node = value as Record<string, unknown>;
  if (node.id === bindingId && node.space === 'value') return replacement;
  return Object.fromEntries(
    Object.entries(node).map(([key, child]) => [
      key,
      replaceIrBindingIdentityAsyncIterationHaxe(child, bindingId, replacement),
    ]),
  );
}

function isIrAwaitForOfStatement(value: Record<string, unknown>): value is Extract<IrStatement, { kind: 'forOf' }> {
  return value.kind === 'forOf' && value.await === true;
}

function hasIrAsyncIterationLoopLocalAbruptCompletion(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasIrAsyncIterationLoopLocalAbruptCompletion);
  if (!value || typeof value !== 'object') return false;
  const node = value as Record<string, unknown>;
  if (node.kind === 'function') return false;
  if (node.kind === 'break' || node.kind === 'continue' || node.kind === 'return') return true;
  return Object.values(node).some(hasIrAsyncIterationLoopLocalAbruptCompletion);
}
