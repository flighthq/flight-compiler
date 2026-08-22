import type {
  CompilerCompletion,
  CompilerCompletionSet,
  CompilerStatementCompletionFailure,
  CompilerStatementCompletionFailureCode,
  IrControlFlowLabelIdentity,
  IrStatement,
  IrVariable,
} from '../../compiler-types/src/index.js';
import { applyCompilerCompletionSetCatchReplacement } from './compilerCatchCompletion.js';
import {
  combineCompilerCompletionSetsAlternatively,
  combineCompilerCompletionSetsSequentially,
  createCompilerCompletionSet,
} from './compilerCompletionSet.js';
import { applyCompilerCompletionSetFinallyReplacement } from './compilerFinallyCompletion.js';

interface CompilerControlFlowOwner {
  readonly consumesTargetedContinue: boolean;
  readonly consumesUntargetedBreak: boolean;
  readonly consumesUntargetedContinue: boolean;
  readonly label?: string | undefined;
}

export function getIrStatementListCompletionSet(statements: readonly Readonly<IrStatement>[]): CompilerCompletionSet {
  return getIrStatementListCompletionSetAtPath(statements, ['statements']);
}

export function isCompilerStatementCompletionFailure(value: unknown): value is CompilerStatementCompletionFailure {
  return (
    value instanceof Error &&
    'kind' in value &&
    value.kind === 'compiler-statement-completion' &&
    'code' in value &&
    compilerStatementCompletionFailureCodes.has(value.code as CompilerStatementCompletionFailureCode) &&
    'path' in value &&
    Array.isArray(value.path) &&
    value.path.every((segment) => typeof segment === 'string' || typeof segment === 'number')
  );
}

function getIrStatementListCompletionSetAtPath(
  statements: readonly Readonly<IrStatement>[],
  path: readonly (number | string)[],
): CompilerCompletionSet {
  if (!Array.isArray(statements)) {
    throw createCompilerStatementCompletionFailure(
      'invalid-statement-list',
      path,
      'Statement list input must be an array',
    );
  }
  const completions = statements.map((statement, index) => getIrStatementCompletionSet(statement, [...path, index]));
  return combineCompilerCompletionSetsSequentially(completions);
}

function getIrStatementCompletionSet(
  statement: Readonly<IrStatement>,
  path: readonly (number | string)[],
): CompilerCompletionSet {
  if (!statement || typeof statement !== 'object' || Array.isArray(statement) || !('kind' in statement)) {
    throw createCompilerStatementCompletionFailure(
      'unknown-statement-kind',
      [...path, 'kind'],
      'Statement must use one known kind',
    );
  }
  switch (statement.kind) {
    case 'block': {
      const completion = getIrStatementListCompletionSetAtPath(statement.statements, [...path, 'statements']);
      if (!statement.label) return completion;
      return consumeCompilerCompletionSetControlFlow(completion, {
        consumesTargetedContinue: false,
        consumesUntargetedBreak: false,
        consumesUntargetedContinue: false,
        label: getIrControlFlowLabelIdentityId(statement.label, [...path, 'label']),
      });
    }
    case 'break':
    case 'continue':
      return createCompilerCompletionSet([
        {
          kind: statement.kind,
          ...(statement.target
            ? { target: getIrControlFlowLabelIdentityId(statement.target, [...path, 'target']) }
            : {}),
        },
      ]);
    case 'do':
      return getIrLoopCompletionSet(statement.body, statement.label, 'posttest', false, path);
    case 'expression':
      return createCompilerCompletionSet([{ kind: 'normal' }, { kind: 'throw' }]);
    case 'for': {
      const initializerCanThrow =
        statement.initializer !== undefined &&
        (!Array.isArray(statement.initializer) || hasIrVariableListPotentialThrow(statement.initializer));
      const completion = getIrLoopCompletionSet(
        statement.body,
        statement.label,
        statement.condition ? 'pretest' : 'unconditional',
        statement.increment !== undefined,
        path,
      );
      return initializerCanThrow
        ? combineCompilerCompletionSetsAlternatively([completion, createCompilerCompletionSet([{ kind: 'throw' }])])
        : completion;
    }
    case 'forIn':
    case 'forOf':
      return getIrLoopCompletionSet(statement.body, statement.label, 'enumeration', true, path);
    case 'if': {
      const consequent = getIrStatementCompletionSet(statement.consequent, [...path, 'consequent']);
      const otherwise = statement.otherwise
        ? getIrStatementCompletionSet(statement.otherwise, [...path, 'otherwise'])
        : createCompilerCompletionSet([{ kind: 'normal' }]);
      return combineCompilerCompletionSetsAlternatively([
        consequent,
        otherwise,
        createCompilerCompletionSet([{ kind: 'throw' }]),
      ]);
    }
    case 'return':
      return createCompilerCompletionSet(
        statement.expression ? [{ kind: 'return' }, { kind: 'throw' }] : [{ kind: 'return' }],
      );
    case 'switch': {
      const entries = statement.cases.map((_, entryIndex) =>
        getIrStatementListCompletionSetAtPath(
          statement.cases.slice(entryIndex).flatMap((switchCase) => switchCase.statements),
          [...path, 'cases', entryIndex, 'fallthrough'],
        ),
      );
      if (statement.cases.every((switchCase) => switchCase.expression !== undefined)) {
        entries.push(createCompilerCompletionSet([{ kind: 'normal' }]));
      }
      const selected = combineCompilerCompletionSetsAlternatively(entries);
      const completion = consumeCompilerCompletionSetControlFlow(selected, {
        consumesTargetedContinue: false,
        consumesUntargetedBreak: true,
        consumesUntargetedContinue: false,
        ...(statement.label ? { label: getIrControlFlowLabelIdentityId(statement.label, [...path, 'label']) } : {}),
      });
      return combineCompilerCompletionSetsAlternatively([completion, createCompilerCompletionSet([{ kind: 'throw' }])]);
    }
    case 'throw':
      return createCompilerCompletionSet([{ kind: 'throw' }]);
    case 'try': {
      const tryCompletion = getIrStatementCompletionSet(statement.tryBody, [...path, 'tryBody']);
      const caught = statement.catchClause
        ? applyCompilerCompletionSetCatchReplacement(
            tryCompletion,
            getIrStatementCompletionSet(statement.catchClause.body, [...path, 'catchClause', 'body']),
          )
        : tryCompletion;
      return statement.finallyBody
        ? applyCompilerCompletionSetFinallyReplacement(
            caught,
            getIrStatementCompletionSet(statement.finallyBody, [...path, 'finallyBody']),
          )
        : caught;
    }
    case 'variable':
      return createCompilerCompletionSet(
        hasIrVariableListPotentialThrow(statement.declarations)
          ? [{ kind: 'normal' }, { kind: 'throw' }]
          : [{ kind: 'normal' }],
      );
    case 'while':
      return getIrLoopCompletionSet(statement.body, statement.label, 'pretest', false, path);
    default:
      throw createCompilerStatementCompletionFailure(
        'unknown-statement-kind',
        [...path, 'kind'],
        'Statement must use one known kind',
      );
  }
}

function getIrLoopCompletionSet(
  body: Readonly<IrStatement>,
  label: Readonly<IrControlFlowLabelIdentity> | undefined,
  evaluation: 'enumeration' | 'posttest' | 'pretest' | 'unconditional',
  backEdgeCanThrow: boolean,
  path: readonly (number | string)[],
): CompilerCompletionSet {
  const labelId = label ? getIrControlFlowLabelIdentityId(label, [...path, 'label']) : undefined;
  const bodyCompletion = getIrStatementCompletionSet(body, [...path, 'body']);
  const owner: CompilerControlFlowOwner = {
    consumesTargetedContinue: true,
    consumesUntargetedBreak: true,
    consumesUntargetedContinue: true,
    ...(labelId ? { label: labelId } : {}),
  };
  const escaped = bodyCompletion.completions.filter(
    (completion) =>
      completion.kind !== 'normal' &&
      !isCompilerCompletionOwnedBreak(completion, owner) &&
      !isCompilerCompletionOwnedContinue(completion, owner),
  );
  const completions: CompilerCompletion[] = [...escaped];
  const hasBreak = bodyCompletion.completions.some((completion) => isCompilerCompletionOwnedBreak(completion, owner));
  const hasBackEdge = bodyCompletion.completions.some(
    (completion) => completion.kind === 'normal' || isCompilerCompletionOwnedContinue(completion, owner),
  );
  if (
    hasBreak ||
    evaluation === 'enumeration' ||
    evaluation === 'pretest' ||
    (evaluation === 'posttest' && hasBackEdge)
  ) {
    completions.push({ kind: 'normal' });
  }
  if (evaluation === 'enumeration' || evaluation === 'pretest' || (evaluation === 'posttest' && hasBackEdge)) {
    completions.push({ kind: 'throw' });
  }
  if (backEdgeCanThrow && hasBackEdge) completions.push({ kind: 'throw' });
  return createCompilerCompletionSet(completions);
}

function consumeCompilerCompletionSetControlFlow(
  completion: Readonly<CompilerCompletionSet>,
  owner: Readonly<CompilerControlFlowOwner>,
): CompilerCompletionSet {
  const consumed = completion.completions.some(
    (candidate) =>
      isCompilerCompletionOwnedBreak(candidate, owner) || isCompilerCompletionOwnedContinue(candidate, owner),
  );
  return createCompilerCompletionSet([
    ...completion.completions.filter(
      (candidate) =>
        !isCompilerCompletionOwnedBreak(candidate, owner) && !isCompilerCompletionOwnedContinue(candidate, owner),
    ),
    ...(consumed ? ([{ kind: 'normal' }] as const) : []),
  ]);
}

function hasIrVariableListPotentialThrow(variables: readonly Readonly<IrVariable>[]): boolean {
  return variables.some((variable) => variable.initializer !== undefined || 'pattern' in variable);
}

function isCompilerCompletionOwnedBreak(
  completion: Readonly<CompilerCompletion>,
  owner: Readonly<CompilerControlFlowOwner>,
): boolean {
  return (
    completion.kind === 'break' &&
    (completion.target === undefined ? owner.consumesUntargetedBreak : completion.target === owner.label)
  );
}

function isCompilerCompletionOwnedContinue(
  completion: Readonly<CompilerCompletion>,
  owner: Readonly<CompilerControlFlowOwner>,
): boolean {
  return (
    completion.kind === 'continue' &&
    (completion.target === undefined
      ? owner.consumesUntargetedContinue
      : owner.consumesTargetedContinue && completion.target === owner.label)
  );
}

function getIrControlFlowLabelIdentityId(
  label: Readonly<IrControlFlowLabelIdentity>,
  path: readonly (number | string)[],
): string {
  if (!label || typeof label !== 'object' || typeof label.id !== 'string' || label.id.length === 0) {
    throw createCompilerStatementCompletionFailure(
      'invalid-control-flow-label',
      [...path, 'id'],
      'Control-flow label must have a nonempty identity',
    );
  }
  return label.id;
}

function createCompilerStatementCompletionFailure(
  code: CompilerStatementCompletionFailureCode,
  path: readonly (number | string)[],
  message: string,
): CompilerStatementCompletionFailure {
  const failure = Object.assign(new Error(message), {
    code,
    kind: 'compiler-statement-completion' as const,
    path: Object.freeze([...path]),
  });
  failure.name = 'CompilerStatementCompletionError';
  return failure;
}

const compilerStatementCompletionFailureCodes = new Set<CompilerStatementCompletionFailureCode>([
  'invalid-control-flow-label',
  'invalid-statement-list',
  'unknown-statement-kind',
]);
