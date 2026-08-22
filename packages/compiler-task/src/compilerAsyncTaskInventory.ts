import { analyzeIrModuleTraversal } from '../../compiler-ir-traversal/src/index.js';
import type {
  CompilerAsyncTaskInventory,
  CompilerAsyncTaskLexicalOrigin,
  CompilerAsyncTaskOperation,
  CompilerAsyncTaskOperationIdentity,
  CompilerAsyncTaskOutput,
  CompilerAsyncTaskScope,
  CompilerAsyncTaskSuspensionSite,
  CompilerIrTraversalPath,
  IrExpression,
  IrModule,
  IrType,
} from '../../compiler-types/src/index.js';

interface AsyncTaskFunctionBoundary {
  readonly async: boolean;
  readonly path: CompilerIrTraversalPath;
}

type IrAsyncTaskOperationExpression = Extract<IrExpression, { kind: 'call' | 'new' }>;

interface AsyncTaskInventoryDraft {
  readonly asyncCallableBindingIds: Set<string>;
  readonly boundaries: AsyncTaskFunctionBoundary[];
  readonly operationExpressions: Array<
    Readonly<{ expression: IrAsyncTaskOperationExpression; path: CompilerIrTraversalPath }>
  >;
  readonly scopes: CompilerAsyncTaskScope[];
  readonly suspensionSites: Array<Readonly<{ kind: 'asyncIteration' | 'await'; path: CompilerIrTraversalPath }>>;
}

export function analyzeIrModuleAsyncTaskInventory(module: Readonly<IrModule>): CompilerAsyncTaskInventory {
  const draft: AsyncTaskInventoryDraft = {
    asyncCallableBindingIds: new Set(),
    boundaries: [],
    operationExpressions: [],
    scopes: [],
    suspensionSites: [],
  };
  analyzeIrModuleTraversal(module, {
    declaration(declaration, path) {
      if (declaration.kind === 'function') {
        if (declaration.async) draft.asyncCallableBindingIds.add(declaration.binding.id);
        addCompilerAsyncTaskFunctionBoundary(
          declaration.async,
          'block',
          { binding: declaration.binding, kind: 'functionDeclaration' },
          declaration.returns,
          path,
          draft,
        );
      }
      if (declaration.kind === 'class') {
        if (declaration.classConstructor) {
          draft.boundaries.push({ async: false, path: [...path, 'classConstructor'] });
        }
        declaration.methods.forEach((method, index) =>
          addCompilerAsyncTaskFunctionBoundary(
            method.async,
            'block',
            {
              classBinding: declaration.binding,
              kind: 'classMethod',
              method: method.name,
              static: method.static,
            },
            method.returns,
            [...path, 'methods', index],
            draft,
          ),
        );
      }
    },
    expression(expression, path) {
      if (expression.kind === 'function') {
        addCompilerAsyncTaskFunctionBoundary(
          expression.async,
          expression.expression ? 'expression' : 'block',
          {
            ...(expression.binding ? { binding: expression.binding } : {}),
            kind: 'functionExpression',
          },
          expression.returns,
          path,
          draft,
        );
      }
      if (expression.kind === 'await') draft.suspensionSites.push({ kind: 'await', path });
      if (expression.kind === 'call' || expression.kind === 'new') {
        draft.operationExpressions.push({ expression, path });
      }
    },
    statement(statement, path) {
      if (statement.kind === 'forOf' && statement.await) {
        draft.suspensionSites.push({ kind: 'asyncIteration', path });
      }
    },
    variable(variable) {
      if ('binding' in variable && variable.initializer?.kind === 'function' && variable.initializer.async) {
        draft.asyncCallableBindingIds.add(variable.binding.id);
      }
    },
  });
  const inventory: CompilerAsyncTaskInventory = {
    module: {
      name: module.name,
      packageName: module.packageName,
      source: module.source,
    },
    operations: draft.operationExpressions.flatMap(({ expression, path }) => {
      const identity = getIrExpressionAsyncTaskOperationIdentity(expression, draft.asyncCallableBindingIds);
      if (!identity) return [];
      const boundary = getCompilerAsyncTaskFunctionBoundary(path, draft.boundaries);
      return [
        {
          ...identity,
          argumentCount: getIrExpressionAsyncTaskOperationArgumentCount(expression),
          optional: isIrExpressionAsyncTaskOperationOptional(expression),
          path,
          ...(boundary?.async ? { scopePath: boundary.path } : {}),
        },
      ];
    }),
    schema: 'flight-compiler-async-task-inventory/1',
    scopes: draft.scopes,
    suspensions: draft.suspensionSites.map((site): CompilerAsyncTaskSuspensionSite => {
      const boundary = getCompilerAsyncTaskFunctionBoundary(site.path, draft.boundaries);
      return {
        kind: site.kind,
        path: site.path,
        ...(boundary?.async ? { scopePath: boundary.path } : {}),
      };
    }),
  };
  return cloneCompilerAsyncTaskInventoryValue(inventory);
}

function addCompilerAsyncTaskFunctionBoundary(
  async: boolean,
  body: CompilerAsyncTaskScope['body'],
  origin: CompilerAsyncTaskLexicalOrigin,
  returns: Readonly<IrType>,
  path: CompilerIrTraversalPath,
  draft: AsyncTaskInventoryDraft,
): void {
  draft.boundaries.push({ async, path });
  if (!async) return;
  draft.scopes.push({
    body,
    origin,
    output: getIrTypeAsyncTaskOutput(returns),
    path,
    taskCreation: 'before-body',
  });
}

function cloneCompilerAsyncTaskInventoryValue<Value>(value: Value): Value {
  const clone = structuredClone(value);
  freezeCompilerAsyncTaskInventoryValue(clone, new WeakSet());
  return clone;
}

function freezeCompilerAsyncTaskInventoryValue(value: unknown, seen: WeakSet<object>): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freezeCompilerAsyncTaskInventoryValue(child, seen);
  Object.freeze(value);
}

function getCompilerAsyncTaskFunctionBoundary(
  path: CompilerIrTraversalPath,
  boundaries: readonly AsyncTaskFunctionBoundary[],
): AsyncTaskFunctionBoundary | undefined {
  let nearest: AsyncTaskFunctionBoundary | undefined;
  for (const boundary of boundaries) {
    if (
      boundary.path.length <= path.length &&
      boundary.path.every((segment, index) => segment === path[index]) &&
      (!nearest || boundary.path.length > nearest.path.length)
    ) {
      nearest = boundary;
    }
  }
  return nearest;
}

function getIrExpressionAsyncTaskOperationArgumentCount(
  expression: Readonly<IrAsyncTaskOperationExpression>,
): number | 'dynamic' {
  return expression.arguments.some((argument) => argument.kind === 'spread') ? 'dynamic' : expression.arguments.length;
}

function getIrExpressionAsyncTaskOperationIdentity(
  expression: Readonly<IrAsyncTaskOperationExpression>,
  asyncBindingIds: ReadonlySet<string>,
): CompilerAsyncTaskOperationIdentity | undefined {
  if (expression.kind === 'new') {
    return isIrExpressionAmbientPromiseIdentifier(expression.callee)
      ? { evidence: 'ambient-promise-constructor', operation: 'construct' }
      : undefined;
  }
  if (expression.callee.kind === 'function' && expression.callee.async) {
    return { evidence: 'inline-async-function', operation: 'invokeAsync' };
  }
  if (
    expression.callee.kind === 'identifier' &&
    expression.callee.reference.kind === 'binding' &&
    asyncBindingIds.has(expression.callee.reference.binding.id)
  ) {
    return { evidence: 'async-binding', operation: 'invokeAsync' };
  }
  if (expression.callee.kind !== 'property') return undefined;
  if (isIrExpressionAmbientPromiseIdentifier(expression.callee.object)) {
    const operation = compilerAsyncTaskStaticOperationNames.get(expression.callee.name);
    if (operation) return { evidence: 'ambient-promise-static', operation };
  }
  const operation = compilerAsyncTaskCompositionOperationNames.get(expression.callee.name);
  return operation ? { evidence: 'property-name-candidate', operation } : undefined;
}

function getIrTypeAsyncTaskOutput(type: Readonly<IrType>): CompilerAsyncTaskOutput {
  if (
    type.kind === 'named' &&
    type.reference.kind === 'ambient' &&
    type.reference.name === 'Promise' &&
    type.typeArguments.length === 1
  ) {
    return {
      kind: 'recovered',
      source: 'ambient-promise-type-argument',
      type: type.typeArguments[0]!,
    };
  }
  return { declaredType: type, kind: 'unresolved' };
}

function isIrExpressionAmbientPromiseIdentifier(expression: Readonly<IrExpression>): boolean {
  return (
    expression.kind === 'identifier' &&
    expression.reference.kind === 'ambient' &&
    expression.reference.name === 'Promise'
  );
}

function isIrExpressionAsyncTaskOperationOptional(expression: Readonly<IrAsyncTaskOperationExpression>): boolean {
  return (
    expression.kind === 'call' &&
    (expression.optional || (expression.callee.kind === 'property' && expression.callee.optional))
  );
}

const compilerAsyncTaskCompositionOperationNames = new Map<
  string,
  Extract<CompilerAsyncTaskOperation['operation'], 'catch' | 'finally' | 'then'>
>([
  ['catch', 'catch'],
  ['finally', 'finally'],
  ['then', 'then'],
]);

const compilerAsyncTaskStaticOperationNames = new Map<
  string,
  Extract<CompilerAsyncTaskOperation['operation'], 'joinAll' | 'ready' | 'reject'>
>([
  ['all', 'joinAll'],
  ['reject', 'reject'],
  ['resolve', 'ready'],
]);
