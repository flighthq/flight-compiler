import { compareTextCodeUnits } from '../../compiler-canonical-form/src/index.js';
import type {
  CompilerTargetNameAllocation,
  CompilerTargetNameAllocationFailure,
  CompilerTargetNameCandidate,
  CompilerTargetNameDisposition,
  CompilerTargetNamePreference,
  IrBindingPattern,
  IrBindingIdentity,
  IrExpression,
  IrModule,
  IrStatement,
  IrTypeBindingIdentity,
  IrVariable,
} from '../../compiler-types/src/index.js';
import { createCompilerInvariantFailure } from './compilerSourceEmission.js';

export function createCompilerTargetNameAllocation(
  candidates: readonly Readonly<CompilerTargetNameCandidate>[],
): readonly CompilerTargetNameAllocation[] {
  const normalized = candidates.map(normalizeCandidate).sort(compareCandidate);
  const identities = new Set<string>();
  for (const candidate of normalized) {
    if (identities.has(candidate.identity)) {
      throw createCompilerInvariantFailure(
        'duplicate-target-name-identity',
        candidate.identity,
        `Target name candidate identity is duplicated: ${candidate.identity}`,
      );
    }
    identities.add(candidate.identity);
  }

  const fixedNames = new Map<string, CompilerTargetNameCandidate>();
  for (const candidate of normalized) {
    if (candidate.disposition !== 'fixed') continue;
    const fixedNameIdentity = `${candidate.scope}\0${candidate.preferredName}`;
    const existing = fixedNames.get(fixedNameIdentity);
    if (existing) throw createTargetNameAllocationFailure(existing, candidate);
    fixedNames.set(fixedNameIdentity, candidate);
  }

  const preferredNames = new Map<string, Set<string>>();
  for (const candidate of normalized) {
    const names = preferredNames.get(candidate.scope) ?? new Set<string>();
    names.add(candidate.preferredName);
    preferredNames.set(candidate.scope, names);
  }

  const allocatedNames = new Map<string, Set<string>>();
  const allocations = normalized.map((candidate): CompilerTargetNameAllocation => {
    const allocated = allocatedNames.get(candidate.scope) ?? new Set<string>();
    const preferred = preferredNames.get(candidate.scope)!;
    let name = candidate.preferredName;
    for (let suffix = 2; allocated.has(name); suffix += 1) {
      name = `${candidate.preferredName}_${String(suffix)}`;
      while (preferred.has(name) || allocated.has(name)) {
        suffix += 1;
        name = `${candidate.preferredName}_${String(suffix)}`;
      }
    }
    allocated.add(name);
    allocatedNames.set(candidate.scope, allocated);
    return { identity: candidate.identity, name, scope: candidate.scope };
  });

  return allocations.sort((left, right) => compareTextCodeUnits(left.identity, right.identity));
}

export function createIrModuleTargetNameAllocation(
  module: Readonly<IrModule>,
  getPreference: CompilerTargetNamePreference,
): readonly CompilerTargetNameAllocation[] {
  return createCompilerTargetNameAllocation(
    getIrModuleBindingIntroductions(module).map((introduction) => {
      const preference = getPreference(introduction.binding);
      return {
        disposition: introduction.disposition,
        identity: introduction.binding.id,
        preferredName: preference.preferredName,
        scope: `${preference.namespace}\0${introduction.scope}`,
      };
    }),
  );
}

export function isCompilerTargetNameAllocationFailure(value: unknown): value is CompilerTargetNameAllocationFailure {
  return (
    value instanceof Error &&
    'kind' in value &&
    value.kind === 'target-name-allocation' &&
    'code' in value &&
    value.code === 'fixed-target-name-collision' &&
    'identities' in value &&
    Array.isArray(value.identities) &&
    value.identities.length >= 2 &&
    value.identities.every((identity) => typeof identity === 'string' && identity.length > 0) &&
    'scope' in value &&
    typeof value.scope === 'string' &&
    value.scope.length > 0 &&
    'targetName' in value &&
    typeof value.targetName === 'string' &&
    value.targetName.length > 0
  );
}

function compareCandidate(
  left: Readonly<CompilerTargetNameCandidate>,
  right: Readonly<CompilerTargetNameCandidate>,
): number {
  // Allocation reserves every preferred name in a scope before assigning any, so the order of
  // candidates preferring different names cannot change the result; identity is unique by contract
  // and makes this total. Ordering by preferred name would be an unobservable term.
  return (
    compareTextCodeUnits(left.scope, right.scope) ||
    compareDisposition(left.disposition, right.disposition) ||
    compareTextCodeUnits(left.identity, right.identity)
  );
}

function compareDisposition(left: CompilerTargetNameDisposition, right: CompilerTargetNameDisposition): number {
  return left === right ? 0 : left === 'fixed' ? -1 : 1;
}

function normalizeCandidate(candidate: Readonly<CompilerTargetNameCandidate>): CompilerTargetNameCandidate {
  const disposition = candidate.disposition;
  const identity = candidate.identity.normalize('NFC');
  const preferredName = candidate.preferredName.normalize('NFC');
  const scope = candidate.scope.normalize('NFC');
  if (
    (disposition !== 'fixed' && disposition !== 'renamable') ||
    identity.length === 0 ||
    preferredName.length === 0 ||
    scope.length === 0
  ) {
    const subject = identity || preferredName || scope || '<empty>';
    throw createCompilerInvariantFailure(
      'invalid-target-name-candidate',
      subject,
      'Target name candidates require a fixed or renamable disposition and nonempty identity, preferredName, and scope values',
    );
  }
  return { disposition, identity, preferredName, scope };
}

interface IrBindingIntroduction {
  readonly binding: IrBindingIdentity | IrTypeBindingIdentity;
  readonly disposition: CompilerTargetNameDisposition;
  readonly scope: string;
}

function getIrModuleBindingIntroductions(module: Readonly<IrModule>): IrBindingIntroduction[] {
  const bindings: IrBindingIntroduction[] = [];
  const add = (
    binding: Readonly<IrBindingIdentity | IrTypeBindingIdentity>,
    scope: string,
    disposition: CompilerTargetNameDisposition = 'renamable',
  ): void => {
    bindings.push({ binding, disposition, scope });
  };
  for (const imported of module.imports) {
    for (const importedBinding of imported.bindings) add(importedBinding.binding, 'module');
  }
  module.declarations.forEach((declaration, declarationIndex) => {
    const declarationPath = `declaration:${String(declarationIndex)}`;
    switch (declaration.kind) {
      case 'class': {
        add(declaration.binding, 'module', declaration.exported ? 'fixed' : 'renamable');
        declaration.typeParameters.forEach((parameter) => add(parameter.binding, `class:${declaration.binding.id}`));
        const constructorScope = `class:${declaration.binding.id}:constructor`;
        declaration.classConstructor?.parameters.forEach((parameter) => add(parameter.binding, constructorScope));
        declaration.classConstructor?.parameters.forEach((parameter, parameterIndex) => {
          if (parameter.initializer) {
            collectExpressionBindings(
              parameter.initializer,
              `${declarationPath}:constructor:parameter:${String(parameterIndex)}`,
              add,
            );
          }
        });
        declaration.classConstructor?.body.forEach((statement, statementIndex) =>
          collectStatementBindings(
            statement,
            constructorScope,
            `${declarationPath}:constructor:statement:${String(statementIndex)}`,
            add,
          ),
        );
        declaration.fields.forEach((field, fieldIndex) => {
          if (field.initializer) {
            collectExpressionBindings(field.initializer, `${declarationPath}:field:${String(fieldIndex)}`, add);
          }
        });
        declaration.methods.forEach((method, methodIndex) => {
          const methodScope = `class:${declaration.binding.id}:method:${String(methodIndex)}`;
          method.typeParameters.forEach((parameter) => add(parameter.binding, methodScope));
          method.parameters.forEach((parameter) => add(parameter.binding, methodScope));
          method.parameters.forEach((parameter, parameterIndex) => {
            if (parameter.initializer) {
              collectExpressionBindings(
                parameter.initializer,
                `${declarationPath}:method:${String(methodIndex)}:parameter:${String(parameterIndex)}`,
                add,
              );
            }
          });
          method.body.forEach((statement, statementIndex) =>
            collectStatementBindings(
              statement,
              methodScope,
              `${declarationPath}:method:${String(methodIndex)}:statement:${String(statementIndex)}`,
              add,
            ),
          );
        });
        break;
      }
      case 'enum':
        add(declaration.binding, 'module', declaration.exported ? 'fixed' : 'renamable');
        break;
      case 'function': {
        add(declaration.binding, 'module', declaration.exported ? 'fixed' : 'renamable');
        const functionScope = `function:${declaration.binding.id}`;
        declaration.typeParameters.forEach((parameter) => add(parameter.binding, functionScope));
        declaration.parameters.forEach((parameter) => add(parameter.binding, functionScope));
        declaration.parameters.forEach((parameter, parameterIndex) => {
          if (parameter.initializer) {
            collectExpressionBindings(
              parameter.initializer,
              `${declarationPath}:parameter:${String(parameterIndex)}`,
              add,
            );
          }
        });
        declaration.body.forEach((statement, statementIndex) =>
          collectStatementBindings(
            statement,
            functionScope,
            `${declarationPath}:statement:${String(statementIndex)}`,
            add,
          ),
        );
        break;
      }
      case 'interface':
      case 'typeAlias':
        add(declaration.binding, 'module', declaration.exported ? 'fixed' : 'renamable');
        declaration.typeParameters.forEach((parameter) => add(parameter.binding, `type:${declaration.binding.id}`));
        break;
      case 'variable':
        if ('pattern' in declaration) {
          collectBindingPatternBindings(declaration.pattern, 'module', `${declarationPath}:pattern`, (binding, scope) =>
            add(binding, scope, declaration.exported ? 'fixed' : 'renamable'),
          );
        } else {
          add(declaration.binding, 'module', declaration.exported ? 'fixed' : 'renamable');
        }
        if (declaration.initializer) {
          collectExpressionBindings(declaration.initializer, `${declarationPath}:initializer`, add);
        }
        break;
    }
  });
  return bindings;
}

function collectExpressionBindings(
  expression: Readonly<IrExpression>,
  path: string,
  add: (binding: Readonly<IrBindingIdentity | IrTypeBindingIdentity>, scope: string) => void,
): void {
  switch (expression.kind) {
    case 'array':
      expression.elements.forEach((element, index) => {
        if (element) collectExpressionBindings(element, `${path}:element:${String(index)}`, add);
      });
      break;
    case 'assignment':
    case 'binary':
      collectExpressionBindings(expression.left, `${path}:left`, add);
      collectExpressionBindings(expression.right, `${path}:right`, add);
      break;
    case 'await':
    case 'cast':
    case 'spread':
      collectExpressionBindings(expression.expression, `${path}:expression`, add);
      break;
    case 'call':
    case 'new':
      collectExpressionBindings(expression.callee, `${path}:callee`, add);
      expression.arguments.forEach((argument, index) =>
        collectExpressionBindings(argument, `${path}:argument:${String(index)}`, add),
      );
      break;
    case 'conditional':
      collectExpressionBindings(expression.condition, `${path}:condition`, add);
      collectExpressionBindings(expression.whenFalse, `${path}:false`, add);
      collectExpressionBindings(expression.whenTrue, `${path}:true`, add);
      break;
    case 'element':
      collectExpressionBindings(expression.index, `${path}:index`, add);
      collectExpressionBindings(expression.object, `${path}:object`, add);
      break;
    case 'function': {
      const functionScope = `function:${expression.binding?.id ?? path}`;
      if (expression.binding) add(expression.binding, functionScope);
      expression.typeParameters.forEach((parameter) => add(parameter.binding, functionScope));
      expression.parameters.forEach((parameter) => add(parameter.binding, functionScope));
      expression.parameters.forEach((parameter, parameterIndex) => {
        if (parameter.initializer) {
          collectExpressionBindings(parameter.initializer, `${path}:parameter:${String(parameterIndex)}`, add);
        }
      });
      expression.body.forEach((statement, statementIndex) =>
        collectStatementBindings(statement, functionScope, `${path}:statement:${String(statementIndex)}`, add),
      );
      if (expression.expression) collectExpressionBindings(expression.expression, `${path}:result`, add);
      break;
    }
    case 'identifier':
    case 'literal':
    case 'regexp':
      break;
    case 'object':
      expression.members.forEach((member, index) => {
        const memberPath = `${path}:member:${String(index)}`;
        if (member.kind === 'computedProperty') collectExpressionBindings(member.key, `${memberPath}:key`, add);
        if (member.kind === 'spread') collectExpressionBindings(member.expression, memberPath, add);
        else collectExpressionBindings(member.value, `${memberPath}:value`, add);
      });
      break;
    case 'property':
      collectExpressionBindings(expression.object, `${path}:object`, add);
      break;
    case 'template':
      expression.parts.forEach((part, index) => {
        if (typeof part !== 'string') collectExpressionBindings(part, `${path}:part:${String(index)}`, add);
      });
      break;
    case 'tuple':
      expression.elements.forEach((element, index) => {
        if (element.expression) collectExpressionBindings(element.expression, `${path}:element:${String(index)}`, add);
      });
      break;
    case 'tupleRest':
      collectExpressionBindings(expression.object, `${path}:object`, add);
      break;
    case 'unary':
      collectExpressionBindings(expression.operand, `${path}:operand`, add);
      break;
    case 'undefinedDefault':
      collectExpressionBindings(expression.fallback, `${path}:fallback`, add);
      collectExpressionBindings(expression.value, `${path}:value`, add);
      break;
  }
}

function collectStatementBindings(
  statement: Readonly<IrStatement>,
  scope: string,
  path: string,
  add: (binding: Readonly<IrBindingIdentity | IrTypeBindingIdentity>, scope: string) => void,
): void {
  switch (statement.kind) {
    case 'block':
      statement.statements.forEach((child, index) =>
        collectStatementBindings(child, scope, `${path}:statement:${String(index)}`, add),
      );
      break;
    case 'break':
    case 'continue':
      break;
    case 'do':
    case 'while':
      collectStatementBindings(statement.body, scope, `${path}:body`, add);
      collectExpressionBindings(statement.condition, `${path}:condition`, add);
      break;
    case 'expression':
    case 'throw':
      collectExpressionBindings(statement.expression, `${path}:expression`, add);
      break;
    case 'for':
      if (isIrVariableList(statement.initializer)) {
        statement.initializer.forEach((variable, index) =>
          collectVariableBindings(variable, scope, `${path}:initializer:${String(index)}`, add),
        );
      } else if (statement.initializer) {
        collectExpressionBindings(statement.initializer, `${path}:initializer`, add);
      }
      if (statement.condition) collectExpressionBindings(statement.condition, `${path}:condition`, add);
      if (statement.increment) collectExpressionBindings(statement.increment, `${path}:increment`, add);
      collectStatementBindings(statement.body, scope, `${path}:body`, add);
      break;
    case 'forIn':
      collectVariableBindings(statement.variable, scope, `${path}:variable`, add);
      collectExpressionBindings(statement.object, `${path}:object`, add);
      collectStatementBindings(statement.body, scope, `${path}:body`, add);
      break;
    case 'forOf':
      collectVariableBindings(statement.variable, scope, `${path}:variable`, add);
      collectExpressionBindings(statement.iterable, `${path}:iterable`, add);
      collectStatementBindings(statement.body, scope, `${path}:body`, add);
      break;
    case 'if':
      collectExpressionBindings(statement.condition, `${path}:condition`, add);
      collectStatementBindings(statement.consequent, scope, `${path}:consequent`, add);
      if (statement.otherwise) collectStatementBindings(statement.otherwise, scope, `${path}:otherwise`, add);
      break;
    case 'return':
      if (statement.expression) collectExpressionBindings(statement.expression, `${path}:expression`, add);
      break;
    case 'switch':
      collectExpressionBindings(statement.expression, `${path}:expression`, add);
      statement.cases.forEach((clause, clauseIndex) => {
        const clausePath = `${path}:case:${String(clauseIndex)}`;
        if (clause.expression) collectExpressionBindings(clause.expression, `${clausePath}:expression`, add);
        clause.statements.forEach((child, statementIndex) =>
          collectStatementBindings(child, scope, `${clausePath}:statement:${String(statementIndex)}`, add),
        );
      });
      break;
    case 'try':
      collectStatementBindings(statement.tryBody, scope, `${path}:try`, add);
      if (statement.catchClause?.binding) add(statement.catchClause.binding, scope);
      if (statement.catchClause) collectStatementBindings(statement.catchClause.body, scope, `${path}:catch`, add);
      if (statement.finallyBody) collectStatementBindings(statement.finallyBody, scope, `${path}:finally`, add);
      break;
    case 'variable':
      statement.declarations.forEach((variable, index) =>
        collectVariableBindings(variable, scope, `${path}:variable:${String(index)}`, add),
      );
      break;
  }
}

function isIrVariableList(value: IrExpression | readonly IrVariable[] | undefined): value is readonly IrVariable[] {
  return Array.isArray(value);
}

function collectVariableBindings(
  variable: Readonly<IrVariable>,
  scope: string,
  path: string,
  add: (binding: Readonly<IrBindingIdentity | IrTypeBindingIdentity>, scope: string) => void,
): void {
  if ('pattern' in variable) collectBindingPatternBindings(variable.pattern, scope, `${path}:pattern`, add);
  else add(variable.binding, scope);
  if (variable.initializer) collectExpressionBindings(variable.initializer, `${path}:initializer`, add);
}

function collectBindingPatternBindings(
  pattern: Readonly<IrBindingPattern>,
  scope: string,
  path: string,
  add: (binding: Readonly<IrBindingIdentity | IrTypeBindingIdentity>, scope: string) => void,
): void {
  switch (pattern.kind) {
    case 'array':
      pattern.elements.forEach((element, index) => {
        if (!element) return;
        const elementPath = `${path}:element:${String(index)}`;
        collectBindingPatternBindings(element.pattern, scope, `${elementPath}:pattern`, add);
        if (element.initializer) collectExpressionBindings(element.initializer, `${elementPath}:initializer`, add);
      });
      if (pattern.rest) collectBindingPatternBindings(pattern.rest, scope, `${path}:rest`, add);
      break;
    case 'binding':
      add(pattern.binding, scope);
      break;
  }
}

function createTargetNameAllocationFailure(
  first: Readonly<CompilerTargetNameCandidate>,
  second: Readonly<CompilerTargetNameCandidate>,
): CompilerTargetNameAllocationFailure {
  const identities = [first.identity, second.identity].sort(compareTextCodeUnits);
  const failure = Object.assign(
    new Error(`Fixed target name ${first.preferredName} collides in scope ${first.scope}: ${identities.join(', ')}`),
    {
      code: 'fixed-target-name-collision' as const,
      identities,
      kind: 'target-name-allocation' as const,
      scope: first.scope,
      targetName: first.preferredName,
    },
  );
  failure.name = 'CompilerTargetNameAllocationError';
  return failure;
}
