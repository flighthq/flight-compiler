import { analyzeIrModuleClosureEvidence } from '../../compiler-closure/src/index.js';
import {
  createCompilerValueCompletionPathSet,
  getIrStatementListCompletionSet,
} from '../../compiler-completion/src/index.js';
import { analyzeIrModuleTraversal } from '../../compiler-ir-traversal/src/index.js';
import type {
  CompilerAsyncStateMachine,
  CompilerAsyncStateMachineAnalysis,
  CompilerAsyncStateMachineFulfillment,
  CompilerAsyncStateMachineRefusal,
  CompilerAsyncStateMachineRefusalCode,
  CompilerAsyncStateMachineRetainedBinding,
  CompilerAsyncStateMachineState,
  CompilerAsyncStateMachineStateIdentity,
  CompilerAsyncStateMachineStep,
  CompilerAsyncTaskScope,
  CompilerAsyncTaskSuspensionSite,
  CompilerCompletionValueSource,
  CompilerIrTraversalPath,
  CompilerValueCompletionPath,
  IrBindingIdentity,
  IrExpression,
  IrModule,
  IrStatement,
} from '../../compiler-types/src/index.js';
import { analyzeIrModuleAsyncTaskInventory } from './compilerAsyncTaskInventory.js';

interface AsyncStateMachineBodyDraft {
  readonly expression?: Readonly<IrExpression> | undefined;
  readonly statements: readonly Readonly<IrStatement>[];
}

interface AsyncStateMachineBuildResult {
  readonly machine?: CompilerAsyncStateMachine | undefined;
  readonly refusal?: CompilerAsyncStateMachineRefusal | undefined;
}

interface AsyncStateMachineBindingAnalysis {
  readonly retainedByScope: ReadonlyMap<string, readonly CompilerAsyncStateMachineRetainedBinding[]>;
}

interface AsyncStateMachineBindingDefinitionDraft {
  readonly binding: Readonly<IrBindingIdentity>;
  readonly ordinal: number;
  readonly ownerPath?: CompilerIrTraversalPath | undefined;
  readonly path: CompilerIrTraversalPath;
}

interface AsyncStateMachineBindingUseDraft {
  readonly bindingId: string;
  readonly ordinal: number;
  readonly ownerPath?: CompilerIrTraversalPath | undefined;
  readonly path: CompilerIrTraversalPath;
}

interface AsyncStateMachineDraft {
  readonly completionPaths: CompilerValueCompletionPath[];
  currentIdentity: CompilerAsyncStateMachineStateIdentity;
  currentSteps: CompilerAsyncStateMachineStep[];
  readonly states: CompilerAsyncStateMachineState[];
  terminal: boolean;
}

export function analyzeIrModuleAsyncStateMachines(module: Readonly<IrModule>): CompilerAsyncStateMachineAnalysis {
  const inventory = analyzeIrModuleAsyncTaskInventory(module);
  const closureEvidence = analyzeIrModuleClosureEvidence(module);
  const bodies = getIrModuleAsyncStateMachineBodies(module);
  const bindingAnalysis = analyzeIrModuleAsyncStateMachineBindings(
    module,
    closureEvidence.closures.map((closure) => closure.path),
    inventory.suspensions,
  );
  const results = inventory.scopes.map((scope) =>
    createCompilerAsyncStateMachine(
      scope,
      bodies.get(getCompilerAsyncStateMachinePathIdentity(scope.path)) as AsyncStateMachineBodyDraft,
      inventory.suspensions.filter(
        (suspension) =>
          suspension.scopePath !== undefined && isCompilerAsyncStateMachinePathEqual(suspension.scopePath, scope.path),
      ),
      closureEvidence.closures
        .find((closure) => isCompilerAsyncStateMachinePathEqual(closure.path, scope.path))!
        .captures.filter((capture) => capture.lifetimeBoundaries.includes('suspension')),
      bindingAnalysis.retainedByScope.get(getCompilerAsyncStateMachinePathIdentity(scope.path)) ?? [],
    ),
  );
  return cloneCompilerAsyncStateMachineValue({
    machines: results.flatMap((result) => (result.machine ? [result.machine] : [])),
    module: inventory.module,
    refusals: results.flatMap((result) => (result.refusal ? [result.refusal] : [])),
    schema: 'flight-compiler-async-state-machine-analysis/1' as const,
  });
}

function addCompilerAsyncStateMachineAbruptCompletion(
  path: CompilerIrTraversalPath,
  draft: AsyncStateMachineDraft,
): CompilerCompletionValueSource {
  const value = createCompilerAsyncStateMachineExpressionValue(path, 'abrupt');
  draft.completionPaths.push({ kind: 'throw', path, value });
  return value;
}

function addCompilerAsyncStateMachineExecuteStep(
  statement: Readonly<IrStatement>,
  path: CompilerIrTraversalPath,
  draft: AsyncStateMachineDraft,
): void {
  const abruptValues = getIrStatementAsyncStateMachineAbruptPaths(statement, path).map((abruptPath) =>
    addCompilerAsyncStateMachineAbruptCompletion(abruptPath, draft),
  );
  draft.currentSteps.push({ abruptValues, kind: 'execute', path });
}

function addCompilerAsyncStateMachineState(draft: AsyncStateMachineDraft): void {
  draft.states.push({ identity: draft.currentIdentity, steps: draft.currentSteps });
}

function addCompilerAsyncStateMachineSuspension(
  awaitPath: CompilerIrTraversalPath,
  fulfillment: CompilerAsyncStateMachineFulfillment,
  terminal: boolean,
  draft: AsyncStateMachineDraft,
): void {
  const rejection = addCompilerAsyncStateMachineAbruptCompletion(awaitPath, draft);
  addCompilerAsyncStateMachineAbruptCompletion([...awaitPath, 'expression'], draft);
  const resumeState: CompilerAsyncStateMachineStateIdentity = { kind: 'resume', suspensionPath: awaitPath };
  draft.currentSteps.push({
    fulfillment,
    kind: 'suspend',
    operandPath: [...awaitPath, 'expression'],
    path: awaitPath,
    rejection,
    ...(terminal ? {} : { resumeState }),
  });
  if (terminal) {
    draft.terminal = true;
  } else {
    addCompilerAsyncStateMachineState(draft);
    draft.currentIdentity = resumeState;
    draft.currentSteps = [];
  }
}

function cloneCompilerAsyncStateMachineValue<Value>(value: Value): Value {
  const clone = structuredClone(value);
  freezeCompilerAsyncStateMachineValue(clone, new WeakSet());
  return clone;
}

function analyzeIrModuleAsyncStateMachineBindings(
  module: Readonly<IrModule>,
  closurePaths: readonly CompilerIrTraversalPath[],
  suspensionSites: readonly Readonly<CompilerAsyncTaskSuspensionSite>[],
): AsyncStateMachineBindingAnalysis {
  const definitions = new Map<string, AsyncStateMachineBindingDefinitionDraft>();
  const suspensionOrdinals = new Map<string, number>();
  const uses: AsyncStateMachineBindingUseDraft[] = [];
  let ordinal = 0;
  analyzeIrModuleTraversal(module, {
    bindingPattern(pattern, path) {
      ordinal += 1;
      if (pattern.kind === 'binding' && !definitions.has(pattern.binding.id)) {
        definitions.set(pattern.binding.id, {
          binding: pattern.binding,
          ordinal,
          ownerPath: getCompilerAsyncStateMachineBoundaryPath(path, closurePaths),
          path,
        });
      }
    },
    expression(expression, path) {
      ordinal += 1;
      if (expression.kind === 'await') {
        suspensionOrdinals.set(getCompilerAsyncStateMachinePathIdentity(path), ordinal);
      }
      if (expression.kind === 'identifier' && expression.reference.kind === 'binding') {
        uses.push({
          bindingId: expression.reference.binding.id,
          ordinal,
          ownerPath: getCompilerAsyncStateMachineBoundaryPath(path, closurePaths),
          path,
        });
      }
    },
    parameter(parameter, path) {
      ordinal += 1;
      if (!definitions.has(parameter.binding.id)) {
        definitions.set(parameter.binding.id, {
          binding: parameter.binding,
          ordinal,
          ownerPath: getCompilerAsyncStateMachineBoundaryPath(path, closurePaths),
          path,
        });
      }
    },
    statement(statement, path) {
      ordinal += 1;
      if (statement.kind === 'forOf' && statement.await) {
        suspensionOrdinals.set(getCompilerAsyncStateMachinePathIdentity(path), ordinal);
      }
    },
    variable(variable, path) {
      ordinal += 1;
      if ('binding' in variable && !definitions.has(variable.binding.id)) {
        definitions.set(variable.binding.id, {
          binding: variable.binding,
          ordinal,
          ownerPath: getCompilerAsyncStateMachineBoundaryPath(path, closurePaths),
          path,
        });
      }
    },
  });
  const retainedByScope = new Map<string, CompilerAsyncStateMachineRetainedBinding[]>();
  for (const definition of definitions.values()) {
    const ownerPath = definition.ownerPath;
    if (!ownerPath || definition.binding.kind === 'function') continue;
    const crossings = suspensionSites.filter((suspension) => {
      if (
        !suspension.scopePath ||
        !isCompilerAsyncStateMachinePathEqual(suspension.scopePath, ownerPath) ||
        isCompilerAsyncStateMachinePathWithin(suspension.path, [...definition.path, 'initializer'])
      ) {
        return false;
      }
      const suspensionOrdinal = suspensionOrdinals.get(getCompilerAsyncStateMachinePathIdentity(suspension.path));
      return (
        suspensionOrdinal !== undefined &&
        definition.ordinal < suspensionOrdinal &&
        uses.some(
          (use) =>
            use.bindingId === definition.binding.id &&
            use.ordinal > suspensionOrdinal &&
            use.ownerPath !== undefined &&
            isCompilerAsyncStateMachinePathEqual(use.ownerPath, ownerPath) &&
            !isCompilerAsyncStateMachinePathWithin(use.path, suspension.path),
        )
      );
    });
    if (crossings.length > 0) {
      const key = getCompilerAsyncStateMachinePathIdentity(ownerPath);
      const retained = retainedByScope.get(key) ?? [];
      retained.push({
        binding: definition.binding,
        declarationPath: definition.path,
        suspensionPaths: crossings.map((suspension) => suspension.path),
      });
      retainedByScope.set(key, retained);
    }
  }
  return { retainedByScope };
}

function createCompilerAsyncStateMachine(
  scope: Readonly<CompilerAsyncTaskScope>,
  body: Readonly<AsyncStateMachineBodyDraft>,
  suspensions: readonly Readonly<CompilerAsyncTaskSuspensionSite>[],
  retainedCaptures: CompilerAsyncStateMachine['retainedCaptures'],
  retainedBindings: readonly CompilerAsyncStateMachineRetainedBinding[],
): AsyncStateMachineBuildResult {
  const asyncIteration = suspensions.find((suspension) => suspension.kind === 'asyncIteration');
  if (asyncIteration) {
    return {
      refusal: createCompilerAsyncStateMachineRefusal('unsupported-async-iteration', asyncIteration.path, scope.path),
    };
  }
  const draft: AsyncStateMachineDraft = {
    completionPaths: [],
    currentIdentity: { kind: 'entry' },
    currentSteps: [],
    states: [],
    terminal: false,
  };
  const refusal = body.expression
    ? createIrExpressionBodyAsyncStateMachine(scope, body.expression, suspensions, draft)
    : createIrStatementBodyAsyncStateMachine(scope, body.statements, suspensions, draft);
  if (refusal) return { refusal };
  addCompilerAsyncStateMachineState(draft);
  return {
    machine: {
      completionPaths: createCompilerValueCompletionPathSet(draft.completionPaths),
      origin: scope.origin,
      path: scope.path,
      retainedBindings: getCompilerAsyncStateMachineLiveBindings(retainedBindings, draft.states),
      retainedCaptures,
      states: draft.states,
    },
  };
}

function getCompilerAsyncStateMachineLiveBindings(
  retainedBindings: readonly CompilerAsyncStateMachineRetainedBinding[],
  states: readonly CompilerAsyncStateMachineState[],
): readonly CompilerAsyncStateMachineRetainedBinding[] {
  const overwrites = states
    .flatMap((state) => state.steps)
    .flatMap((step) =>
      step.kind === 'suspend' && (step.fulfillment.kind === 'initializeBinding' || step.fulfillment.kind === 'rebind')
        ? [{ bindingId: step.fulfillment.binding.id, path: step.path }]
        : [],
    );
  return retainedBindings.flatMap((retained) => {
    const suspensionPaths = retained.suspensionPaths.filter(
      (path) =>
        !overwrites.some(
          (overwrite) =>
            overwrite.bindingId === retained.binding.id && isCompilerAsyncStateMachinePathEqual(overwrite.path, path),
        ),
    );
    return suspensionPaths.length > 0 ? [{ ...retained, suspensionPaths }] : [];
  });
}

function createCompilerAsyncStateMachineExpressionValue(
  path: CompilerIrTraversalPath,
  phase: Extract<CompilerCompletionValueSource, { kind: 'expression' }>['phase'],
): CompilerCompletionValueSource {
  return { kind: 'expression', path, phase };
}

function createCompilerAsyncStateMachineRefusal(
  code: CompilerAsyncStateMachineRefusalCode,
  path: CompilerIrTraversalPath,
  scopePath: CompilerIrTraversalPath,
): CompilerAsyncStateMachineRefusal {
  return { code, path, scopePath };
}

function createIrExpressionBodyAsyncStateMachine(
  scope: Readonly<CompilerAsyncTaskScope>,
  expression: Readonly<IrExpression>,
  suspensions: readonly Readonly<CompilerAsyncTaskSuspensionSite>[],
  draft: AsyncStateMachineDraft,
): CompilerAsyncStateMachineRefusal | undefined {
  const path = [...scope.path, 'expression'];
  if (suspensions.length === 0) {
    const value = createCompilerAsyncStateMachineExpressionValue(path, 'result');
    draft.currentSteps.push({
      evaluationRejection: addCompilerAsyncStateMachineAbruptCompletion(path, draft),
      kind: 'resolve',
      path,
      value,
    });
    draft.completionPaths.push({ kind: 'return', path, value });
    draft.terminal = true;
    return undefined;
  }
  if (suspensions.length !== 1 || expression.kind !== 'await') {
    return createCompilerAsyncStateMachineRefusal('unsupported-suspension-expression', path, scope.path);
  }
  const value = createCompilerAsyncStateMachineExpressionValue(path, 'result');
  addCompilerAsyncStateMachineSuspension(path, { kind: 'resolve', value }, true, draft);
  draft.completionPaths.push({ kind: 'return', path, value });
  return undefined;
}

function createIrStatementBodyAsyncStateMachine(
  scope: Readonly<CompilerAsyncTaskScope>,
  statements: readonly Readonly<IrStatement>[],
  suspensions: readonly Readonly<CompilerAsyncTaskSuspensionSite>[],
  draft: AsyncStateMachineDraft,
): CompilerAsyncStateMachineRefusal | undefined {
  const refusal = createIrStatementListAsyncStateMachine(
    scope,
    statements,
    [...scope.path, 'body'],
    suspensions,
    draft,
  );
  if (refusal) return refusal;
  completeIrStatementBodyAsyncStateMachine(scope, draft);
  return undefined;
}

function createIrStatementListAsyncStateMachine(
  scope: Readonly<CompilerAsyncTaskScope>,
  statements: readonly Readonly<IrStatement>[],
  basePath: CompilerIrTraversalPath,
  suspensions: readonly Readonly<CompilerAsyncTaskSuspensionSite>[],
  draft: AsyncStateMachineDraft,
): CompilerAsyncStateMachineRefusal | undefined {
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index]!;
    const path = [...basePath, index];
    if (draft.terminal) {
      return createCompilerAsyncStateMachineRefusal('unreachable-statement', path, scope.path);
    }
    const statementSuspensions = suspensions.filter((suspension) =>
      isCompilerAsyncStateMachinePathWithin(suspension.path, path),
    );
    if (statementSuspensions.length > 0) {
      const refusal = createIrStatementSuspensionAsyncStateMachine(scope, statement, path, statementSuspensions, draft);
      if (refusal) return refusal;
      continue;
    }
    switch (statement.kind) {
      case 'expression':
      case 'variable':
        addCompilerAsyncStateMachineExecuteStep(statement, path, draft);
        break;
      case 'return': {
        const value = statement.expression
          ? createCompilerAsyncStateMachineExpressionValue([...path, 'expression'], 'result')
          : ({ kind: 'implicitUndefined' } as const);
        draft.currentSteps.push({
          ...(statement.expression
            ? { evaluationRejection: addCompilerAsyncStateMachineAbruptCompletion([...path, 'expression'], draft) }
            : {}),
          kind: 'resolve',
          path,
          value,
        });
        draft.completionPaths.push({ kind: 'return', path, value });
        draft.terminal = true;
        break;
      }
      case 'throw': {
        const value = createCompilerAsyncStateMachineExpressionValue([...path, 'expression'], 'result');
        draft.currentSteps.push({
          evaluationRejection: addCompilerAsyncStateMachineAbruptCompletion([...path, 'expression'], draft),
          kind: 'reject',
          path,
          value,
        });
        draft.completionPaths.push({ kind: 'throw', path, value });
        draft.terminal = true;
        break;
      }
      case 'break':
      case 'continue':
        return createCompilerAsyncStateMachineRefusal('escaping-control-flow', path, scope.path);
      case 'block':
      case 'do':
      case 'for':
      case 'forIn':
      case 'forOf':
      case 'if':
      case 'switch':
      case 'try':
      case 'while':
        if (!isIrStatementAsyncStateMachineOpaque(statement)) {
          return createCompilerAsyncStateMachineRefusal('unsupported-control-flow', path, scope.path);
        }
        addCompilerAsyncStateMachineExecuteStep(statement, path, draft);
        break;
    }
  }
  return undefined;
}

function completeIrStatementBodyAsyncStateMachine(
  scope: Readonly<CompilerAsyncTaskScope>,
  draft: AsyncStateMachineDraft,
): void {
  if (!draft.terminal) {
    const path = [...scope.path, 'body', 'end'];
    const value = { kind: 'implicitUndefined' } as const;
    draft.currentSteps.push({ kind: 'resolve', path, value });
    draft.completionPaths.push({ kind: 'normal', path, value });
    draft.terminal = true;
  }
}

function createIrIfStatementAsyncStateMachine(
  scope: Readonly<CompilerAsyncTaskScope>,
  statement: Readonly<Extract<IrStatement, { kind: 'if' }>>,
  path: CompilerIrTraversalPath,
  suspensions: readonly Readonly<CompilerAsyncTaskSuspensionSite>[],
  draft: AsyncStateMachineDraft,
): CompilerAsyncStateMachineRefusal | undefined {
  const conditionPath = [...path, 'condition'];
  if (suspensions.some((suspension) => isCompilerAsyncStateMachinePathWithin(suspension.path, conditionPath))) {
    // A suspension in the condition has to settle before the branch is even decided, which is a
    // different state shape from a suspension in an arm. Refused until it has one.
    return createCompilerAsyncStateMachineRefusal('unsupported-suspension-expression', conditionPath, scope.path);
  }
  const whenTrue: CompilerAsyncStateMachineStateIdentity = { arm: 'whenTrue', kind: 'branchArm', path };
  const whenFalse: CompilerAsyncStateMachineStateIdentity = { arm: 'whenFalse', kind: 'branchArm', path };
  const join: CompilerAsyncStateMachineStateIdentity = { kind: 'join', path };
  draft.currentSteps.push({
    conditionPath,
    evaluationRejection: addCompilerAsyncStateMachineAbruptCompletion(conditionPath, draft),
    kind: 'branch',
    path,
    whenFalse: statement.otherwise ? whenFalse : join,
    whenTrue,
  });
  addCompilerAsyncStateMachineState(draft);

  draft.currentIdentity = whenTrue;
  draft.currentSteps = [];
  draft.terminal = false;
  const consequent = createIrStatementArmAsyncStateMachine(
    scope,
    statement.consequent,
    [...path, 'consequent'],
    suspensions,
    draft,
  );
  if (consequent) return consequent;
  const trueTerminal = draft.terminal;
  if (!trueTerminal) draft.currentSteps.push({ kind: 'goto', path: [...path, 'consequent'], target: join });
  addCompilerAsyncStateMachineState(draft);

  let falseTerminal = false;
  if (statement.otherwise) {
    draft.currentIdentity = whenFalse;
    draft.currentSteps = [];
    draft.terminal = false;
    const otherwise = createIrStatementArmAsyncStateMachine(
      scope,
      statement.otherwise,
      [...path, 'otherwise'],
      suspensions,
      draft,
    );
    if (otherwise) return otherwise;
    falseTerminal = draft.terminal;
    if (!falseTerminal) draft.currentSteps.push({ kind: 'goto', path: [...path, 'otherwise'], target: join });
    addCompilerAsyncStateMachineState(draft);
  }

  draft.currentIdentity = join;
  draft.currentSteps = [];
  // The statement after the branch is reachable unless every arm left, and an `if` with no `else`
  // always has a route that skips the consequent entirely.
  draft.terminal = Boolean(statement.otherwise) && trueTerminal && falseTerminal;
  return undefined;
}

function createIrStatementArmAsyncStateMachine(
  scope: Readonly<CompilerAsyncTaskScope>,
  statement: Readonly<IrStatement>,
  path: CompilerIrTraversalPath,
  suspensions: readonly Readonly<CompilerAsyncTaskSuspensionSite>[],
  draft: AsyncStateMachineDraft,
): CompilerAsyncStateMachineRefusal | undefined {
  const armSuspensions = suspensions.filter((suspension) =>
    isCompilerAsyncStateMachinePathWithin(suspension.path, path),
  );
  if (statement.kind === 'block' && !statement.label) {
    return createIrStatementListAsyncStateMachine(
      scope,
      statement.statements,
      [...path, 'statements'],
      armSuspensions,
      draft,
    );
  }
  if (armSuspensions.length > 0) {
    return createIrStatementSuspensionAsyncStateMachine(scope, statement, path, armSuspensions, draft);
  }
  if (!isIrStatementAsyncStateMachineOpaque(statement)) {
    return createCompilerAsyncStateMachineRefusal('unsupported-control-flow', path, scope.path);
  }
  addCompilerAsyncStateMachineExecuteStep(statement, path, draft);
  return undefined;
}

function createIrStatementSuspensionAsyncStateMachine(
  scope: Readonly<CompilerAsyncTaskScope>,
  statement: Readonly<IrStatement>,
  path: CompilerIrTraversalPath,
  suspensions: readonly Readonly<CompilerAsyncTaskSuspensionSite>[],
  draft: AsyncStateMachineDraft,
): CompilerAsyncStateMachineRefusal | undefined {
  if (statement.kind === 'block') {
    // A block introduces no control flow of its own, so a suspension inside one needs no new state
    // shape — only the statement list walked at the block's own path. A labelled block is refused,
    // because its label is a `break` target and the machine does not model one yet.
    if (statement.label) {
      return createCompilerAsyncStateMachineRefusal('unsupported-control-flow', path, scope.path);
    }
    return createIrStatementListAsyncStateMachine(
      scope,
      statement.statements,
      [...path, 'statements'],
      suspensions,
      draft,
    );
  }
  if (statement.kind === 'if') {
    return createIrIfStatementAsyncStateMachine(scope, statement, path, suspensions, draft);
  }
  if (suspensions.length !== 1) {
    return createCompilerAsyncStateMachineRefusal('unsupported-suspension-expression', path, scope.path);
  }
  const suspension = suspensions[0]!;
  if (statement.kind === 'return' && statement.expression?.kind === 'await') {
    const awaitPath = [...path, 'expression'];
    const value = createCompilerAsyncStateMachineExpressionValue(awaitPath, 'result');
    addCompilerAsyncStateMachineSuspension(awaitPath, { kind: 'resolve', value }, true, draft);
    draft.completionPaths.push({ kind: 'return', path, value });
    return undefined;
  }
  if (statement.kind === 'expression') {
    if (statement.expression.kind === 'await') {
      const awaitPath = [...path, 'expression'];
      addCompilerAsyncStateMachineSuspension(awaitPath, { kind: 'discard' }, false, draft);
      return undefined;
    }
    if (
      statement.expression.kind === 'assignment' &&
      statement.expression.operator === '=' &&
      statement.expression.left.kind === 'identifier' &&
      statement.expression.left.reference.kind === 'binding' &&
      statement.expression.right.kind === 'await'
    ) {
      const awaitPath = [...path, 'expression', 'right'];
      addCompilerAsyncStateMachineSuspension(
        awaitPath,
        { binding: statement.expression.left.reference.binding, kind: 'rebind' },
        false,
        draft,
      );
      return undefined;
    }
  }
  if (statement.kind === 'variable' && statement.declarations.length === 1) {
    const variable = statement.declarations[0];
    if (!('binding' in variable!) || variable.initializer?.kind !== 'await') {
      return createCompilerAsyncStateMachineRefusal('unsupported-suspension-expression', suspension.path, scope.path);
    }
    const awaitPath = [...path, 'declarations', 0, 'initializer'];
    addCompilerAsyncStateMachineSuspension(
      awaitPath,
      { binding: variable.binding, kind: 'initializeBinding' },
      false,
      draft,
    );
    return undefined;
  }
  return createCompilerAsyncStateMachineRefusal('unsupported-suspension-expression', suspension.path, scope.path);
}

function freezeCompilerAsyncStateMachineValue(value: unknown, seen: WeakSet<object>): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freezeCompilerAsyncStateMachineValue(child, seen);
  Object.freeze(value);
}

function getCompilerAsyncStateMachinePathIdentity(path: CompilerIrTraversalPath): string {
  return JSON.stringify(path);
}

function getCompilerAsyncStateMachineBoundaryPath(
  path: CompilerIrTraversalPath,
  boundaries: readonly CompilerIrTraversalPath[],
): CompilerIrTraversalPath | undefined {
  let nearest: CompilerIrTraversalPath | undefined;
  for (const boundary of boundaries) {
    if (isCompilerAsyncStateMachinePathWithin(path, boundary) && (!nearest || boundary.length > nearest.length)) {
      nearest = boundary;
    }
  }
  return nearest;
}

function getIrModuleAsyncStateMachineBodies(
  module: Readonly<IrModule>,
): ReadonlyMap<string, AsyncStateMachineBodyDraft> {
  const bodies = new Map<string, AsyncStateMachineBodyDraft>();
  analyzeIrModuleTraversal(module, {
    declaration(declaration, path) {
      if (declaration.kind === 'function' && declaration.async) {
        bodies.set(getCompilerAsyncStateMachinePathIdentity(path), { statements: declaration.body });
      }
      if (declaration.kind === 'class') {
        declaration.methods.forEach((method, index) => {
          if (method.async) {
            bodies.set(getCompilerAsyncStateMachinePathIdentity([...path, 'methods', index]), {
              statements: method.body,
            });
          }
        });
      }
    },
    expression(expression, path) {
      if (expression.kind === 'function' && expression.async) {
        bodies.set(getCompilerAsyncStateMachinePathIdentity(path), {
          ...(expression.expression ? { expression: expression.expression } : {}),
          statements: expression.body,
        });
      }
    },
  });
  return bodies;
}

function getIrStatementAsyncStateMachineAbruptPaths(
  statement: Readonly<IrStatement>,
  path: CompilerIrTraversalPath,
): CompilerIrTraversalPath[] {
  if (statement.kind === 'expression') return [[...path, 'expression']];
  if (statement.kind === 'variable') {
    return statement.declarations.flatMap((variable, index) =>
      variable.initializer ? [[...path, 'declarations', index, 'initializer']] : [],
    );
  }
  // A compound statement executed as one step can reject from anywhere inside it. The statement is
  // the finest address available without re-walking it, and re-walking would claim a precision the
  // step does not have: the whole statement either runs to completion or rejects.
  return [path];
}

// A statement that never suspends can run inside one state, but only if control cannot leave it by a
// route the machine has to represent. `return` must become a resolve, and `break` or `continue` name
// a loop target outside the statement, so any of the three refuses. `throw` does not: the execute
// step already registers the statement as an abrupt completion path, so a rejection from anywhere
// inside it settles the task the same way an inline throwing expression does.
function isIrStatementAsyncStateMachineOpaque(statement: Readonly<IrStatement>): boolean {
  return getIrStatementListCompletionSet([statement]).completions.every(
    (completion) => completion.kind === 'normal' || completion.kind === 'throw',
  );
}

function isCompilerAsyncStateMachinePathEqual(left: CompilerIrTraversalPath, right: CompilerIrTraversalPath): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

function isCompilerAsyncStateMachinePathWithin(
  path: CompilerIrTraversalPath,
  ancestor: CompilerIrTraversalPath,
): boolean {
  return ancestor.length <= path.length && ancestor.every((segment, index) => segment === path[index]);
}
