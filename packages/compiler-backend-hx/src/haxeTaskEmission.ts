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
  IrExpression,
  IrModule,
  IrStatement,
} from '../../compiler-types/src/index.js';

interface HaxeTaskEmissionNames {
  readonly reject: string;
  readonly resolve: string;
}

// What the emitter can reach from where it currently is: the states it is already inside, the
// continuations it may call by name rather than inline, and the handler each guarded region entered
// by name. Every one of these is a lexical fact about the emitted closure nest, which is why they
// travel together and why a state emitted outside its region cannot see them.
interface HaxeTaskEmissionScope {
  readonly ancestors: ReadonlySet<string>;
  readonly joins: ReadonlyMap<string, string>;
  readonly rejections: ReadonlyMap<string, string>;
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
      emitCompilerHaxeTaskLoweringState(entry, functionPlan, runtime, module, capabilities, names, {
        ancestors: new Set(),
        joins: new Map(),
        rejections: new Map(),
      }),
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
  scope: Readonly<HaxeTaskEmissionScope>,
): string[] {
  const identity = getCompilerHaxeTaskEmissionStateIdentity(state);
  if (scope.ancestors.has(identity)) capabilities.fail(`Haxe task state graph contains a cycle at ${identity}`);
  const nextScope: HaxeTaskEmissionScope = { ...scope, ancestors: new Set([...scope.ancestors, identity]) };
  const errorName = capabilities.getGeneratedName('taskError');
  const body = state.steps.flatMap((step) =>
    emitCompilerHaxeTaskLoweringStep(step, functionPlan, runtime, module, capabilities, names, nextScope),
  );
  return [
    'try {',
    ...indentSourceLines(body),
    `} catch (${errorName}:Dynamic) {`,
    ...indentSourceLines(
      emitCompilerHaxeTaskEmissionRejectionRoute(state.guard?.catchState, errorName, capabilities, names, nextScope),
    ),
    '}',
  ];
}

// A rejection settles the task unless a source-level handler is in scope, in which case it enters the
// named handler the region declared. The handler is a call rather than an inlining because every
// state under a region rejects to the same place: inlining it copied the whole handler into every
// route out of the region, and the copies multiplied with each nested region.
function emitCompilerHaxeTaskEmissionRejectionRoute(
  catchState: Readonly<CompilerAsyncStateMachineStateIdentity> | undefined,
  errorName: string,
  capabilities: Readonly<CompilerHaxeTaskEmissionCapabilities>,
  names: Readonly<HaxeTaskEmissionNames>,
  scope: Readonly<HaxeTaskEmissionScope>,
): string[] {
  if (!catchState) return [`${names.reject}(${errorName});`];
  const key = getCompilerHaxeTaskEmissionIdentityKey(catchState);
  const handlerName = scope.rejections.get(key);
  if (!handlerName) capabilities.fail(`Haxe task guard ${key} has no handler in scope`);
  return [`${handlerName}(${errorName});`, 'return;'];
}

function emitCompilerHaxeTaskLoweringStep(
  step: Readonly<CompilerHaxeTaskLoweringStep>,
  functionPlan: Readonly<CompilerHaxeTaskLoweringFunction>,
  runtime: Readonly<CompilerHaxeTaskLoweringRuntime>,
  module: Readonly<IrModule>,
  capabilities: Readonly<CompilerHaxeTaskEmissionCapabilities>,
  names: Readonly<HaxeTaskEmissionNames>,
  scope: Readonly<HaxeTaskEmissionScope>,
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
      const armScope: HaxeTaskEmissionScope = { ...scope, joins: new Map([...scope.joins, [joinIdentity, joinName]]) };
      const condition = capabilities.emitExpression(
        getCompilerHaxeTaskEmissionSourceValue<IrExpression>(module, step.conditionPath, capabilities),
      );
      return [
        `var ${joinName} = function() {`,
        ...indentSourceLines(
          emitCompilerHaxeTaskLoweringState(joinState, functionPlan, runtime, module, capabilities, names, scope),
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
            armScope,
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
            armScope,
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
      const handlerKey = getCompilerHaxeTaskEmissionIdentityKey(step.catchState);
      const handlerState = functionPlan.states.find(
        (candidate) => getCompilerHaxeTaskEmissionIdentityKey(candidate.identity) === handlerKey,
      );
      if (!handlerState) capabilities.fail(`Haxe task guard at ${JSON.stringify(step.path)} has no handler state`);
      const joinName = capabilities.getGeneratedName('taskJoin');
      const bodyJoins = new Map([...scope.joins, [joinIdentity, joinName]]);
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
        cleanupLines.push(
          `var ${cleanupName} = function() {`,
          ...indentSourceLines(
            emitCompilerHaxeTaskLoweringState(cleanupState, functionPlan, runtime, module, capabilities, names, {
              ...scope,
              joins: bodyJoins,
            }),
          ),
          '};',
        );
        bodyJoins.set(cleanupIdentity, cleanupName);
      }
      const guarded = getCompilerHaxeTaskEmissionGuardedState(functionPlan, step.catchState);
      const handlerName = capabilities.getGeneratedName('taskRejected');
      const rejectionName = capabilities.getGeneratedName('taskRejection');
      const handlerScope: HaxeTaskEmissionScope = { ...scope, joins: bodyJoins };
      return [
        `var ${joinName} = function() {`,
        ...indentSourceLines(
          emitCompilerHaxeTaskLoweringState(joinState, functionPlan, runtime, module, capabilities, names, scope),
        ),
        '};',
        ...cleanupLines,
        `var ${handlerName} = function(${rejectionName}:Dynamic) {`,
        ...indentSourceLines([
          ...(guarded?.catchBinding
            ? [`var ${capabilities.getBindingName(guarded.catchBinding)} = ${rejectionName};`]
            : []),
          ...emitCompilerHaxeTaskLoweringState(
            handlerState,
            functionPlan,
            runtime,
            module,
            capabilities,
            names,
            handlerScope,
          ),
          // A cleanup handler does not consume the rejection it runs on: it runs and then lets the
          // same rejection continue, which is what separates `finally` from `catch`.
          ...(guarded?.rethrow ? [`${names.reject}(${rejectionName});`] : []),
        ]),
        '};',
        ...emitCompilerHaxeTaskLoweringState(bodyState, functionPlan, runtime, module, capabilities, names, {
          ...handlerScope,
          rejections: new Map([...scope.rejections, [handlerKey, handlerName]]),
        }),
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
      const headerScope: HaxeTaskEmissionScope = {
        ...scope,
        joins: new Map([...scope.joins, [headerIdentity, headerName]]),
      };
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
            headerScope,
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
      const joinName = scope.joins.get(target);
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
        scope,
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
          emitCompilerHaxeTaskEmissionRejectionRoute(step.rejectState, awaitErrorName, capabilities, names, scope),
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
  scope: Readonly<HaxeTaskEmissionScope>,
): string[] {
  const key = getCompilerHaxeTaskEmissionIdentityKey(identity);
  const joinName = scope.joins.get(key);
  if (joinName) return [`${joinName}();`, 'return;'];
  const armState = functionPlan.states.find(
    (candidate) => getCompilerHaxeTaskEmissionIdentityKey(candidate.identity) === key,
  );
  if (!armState) capabilities.fail(`Haxe task branch arm ${key} has no matching state`);
  return emitCompilerHaxeTaskLoweringState(armState, functionPlan, runtime, module, capabilities, names, scope);
}

function emitCompilerHaxeTaskSuspensionFulfillment(
  step: Readonly<Extract<CompilerHaxeTaskLoweringStep, { kind: 'awaitRuntime' }>>,
  functionPlan: Readonly<CompilerHaxeTaskLoweringFunction>,
  runtime: Readonly<CompilerHaxeTaskLoweringRuntime>,
  module: Readonly<IrModule>,
  capabilities: Readonly<CompilerHaxeTaskEmissionCapabilities>,
  names: Readonly<HaxeTaskEmissionNames>,
  awaitValueName: string,
  scope: Readonly<HaxeTaskEmissionScope>,
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
    ...emitCompilerHaxeTaskLoweringState(resumeState, functionPlan, runtime, module, capabilities, names, scope),
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

// How a region's handler consumes the rejection it runs on. The guard step names the handler state;
// what the handler does with the value is recorded on the states the handler guards, because that is
// where the source's binding and its `finally`-versus-`catch` distinction were observed.
function getCompilerHaxeTaskEmissionGuardedState(
  functionPlan: Readonly<CompilerHaxeTaskLoweringFunction>,
  catchState: Readonly<CompilerAsyncStateMachineStateIdentity>,
): Readonly<CompilerAsyncStateMachineGuardedState> | undefined {
  const key = getCompilerHaxeTaskEmissionIdentityKey(catchState);
  return functionPlan.states.find(
    (state) => state.guard && getCompilerHaxeTaskEmissionIdentityKey(state.guard.catchState) === key,
  )?.guard;
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
