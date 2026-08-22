import { indentSourceLines } from '../../compiler-emission/src/index.js';
import { getIrModuleTraversalPathValue } from '../../compiler-ir-traversal/src/index.js';
import type {
  CompilerAsyncStateMachineGuardedState,
  CompilerAsyncStateMachineStateIdentity,
  CompilerCompletionValueSource,
  CompilerHaxeTaskEmissionCapabilities,
  CompilerHaxeTaskLoweringFunction,
  CompilerHaxeTaskLoweringRuntime,
  CompilerHaxeTaskLoweringState,
  CompilerHaxeTaskLoweringStep,
  CompilerIrTraversalPath,
  IrBindingIdentity,
  IrExpression,
  IrModule,
  IrStatement,
} from '../../compiler-types/src/index.js';

interface HaxeTaskEmissionNames {
  readonly reject: string;
  readonly resolve: string;
}

export function emitCompilerHaxeTaskLoweringFunction(
  functionPlan: Readonly<CompilerHaxeTaskLoweringFunction>,
  runtime: Readonly<CompilerHaxeTaskLoweringRuntime>,
  module: Readonly<IrModule>,
  capabilities: Readonly<CompilerHaxeTaskEmissionCapabilities>,
): readonly string[] {
  const entry = functionPlan.states.find((state) => state.identity.kind === 'entry');
  if (!entry) capabilities.fail(`Haxe task function at ${JSON.stringify(functionPlan.path)} has no entry state`);
  const names: HaxeTaskEmissionNames = {
    reject: capabilities.getGeneratedName('rejectTask'),
    resolve: capabilities.getGeneratedName('resolveTask'),
  };
  return [
    `return new ${runtime.taskTypeName}(function(${names.resolve}, ${names.reject}) {`,
    ...indentSourceLines(
      emitCompilerHaxeTaskLoweringState(
        entry,
        functionPlan,
        runtime,
        module,
        capabilities,
        names,
        new Set(),
        new Map(),
      ),
    ),
    '});',
  ];
}

function emitCompilerHaxeTaskCompletionValue(
  value: Readonly<CompilerCompletionValueSource>,
  module: Readonly<IrModule>,
  capabilities: Readonly<CompilerHaxeTaskEmissionCapabilities>,
  awaitValue: Readonly<{ name: string; path: CompilerIrTraversalPath }> | undefined,
): string {
  switch (value.kind) {
    case 'carried':
      // The machine is holding this value in a binding it introduced, which is how a route that owes
      // cleanup carries its result past the cleanup to the settlement.
      return capabilities.getBindingName(value.binding);
    case 'empty':
      return capabilities.fail('Haxe task settlement cannot emit an empty completion value');
    case 'implicitUndefined':
      return 'null';
    case 'expression':
      if (value.phase === 'abrupt') {
        return capabilities.fail(`Haxe task settlement cannot emit abrupt value ${JSON.stringify(value.path)}`);
      }
      if (awaitValue && isCompilerHaxeTaskEmissionPathEqual(value.path, awaitValue.path)) return awaitValue.name;
      return capabilities.emitExpression(
        getCompilerHaxeTaskEmissionSourceValue<IrExpression>(module, value.path, capabilities),
      );
  }
}

function emitCompilerHaxeTaskLoweringState(
  state: Readonly<CompilerHaxeTaskLoweringState>,
  functionPlan: Readonly<CompilerHaxeTaskLoweringFunction>,
  runtime: Readonly<CompilerHaxeTaskLoweringRuntime>,
  module: Readonly<IrModule>,
  capabilities: Readonly<CompilerHaxeTaskEmissionCapabilities>,
  names: Readonly<HaxeTaskEmissionNames>,
  ancestors: ReadonlySet<string>,
  joins: ReadonlyMap<string, string>,
): string[] {
  const identity = getCompilerHaxeTaskEmissionStateIdentity(state);
  if (ancestors.has(identity)) capabilities.fail(`Haxe task state graph contains a cycle at ${identity}`);
  const nextAncestors = new Set([...ancestors, identity]);
  const errorName = capabilities.getGeneratedName('taskError');
  const body = state.steps.flatMap((step) =>
    emitCompilerHaxeTaskLoweringStep(step, functionPlan, runtime, module, capabilities, names, nextAncestors, joins),
  );
  return [
    'try {',
    ...indentSourceLines(body),
    `} catch (${errorName}:Dynamic) {`,
    ...indentSourceLines(
      emitCompilerHaxeTaskEmissionRejectionRoute(
        state.guard,
        errorName,
        functionPlan,
        runtime,
        module,
        capabilities,
        names,
        nextAncestors,
        joins,
      ),
    ),
    '}',
  ];
}

// A rejection settles the task unless a source-level handler is in scope, in which case it enters
// that handler with the caught value bound the way the source binds it.
function emitCompilerHaxeTaskEmissionRejectionRoute(
  guard: Readonly<CompilerAsyncStateMachineGuardedState> | undefined,
  errorName: string,
  functionPlan: Readonly<CompilerHaxeTaskLoweringFunction>,
  runtime: Readonly<CompilerHaxeTaskLoweringRuntime>,
  module: Readonly<IrModule>,
  capabilities: Readonly<CompilerHaxeTaskEmissionCapabilities>,
  names: Readonly<HaxeTaskEmissionNames>,
  ancestors: ReadonlySet<string>,
  joins: ReadonlyMap<string, string>,
): string[] {
  if (!guard) return [`${names.reject}(${errorName});`];
  const key = getCompilerHaxeTaskEmissionIdentityKey(guard.catchState);
  const handler = functionPlan.states.find(
    (candidate) => getCompilerHaxeTaskEmissionIdentityKey(candidate.identity) === key,
  );
  if (!handler) capabilities.fail(`Haxe task guard ${key} has no handler state`);
  return [
    ...(guard.catchBinding ? [`var ${capabilities.getBindingName(guard.catchBinding)} = ${errorName};`] : []),
    ...emitCompilerHaxeTaskLoweringState(handler, functionPlan, runtime, module, capabilities, names, ancestors, joins),
    // A cleanup handler runs and then lets the same rejection continue, which is what separates
    // `finally` from `catch`.
    ...(guard.rethrow ? [`${names.reject}(${errorName});`] : []),
  ];
}

function emitCompilerHaxeTaskLoweringStep(
  step: Readonly<CompilerHaxeTaskLoweringStep>,
  functionPlan: Readonly<CompilerHaxeTaskLoweringFunction>,
  runtime: Readonly<CompilerHaxeTaskLoweringRuntime>,
  module: Readonly<IrModule>,
  capabilities: Readonly<CompilerHaxeTaskEmissionCapabilities>,
  names: Readonly<HaxeTaskEmissionNames>,
  ancestors: ReadonlySet<string>,
  joins: ReadonlyMap<string, string>,
): string[] {
  switch (step.kind) {
    case 'branchState': {
      // Both arms continue at the same join, so the join is emitted once as a local function and
      // called from each arm. Inlining it into both would duplicate the whole continuation, and the
      // duplication compounds with every nested branch.
      const joinIdentity = getCompilerHaxeTaskEmissionIdentityKey({ kind: 'join', path: step.path });
      const joinState = functionPlan.states.find(
        (candidate) => getCompilerHaxeTaskEmissionIdentityKey(candidate.identity) === joinIdentity,
      );
      if (!joinState) capabilities.fail(`Haxe task branch at ${JSON.stringify(step.path)} has no join state`);
      const joinName = capabilities.getGeneratedName('taskJoin');
      const nextJoins = new Map([...joins, [joinIdentity, joinName]]);
      const condition = capabilities.emitExpression(
        getCompilerHaxeTaskEmissionSourceValue<IrExpression>(module, step.conditionPath, capabilities),
      );
      return [
        `var ${joinName} = function() {`,
        ...indentSourceLines(
          emitCompilerHaxeTaskLoweringState(
            joinState,
            functionPlan,
            runtime,
            module,
            capabilities,
            names,
            ancestors,
            joins,
          ),
        ),
        '};',
        `if (${condition}) {`,
        ...indentSourceLines(
          emitCompilerHaxeTaskEmissionBranchArm(
            step.whenTrue,
            functionPlan,
            runtime,
            module,
            capabilities,
            names,
            ancestors,
            nextJoins,
          ),
        ),
        '} else {',
        ...indentSourceLines(
          emitCompilerHaxeTaskEmissionBranchArm(
            step.whenFalse,
            functionPlan,
            runtime,
            module,
            capabilities,
            names,
            ancestors,
            nextJoins,
          ),
        ),
        '}',
        'return;',
      ];
    }
    case 'guardState': {
      // The guarded body and its handler both leave through the same join, so the join is a local
      // function here for the same reason it is one for a branch.
      const joinIdentity = getCompilerHaxeTaskEmissionIdentityKey(step.join);
      const joinState = functionPlan.states.find(
        (candidate) => getCompilerHaxeTaskEmissionIdentityKey(candidate.identity) === joinIdentity,
      );
      if (!joinState) capabilities.fail(`Haxe task guard at ${JSON.stringify(step.path)} has no join state`);
      const bodyIdentity = getCompilerHaxeTaskEmissionIdentityKey(step.body);
      const bodyState = functionPlan.states.find(
        (candidate) => getCompilerHaxeTaskEmissionIdentityKey(candidate.identity) === bodyIdentity,
      );
      if (!bodyState) capabilities.fail(`Haxe task guard at ${JSON.stringify(step.path)} has no body state`);
      const joinName = capabilities.getGeneratedName('taskJoin');
      const nextJoins = new Map<string, string>([...joins, [joinIdentity, joinName]]);
      // A cleanup arm is reached from the body and from the rejection route, so it is named for the
      // same reason the join is: a continuation with two callers is a function, not an inlining.
      const cleanupIdentity = getCompilerHaxeTaskEmissionIdentityKey({
        arm: 'whenFalse',
        kind: 'branchArm',
        path: step.path,
      });
      const cleanupState = functionPlan.states.find(
        (candidate) => getCompilerHaxeTaskEmissionIdentityKey(candidate.identity) === cleanupIdentity,
      );
      const cleanupLines: string[] = [];
      // The carrier is declared where the region opens so the cleanup, which is a sibling closure,
      // can read what a route left in it.
      if (step.carrier) cleanupLines.push(`var ${capabilities.getBindingName(step.carrier)};`);
      if (cleanupState) {
        const cleanupName = capabilities.getGeneratedName('taskCleanup');
        nextJoins.set(cleanupIdentity, cleanupName);
        cleanupLines.push(
          `var ${cleanupName} = function() {`,
          ...indentSourceLines(
            emitCompilerHaxeTaskLoweringState(
              cleanupState,
              functionPlan,
              runtime,
              module,
              capabilities,
              names,
              ancestors,
              nextJoins,
            ),
          ),
          '};',
        );
      }
      return [
        `var ${joinName} = function() {`,
        ...indentSourceLines(
          emitCompilerHaxeTaskLoweringState(
            joinState,
            functionPlan,
            runtime,
            module,
            capabilities,
            names,
            ancestors,
            joins,
          ),
        ),
        '};',
        ...cleanupLines,
        ...emitCompilerHaxeTaskLoweringState(
          bodyState,
          functionPlan,
          runtime,
          module,
          capabilities,
          names,
          ancestors,
          nextJoins,
        ),
        'return;',
      ];
    }
    case 'loopState': {
      const headerIdentity = getCompilerHaxeTaskEmissionIdentityKey(step.header);
      const headerState = functionPlan.states.find(
        (candidate) => getCompilerHaxeTaskEmissionIdentityKey(candidate.identity) === headerIdentity,
      );
      if (!headerState) capabilities.fail(`Haxe task loop at ${JSON.stringify(step.path)} has no header state`);
      const headerName = capabilities.getGeneratedName('taskLoop');
      const nextJoins = new Map([...joins, [headerIdentity, headerName]]);
      return [
        // A named local function, not a `var` holding a closure: the back edge calls it from inside
        // its own body, which a variable initializer cannot see.
        `function ${headerName}() {`,
        ...indentSourceLines(
          emitCompilerHaxeTaskLoweringState(
            headerState,
            functionPlan,
            runtime,
            module,
            capabilities,
            names,
            ancestors,
            nextJoins,
          ),
        ),
        '}',
        `${headerName}();`,
        'return;',
      ];
    }
    case 'carryValue':
      // The route settles after the cleanup, so its value waits in a binding the region declared.
      return [
        `${capabilities.getBindingName(step.binding)} = ${emitCompilerHaxeTaskCompletionValue(step.value, module, capabilities, undefined)};`,
      ];
    case 'continueState': {
      const target = getCompilerHaxeTaskEmissionIdentityKey(step.target);
      const joinName = joins.get(target);
      if (!joinName) capabilities.fail(`Haxe task continuation at ${JSON.stringify(step.path)} has no join in scope`);
      return [`${joinName}();`, 'return;'];
    }
    case 'executeSource':
      return [
        ...capabilities.emitStatement(
          getCompilerHaxeTaskEmissionSourceValue<IrStatement>(module, step.path, capabilities),
        ),
      ];
    case 'rejectTask':
    case 'resolveTask': {
      const value = emitCompilerHaxeTaskCompletionValue(step.value, module, capabilities, undefined);
      return [`${step.kind === 'resolveTask' ? names.resolve : names.reject}(${value});`, 'return;'];
    }
    case 'awaitRuntime': {
      const awaitValueName = capabilities.getGeneratedName('awaitValue');
      const awaitErrorName = capabilities.getGeneratedName('awaitError');
      const fulfillment = emitCompilerHaxeTaskSuspensionFulfillment(
        step,
        functionPlan,
        runtime,
        module,
        capabilities,
        names,
        awaitValueName,
        ancestors,
        joins,
      );
      const operand = capabilities.emitExpression(
        getCompilerHaxeTaskEmissionSourceValue<IrExpression>(module, step.operandPath, capabilities),
      );
      return [
        `${runtime.taskTypeName}.${runtime.normalizeMemberName}(${operand}).${runtime.continueMemberName}(`,
        `  function(${awaitValueName}) {`,
        ...indentSourceLines(fulfillment, 2),
        '  },',
        `  function(${awaitErrorName}) {`,
        ...indentSourceLines(
          emitCompilerHaxeTaskEmissionRejectionRoute(
            step.rejectState
              ? {
                  catchState: step.rejectState,
                  ...getCompilerHaxeTaskEmissionGuardBinding(functionPlan, step.rejectState),
                }
              : undefined,
            awaitErrorName,
            functionPlan,
            runtime,
            module,
            capabilities,
            names,
            ancestors,
            joins,
          ),
          2,
        ),
        '  }',
        ');',
        'return;',
      ];
    }
  }
}

function emitCompilerHaxeTaskEmissionBranchArm(
  identity: Readonly<CompilerAsyncStateMachineStateIdentity>,
  functionPlan: Readonly<CompilerHaxeTaskLoweringFunction>,
  runtime: Readonly<CompilerHaxeTaskLoweringRuntime>,
  module: Readonly<IrModule>,
  capabilities: Readonly<CompilerHaxeTaskEmissionCapabilities>,
  names: Readonly<HaxeTaskEmissionNames>,
  ancestors: ReadonlySet<string>,
  joins: ReadonlyMap<string, string>,
): string[] {
  const key = getCompilerHaxeTaskEmissionIdentityKey(identity);
  const joinName = joins.get(key);
  if (joinName) return [`${joinName}();`, 'return;'];
  const armState = functionPlan.states.find(
    (candidate) => getCompilerHaxeTaskEmissionIdentityKey(candidate.identity) === key,
  );
  if (!armState) capabilities.fail(`Haxe task branch arm ${key} has no matching state`);
  return emitCompilerHaxeTaskLoweringState(
    armState,
    functionPlan,
    runtime,
    module,
    capabilities,
    names,
    ancestors,
    joins,
  );
}

function emitCompilerHaxeTaskSuspensionFulfillment(
  step: Readonly<Extract<CompilerHaxeTaskLoweringStep, { kind: 'awaitRuntime' }>>,
  functionPlan: Readonly<CompilerHaxeTaskLoweringFunction>,
  runtime: Readonly<CompilerHaxeTaskLoweringRuntime>,
  module: Readonly<IrModule>,
  capabilities: Readonly<CompilerHaxeTaskEmissionCapabilities>,
  names: Readonly<HaxeTaskEmissionNames>,
  awaitValueName: string,
  ancestors: ReadonlySet<string>,
  joins: ReadonlyMap<string, string>,
): string[] {
  const lines: string[] = [];
  switch (step.fulfillment.kind) {
    case 'discard':
      break;
    case 'initializeBinding':
      lines.push(`var ${capabilities.getBindingName(step.fulfillment.binding)} = ${awaitValueName};`);
      break;
    case 'rebind':
      lines.push(`${capabilities.getBindingName(step.fulfillment.binding)} = ${awaitValueName};`);
      break;
    case 'resolve':
      lines.push(
        `${names.resolve}(${emitCompilerHaxeTaskCompletionValue(step.fulfillment.value, module, capabilities, {
          name: awaitValueName,
          path: step.path,
        })});`,
        'return;',
      );
      break;
  }
  if (!step.resumeState) {
    if (step.fulfillment.kind !== 'resolve') {
      capabilities.fail(`Haxe task suspension at ${JSON.stringify(step.path)} has no resume state`);
    }
    return lines;
  }
  const resumeState = functionPlan.states.find(
    (state) => getCompilerHaxeTaskEmissionStateIdentity(state) === getCompilerHaxeTaskEmissionStateIdentity(step),
  );
  if (!resumeState) capabilities.fail(`Haxe task suspension at ${JSON.stringify(step.path)} has no matching state`);
  lines.push(
    ...emitCompilerHaxeTaskLoweringState(
      resumeState,
      functionPlan,
      runtime,
      module,
      capabilities,
      names,
      ancestors,
      joins,
    ),
  );
  return lines;
}

function getCompilerHaxeTaskEmissionSourceValue<Value>(
  module: Readonly<IrModule>,
  path: CompilerIrTraversalPath,
  capabilities: Readonly<CompilerHaxeTaskEmissionCapabilities>,
): Readonly<Value> {
  let value: unknown;
  try {
    value = getIrModuleTraversalPathValue(module, path);
  } catch {
    return capabilities.fail(`Haxe task source path does not exist: ${JSON.stringify(path)}`);
  }
  if (!value || typeof value !== 'object') {
    return capabilities.fail(`Haxe task source path is not a node: ${JSON.stringify(path)}`);
  }
  return value as Readonly<Value>;
}

function getCompilerHaxeTaskEmissionGuardBinding(
  functionPlan: Readonly<CompilerHaxeTaskLoweringFunction>,
  catchState: Readonly<CompilerAsyncStateMachineStateIdentity>,
): { catchBinding?: IrBindingIdentity } {
  const key = getCompilerHaxeTaskEmissionIdentityKey(catchState);
  const guarded = functionPlan.states.find(
    (state) => state.guard && getCompilerHaxeTaskEmissionIdentityKey(state.guard.catchState) === key,
  );
  return guarded?.guard?.catchBinding ? { catchBinding: guarded.guard.catchBinding } : {};
}

function getCompilerHaxeTaskEmissionIdentityKey(identity: Readonly<CompilerAsyncStateMachineStateIdentity>): string {
  switch (identity.kind) {
    case 'branchArm':
      return `branchArm:${identity.arm}:${JSON.stringify(identity.path)}`;
    case 'entry':
      return 'entry';
    case 'catch':
      return `catch:${JSON.stringify(identity.path)}`;
    case 'join':
      return `join:${JSON.stringify(identity.path)}`;
    case 'loopHeader':
      return `loopHeader:${JSON.stringify(identity.path)}`;
    case 'resume':
      return JSON.stringify(identity.suspensionPath);
  }
}

function getCompilerHaxeTaskEmissionStateIdentity(
  state:
    | Readonly<CompilerHaxeTaskLoweringState>
    | Readonly<Extract<CompilerHaxeTaskLoweringStep, { kind: 'awaitRuntime' }>>,
): string {
  const identity = 'identity' in state ? state.identity : state.resumeState;
  return identity ? getCompilerHaxeTaskEmissionIdentityKey(identity) : 'entry';
}

function isCompilerHaxeTaskEmissionPathEqual(left: CompilerIrTraversalPath, right: CompilerIrTraversalPath): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}
