import type {
  CompilerLoweringPass,
  CompilerSourceIdentity,
  IrBindingPattern,
  IrBindingIdentity,
  IrDeclaration,
  IrExpression,
  IrModule,
  IrNamedVariable,
  IrObjectMember,
  IrOperatorValueDomain,
  IrParameter,
  IrStatement,
  IrType,
  IrVariable,
} from '../../compiler-types/src/index.js';
import { createCompilerLoweringFailure } from './compilerLoweringPass.js';
import { validateIrFunctionVariableInitialization } from './compilerVariableHoistingInitialization.js';

interface VariableHoistingAnalysis {
  readonly hoisted: Map<string, IrNamedVariable>;
  iterationCarrierCount: number;
  readonly sourceIdentity: Readonly<CompilerSourceIdentity>;
}

export function createCompilerLoweringPassVariableHoisting(): CompilerLoweringPass {
  return {
    idempotent: true,
    lowerIrModule(module) {
      return hasIrModuleVariableHoistingResidual(module) ? lowerIrModuleVariableHoisting(module) : module;
    },
    name: compilerLoweringPassNameVariableHoisting,
    runsAfter: ['array-binding-pattern'],
    verifyIrModule(module) {
      return hasIrModuleVariableHoistingResidual(module)
        ? { kind: 'invalid', reason: 'function-scoped variable declaration remains outside its hoisted prefix' }
        : { kind: 'valid' };
    },
  };
}

function addIrVariableHoistingDeclaration(
  variable: Readonly<IrNamedVariable>,
  analysis: VariableHoistingAnalysis,
): void {
  if (!variable.mutable) {
    throw createCompilerLoweringFailure(
      'unsupported-ir',
      compilerLoweringPassNameVariableHoisting,
      analysis.sourceIdentity,
      `function-scoped variable ${variable.binding.name} must be mutable`,
    );
  }
  const existing = analysis.hoisted.get(variable.binding.id);
  if (existing) {
    if (JSON.stringify(existing.type) !== JSON.stringify(variable.type)) {
      throw createCompilerLoweringFailure(
        'unsupported-ir',
        compilerLoweringPassNameVariableHoisting,
        analysis.sourceIdentity,
        `function-scoped variable ${variable.binding.name} has inconsistent redeclaration types`,
      );
    }
    return;
  }
  analysis.hoisted.set(variable.binding.id, {
    binding: variable.binding,
    initialValue: hasIrTypeUndefinedVariableHoisting(variable.type) ? 'undefined' : 'uninitialized',
    mutable: true,
    ...(variable.type ? { type: variable.type } : {}),
  });
}

function hasIrTypeUndefinedVariableHoisting(type: Readonly<IrType> | undefined): boolean {
  return (
    type?.kind === 'undefined' ||
    (type?.kind === 'primitive' && type.name === 'void') ||
    (type?.kind === 'union' && type.types.some(hasIrTypeUndefinedVariableHoisting))
  );
}

function collapseIrStatementsVariableHoisting(statements: readonly IrStatement[]): IrStatement {
  return statements.length === 1 ? statements[0]! : { kind: 'block', statements };
}

function createIrVariableHoistingAssignment(
  variable: Readonly<IrNamedVariable>,
  initializer: IrExpression,
): IrStatement {
  const domain = getIrTypeVariableHoistingDomain(variable.type);
  return {
    expression: {
      kind: 'assignment',
      left: { kind: 'identifier', reference: { binding: variable.binding, kind: 'binding' } },
      operator: '=',
      right: initializer,
      semantics: {
        left: { declared: domain, flow: domain },
        result: domain,
        right: { declared: domain, flow: domain },
      },
    },
    kind: 'expression',
  };
}

function createIrVariableHoistingIterationCarrier(
  variable: Readonly<IrNamedVariable>,
  analysis: VariableHoistingAnalysis,
): IrNamedVariable {
  const index = analysis.iterationCarrierCount;
  analysis.iterationCarrierCount += 1;
  const binding: IrBindingIdentity = {
    ...variable.binding,
    id: `binding:${JSON.stringify([
      variable.binding.packageName,
      variable.binding.source,
      variable.binding.id,
      'variable-hoisting-iteration',
      index,
    ])}`,
    name: 'variableHoistingIterationValue',
    scope: 'block',
  };
  return {
    binding,
    mutable: false,
    ...(variable.type ? { type: variable.type } : {}),
  };
}

function getIrTypeVariableHoistingDomain(type: Readonly<IrType> | undefined): IrOperatorValueDomain {
  if (!type) return 'unknown';
  switch (type.kind) {
    case 'array':
    case 'function':
    case 'object':
    case 'tuple':
      return 'object';
    case 'literal':
      return typeof type.value === 'boolean' ? 'boolean' : typeof type.value === 'number' ? 'number' : 'string';
    case 'null':
      return 'null';
    case 'primitive':
      return type.name === 'void' ? 'undefined' : type.name;
    case 'undefined':
      return 'undefined';
    case 'union': {
      const domains = new Set(type.types.map(getIrTypeVariableHoistingDomain));
      return domains.size === 1 ? [...domains][0]! : 'unknown';
    }
    case 'indexedAccess':
    case 'intersection':
    case 'keyof':
    case 'named':
    case 'never':
    case 'typeOf':
    case 'unknown':
      return 'unknown';
  }
}

function hasIrExpressionVariableHoistingResidual(expression: Readonly<IrExpression>): boolean {
  if (expression.kind === 'function') {
    return (
      expression.parameters.some((parameter) =>
        parameter.initializer ? hasIrExpressionVariableHoistingResidual(parameter.initializer) : false,
      ) ||
      hasIrFunctionBodyVariableHoistingResidual(expression.body) ||
      (expression.expression ? hasIrExpressionVariableHoistingResidual(expression.expression) : false)
    );
  }
  let residual = false;
  visitIrExpressionChildrenVariableHoisting(expression, (child) => {
    residual ||= hasIrExpressionVariableHoistingResidual(child);
  });
  return residual;
}

function hasIrFunctionBodyVariableHoistingResidual(body: readonly Readonly<IrStatement>[]): boolean {
  const [prefix, ...rest] = body;
  const validPrefix =
    prefix?.kind === 'variable' &&
    prefix.declarations.length > 0 &&
    prefix.declarations.every(
      (variable) =>
        !('pattern' in variable) &&
        variable.binding.scope === 'function' &&
        (variable.initialValue === 'uninitialized' || variable.initialValue === 'undefined') &&
        variable.initializer === undefined,
    );
  const statements = validPrefix ? rest : body;
  return statements.some(hasIrStatementVariableHoistingResidual);
}

function hasIrModuleVariableHoistingResidual(module: Readonly<IrModule>): boolean {
  return (
    module.declarations.some(hasIrDeclarationVariableHoistingResidual) ||
    module.exports.some(
      (exported) => exported.kind === 'default' && hasIrExpressionVariableHoistingResidual(exported.expression),
    )
  );
}

function hasIrDeclarationVariableHoistingResidual(declaration: Readonly<IrDeclaration>): boolean {
  switch (declaration.kind) {
    case 'class':
      return (
        declaration.fields.some(
          (field) => field.initializer && hasIrExpressionVariableHoistingResidual(field.initializer),
        ) ||
        (declaration.classConstructor
          ? declaration.classConstructor.parameters.some(hasIrParameterVariableHoistingResidual) ||
            hasIrFunctionBodyVariableHoistingResidual(declaration.classConstructor.body)
          : false) ||
        declaration.methods.some(
          (method) =>
            method.parameters.some(hasIrParameterVariableHoistingResidual) ||
            hasIrFunctionBodyVariableHoistingResidual(method.body),
        )
      );
    case 'function':
      return (
        declaration.parameters.some(hasIrParameterVariableHoistingResidual) ||
        declaration.overloads.some((overload) => overload.parameters.some(hasIrParameterVariableHoistingResidual)) ||
        hasIrFunctionBodyVariableHoistingResidual(declaration.body)
      );
    case 'variable':
      return declaration.initializer ? hasIrExpressionVariableHoistingResidual(declaration.initializer) : false;
    case 'enum':
    case 'interface':
    case 'typeAlias':
      return false;
  }
}

function hasIrParameterVariableHoistingResidual(parameter: Readonly<IrParameter>): boolean {
  return parameter.initializer ? hasIrExpressionVariableHoistingResidual(parameter.initializer) : false;
}

function hasIrStatementVariableHoistingResidual(statement: Readonly<IrStatement>): boolean {
  switch (statement.kind) {
    case 'block':
      return statement.statements.some(hasIrStatementVariableHoistingResidual);
    case 'do':
    case 'while':
      return (
        hasIrStatementVariableHoistingResidual(statement.body) ||
        hasIrExpressionVariableHoistingResidual(statement.condition)
      );
    case 'expression':
    case 'throw':
      return hasIrExpressionVariableHoistingResidual(statement.expression);
    case 'for':
      return (
        (Array.isArray(statement.initializer)
          ? statement.initializer.some(hasIrVariableVariableHoistingResidual)
          : statement.initializer
            ? hasIrExpressionVariableHoistingResidual(statement.initializer as IrExpression)
            : false) ||
        (statement.condition ? hasIrExpressionVariableHoistingResidual(statement.condition) : false) ||
        (statement.increment ? hasIrExpressionVariableHoistingResidual(statement.increment) : false) ||
        hasIrStatementVariableHoistingResidual(statement.body)
      );
    case 'forIn':
      return (
        hasIrVariableVariableHoistingResidual(statement.variable) ||
        hasIrExpressionVariableHoistingResidual(statement.object) ||
        hasIrStatementVariableHoistingResidual(statement.body)
      );
    case 'forOf':
      return (
        hasIrVariableVariableHoistingResidual(statement.variable) ||
        hasIrExpressionVariableHoistingResidual(statement.iterable) ||
        hasIrStatementVariableHoistingResidual(statement.body)
      );
    case 'if':
      return (
        hasIrExpressionVariableHoistingResidual(statement.condition) ||
        hasIrStatementVariableHoistingResidual(statement.consequent) ||
        (statement.otherwise ? hasIrStatementVariableHoistingResidual(statement.otherwise) : false)
      );
    case 'return':
      return statement.expression ? hasIrExpressionVariableHoistingResidual(statement.expression) : false;
    case 'switch':
      return (
        hasIrExpressionVariableHoistingResidual(statement.expression) ||
        statement.cases.some(
          (switchCase) =>
            (switchCase.expression ? hasIrExpressionVariableHoistingResidual(switchCase.expression) : false) ||
            switchCase.statements.some(hasIrStatementVariableHoistingResidual),
        )
      );
    case 'try':
      return (
        hasIrStatementVariableHoistingResidual(statement.tryBody) ||
        (statement.catchClause ? hasIrStatementVariableHoistingResidual(statement.catchClause.body) : false) ||
        (statement.finallyBody ? hasIrStatementVariableHoistingResidual(statement.finallyBody) : false)
      );
    case 'variable':
      return statement.declarations.some(hasIrVariableVariableHoistingResidual);
    case 'break':
    case 'continue':
      return false;
  }
}

function hasIrVariableVariableHoistingResidual(variable: Readonly<IrVariable>): boolean {
  return (
    ('pattern' in variable
      ? hasIrBindingPatternVariableHoistingResidual(variable.pattern)
      : variable.binding.scope === 'function') ||
    (variable.initializer ? hasIrExpressionVariableHoistingResidual(variable.initializer) : false)
  );
}

function hasIrBindingPatternVariableHoistingResidual(pattern: Readonly<IrBindingPattern>): boolean {
  if (pattern.kind === 'binding') return pattern.binding.scope === 'function';
  if (pattern.kind === 'object') {
    return (
      pattern.properties.some(
        (property) =>
          (property.key.kind === 'computed' && hasIrExpressionVariableHoistingResidual(property.key.expression)) ||
          hasIrBindingPatternVariableHoistingResidual(property.pattern) ||
          (property.initializer ? hasIrExpressionVariableHoistingResidual(property.initializer) : false),
      ) || (pattern.rest ? hasIrBindingPatternVariableHoistingResidual(pattern.rest) : false)
    );
  }
  return (
    pattern.elements.some(
      (element) =>
        element !== undefined &&
        (hasIrBindingPatternVariableHoistingResidual(element.pattern) ||
          (element.initializer ? hasIrExpressionVariableHoistingResidual(element.initializer) : false)),
    ) || (pattern.rest ? hasIrBindingPatternVariableHoistingResidual(pattern.rest) : false)
  );
}

function lowerIrBindingPatternVariableHoisting(
  pattern: Readonly<IrBindingPattern>,
  analysis: VariableHoistingAnalysis,
): IrBindingPattern {
  if (pattern.kind === 'binding') return pattern;
  if (pattern.kind === 'object') {
    return {
      ...pattern,
      properties: pattern.properties.map((property) => ({
        ...property,
        ...(property.initializer
          ? { initializer: lowerIrExpressionVariableHoisting(property.initializer, analysis) }
          : {}),
        key:
          property.key.kind === 'computed'
            ? {
                ...property.key,
                expression: lowerIrExpressionVariableHoisting(property.key.expression, analysis),
              }
            : property.key,
        pattern: lowerIrBindingPatternVariableHoisting(property.pattern, analysis),
      })),
      ...(pattern.rest ? { rest: lowerIrBindingPatternVariableHoisting(pattern.rest, analysis) } : {}),
    };
  }
  return {
    ...pattern,
    elements: pattern.elements.map((element) =>
      element
        ? {
            ...element,
            ...(element.initializer
              ? { initializer: lowerIrExpressionVariableHoisting(element.initializer, analysis) }
              : {}),
            pattern: lowerIrBindingPatternVariableHoisting(element.pattern, analysis),
          }
        : undefined,
    ),
    ...(pattern.rest ? { rest: lowerIrBindingPatternVariableHoisting(pattern.rest, analysis) } : {}),
  };
}

function lowerIrDeclarationVariableHoisting(
  declaration: Readonly<IrDeclaration>,
  sourceIdentity: Readonly<CompilerSourceIdentity>,
): IrDeclaration {
  switch (declaration.kind) {
    case 'class':
      return {
        ...declaration,
        ...(declaration.classConstructor
          ? {
              classConstructor: {
                ...declaration.classConstructor,
                body: lowerIrFunctionBodyVariableHoisting(declaration.classConstructor.body, sourceIdentity),
                parameters: declaration.classConstructor.parameters.map((parameter) =>
                  lowerIrParameterVariableHoisting(parameter, sourceIdentity),
                ),
              },
            }
          : {}),
        fields: declaration.fields.map((field) => ({
          ...field,
          ...(field.initializer
            ? {
                initializer: lowerIrExpressionVariableHoisting(field.initializer, {
                  hoisted: new Map(),
                  iterationCarrierCount: 0,
                  sourceIdentity,
                }),
              }
            : {}),
        })),
        methods: declaration.methods.map((method) => ({
          ...method,
          body: lowerIrFunctionBodyVariableHoisting(method.body, sourceIdentity),
          parameters: method.parameters.map((parameter) => lowerIrParameterVariableHoisting(parameter, sourceIdentity)),
        })),
      };
    case 'function':
      return {
        ...declaration,
        body: lowerIrFunctionBodyVariableHoisting(declaration.body, sourceIdentity),
        overloads: declaration.overloads.map((overload) => ({
          ...overload,
          parameters: overload.parameters.map((parameter) =>
            lowerIrParameterVariableHoisting(parameter, sourceIdentity),
          ),
        })),
        parameters: declaration.parameters.map((parameter) =>
          lowerIrParameterVariableHoisting(parameter, sourceIdentity),
        ),
      };
    case 'variable':
      return declaration.initializer
        ? {
            ...declaration,
            initializer: lowerIrExpressionVariableHoisting(declaration.initializer, {
              hoisted: new Map(),
              iterationCarrierCount: 0,
              sourceIdentity,
            }),
          }
        : declaration;
    case 'enum':
    case 'interface':
    case 'typeAlias':
      return declaration;
  }
}

function lowerIrExpressionVariableHoisting(
  expression: Readonly<IrExpression>,
  analysis: VariableHoistingAnalysis,
): IrExpression {
  switch (expression.kind) {
    case 'array':
      return {
        ...expression,
        elements: expression.elements.map((element) =>
          element ? lowerIrExpressionVariableHoisting(element, analysis) : undefined,
        ),
      };
    case 'assignment':
    case 'binary':
      return {
        ...expression,
        left: lowerIrExpressionVariableHoisting(expression.left, analysis),
        right: lowerIrExpressionVariableHoisting(expression.right, analysis),
      };
    case 'await':
    case 'cast':
    case 'spread':
      return { ...expression, expression: lowerIrExpressionVariableHoisting(expression.expression, analysis) };
    case 'call':
    case 'new':
      return {
        ...expression,
        arguments: expression.arguments.map((argument) => lowerIrExpressionVariableHoisting(argument, analysis)),
        callee: lowerIrExpressionVariableHoisting(expression.callee, analysis),
      };
    case 'conditional':
      return {
        ...expression,
        condition: lowerIrExpressionVariableHoisting(expression.condition, analysis),
        whenFalse: lowerIrExpressionVariableHoisting(expression.whenFalse, analysis),
        whenTrue: lowerIrExpressionVariableHoisting(expression.whenTrue, analysis),
      };
    case 'element':
      return {
        ...expression,
        index: lowerIrExpressionVariableHoisting(expression.index, analysis),
        object: lowerIrExpressionVariableHoisting(expression.object, analysis),
      };
    case 'function':
      return {
        ...expression,
        body: lowerIrFunctionBodyVariableHoisting(expression.body, analysis.sourceIdentity),
        ...(expression.expression
          ? { expression: lowerIrExpressionVariableHoisting(expression.expression, analysis) }
          : {}),
        parameters: expression.parameters.map((parameter) =>
          lowerIrParameterVariableHoisting(parameter, analysis.sourceIdentity),
        ),
      };
    case 'object':
      return {
        ...expression,
        members: expression.members.map((member) => lowerIrObjectMemberVariableHoisting(member, analysis)),
      };
    case 'objectRest':
      return {
        ...expression,
        excluded: expression.excluded.map((key) =>
          key.kind === 'computed'
            ? { ...key, expression: lowerIrExpressionVariableHoisting(key.expression, analysis) }
            : key,
        ),
        object: expression.object,
      };
    case 'property':
      return { ...expression, object: lowerIrExpressionVariableHoisting(expression.object, analysis) };
    case 'template':
      return {
        ...expression,
        parts: expression.parts.map((part) =>
          typeof part === 'string' ? part : lowerIrExpressionVariableHoisting(part, analysis),
        ),
      };
    case 'tuple':
      return {
        ...expression,
        elements: expression.elements.map((element) => ({
          ...element,
          ...(element.expression
            ? { expression: lowerIrExpressionVariableHoisting(element.expression, analysis) }
            : {}),
        })),
      };
    case 'tupleSpread':
      return {
        ...expression,
        segments: expression.segments.map((segment) =>
          segment.kind === 'spread'
            ? { ...segment, expression: lowerIrExpressionVariableHoisting(segment.expression, analysis) }
            : segment.element.expression
              ? {
                  ...segment,
                  element: {
                    ...segment.element,
                    expression: lowerIrExpressionVariableHoisting(segment.element.expression, analysis),
                  },
                }
              : segment,
        ),
      };
    case 'tupleRest':
      return { ...expression, object: lowerIrExpressionVariableHoisting(expression.object, analysis) };
    case 'unary':
      return { ...expression, operand: lowerIrExpressionVariableHoisting(expression.operand, analysis) };
    case 'undefinedDefault':
      return {
        ...expression,
        fallback: lowerIrExpressionVariableHoisting(expression.fallback, analysis),
        value: lowerIrExpressionVariableHoisting(expression.value, analysis),
      };
    case 'identifier':
    case 'literal':
    case 'regexp':
    case 'tupleSuffix':
    case 'undefinedValue':
      return expression;
  }
}

function lowerIrFunctionBodyVariableHoisting(
  body: readonly Readonly<IrStatement>[],
  sourceIdentity: Readonly<CompilerSourceIdentity>,
): readonly IrStatement[] {
  const analysis: VariableHoistingAnalysis = { hoisted: new Map(), iterationCarrierCount: 0, sourceIdentity };
  const lowered = body.flatMap((statement) => lowerIrStatementVariableHoisting(statement, analysis));
  if (analysis.hoisted.size === 0) return lowered;
  validateIrFunctionVariableInitialization(lowered, analysis.hoisted, sourceIdentity);
  return [{ declarations: [...analysis.hoisted.values()], kind: 'variable' }, ...lowered];
}

function lowerIrModuleVariableHoisting(module: Readonly<IrModule>): IrModule {
  return {
    ...module,
    declarations: module.declarations.map((declaration) => lowerIrDeclarationVariableHoisting(declaration, module)),
    exports: module.exports.map((exported) =>
      exported.kind === 'default'
        ? {
            ...exported,
            expression: lowerIrExpressionVariableHoisting(exported.expression, {
              hoisted: new Map(),
              iterationCarrierCount: 0,
              sourceIdentity: module,
            }),
          }
        : exported,
    ),
  };
}

function lowerIrNamedVariableVariableHoisting(
  variable: Readonly<IrNamedVariable>,
  analysis: VariableHoistingAnalysis,
): readonly IrStatement[] {
  const initializer = variable.initializer
    ? lowerIrExpressionVariableHoisting(variable.initializer, analysis)
    : undefined;
  if (variable.binding.scope !== 'function') {
    return [
      {
        declarations: [{ ...variable, ...(initializer ? { initializer } : {}) }],
        kind: 'variable',
      },
    ];
  }
  addIrVariableHoistingDeclaration(variable, analysis);
  return initializer ? [createIrVariableHoistingAssignment(variable, initializer)] : [];
}

function lowerIrObjectMemberVariableHoisting(
  member: Readonly<IrObjectMember>,
  analysis: VariableHoistingAnalysis,
): IrObjectMember {
  switch (member.kind) {
    case 'computedProperty':
      return {
        ...member,
        key: lowerIrExpressionVariableHoisting(member.key, analysis),
        value: lowerIrExpressionVariableHoisting(member.value, analysis),
      };
    case 'property':
      return { ...member, value: lowerIrExpressionVariableHoisting(member.value, analysis) };
    case 'spread':
      return { ...member, expression: lowerIrExpressionVariableHoisting(member.expression, analysis) };
  }
}

function lowerIrParameterVariableHoisting(
  parameter: Readonly<IrParameter>,
  sourceIdentity: Readonly<CompilerSourceIdentity>,
): IrParameter {
  return parameter.initializer
    ? {
        ...parameter,
        initializer: lowerIrExpressionVariableHoisting(parameter.initializer, {
          hoisted: new Map(),
          iterationCarrierCount: 0,
          sourceIdentity,
        }),
      }
    : parameter;
}

function lowerIrStatementVariableHoisting(
  statement: Readonly<IrStatement>,
  analysis: VariableHoistingAnalysis,
): readonly IrStatement[] {
  switch (statement.kind) {
    case 'block':
      return [
        {
          ...statement,
          statements: statement.statements.flatMap((child) => lowerIrStatementVariableHoisting(child, analysis)),
        },
      ];
    case 'do':
    case 'while':
      return [
        {
          ...statement,
          body: collapseIrStatementsVariableHoisting(lowerIrStatementVariableHoisting(statement.body, analysis)),
          condition: lowerIrExpressionVariableHoisting(statement.condition, analysis),
        },
      ];
    case 'expression':
    case 'throw':
      return [{ ...statement, expression: lowerIrExpressionVariableHoisting(statement.expression, analysis) }];
    case 'for': {
      const initializer = statement.initializer;
      const initialization =
        Array.isArray(initializer) &&
        initializer.some((variable) => getIrVariableScopeVariableHoisting(variable) === 'function')
          ? initializer.flatMap((variable) => lowerIrVariableStatementVariableHoisting(variable, analysis))
          : undefined;
      const loweredBody = collapseIrStatementsVariableHoisting(
        lowerIrStatementVariableHoisting(statement.body, analysis),
      );
      const loweredFor: IrStatement = {
        ...statement,
        body: loweredBody,
        ...(statement.condition ? { condition: lowerIrExpressionVariableHoisting(statement.condition, analysis) } : {}),
        ...(statement.increment ? { increment: lowerIrExpressionVariableHoisting(statement.increment, analysis) } : {}),
      };
      if (!Array.isArray(initializer)) {
        return [
          {
            ...loweredFor,
            ...(initializer
              ? { initializer: lowerIrExpressionVariableHoisting(initializer as IrExpression, analysis) }
              : {}),
          },
        ];
      }
      if (!initialization) {
        return [
          {
            ...loweredFor,
            initializer: initializer.map((variable) => lowerIrVariableVariableHoisting(variable, analysis)),
          },
        ];
      }
      return [...initialization, { ...loweredFor, initializer: undefined }];
    }
    case 'forIn': {
      const lowered = lowerIrIterationVariableVariableHoisting(statement.variable, statement.body, analysis);
      return [
        {
          ...statement,
          body: lowered.body,
          object: lowerIrExpressionVariableHoisting(statement.object, analysis),
          variable: lowered.variable,
        },
      ];
    }
    case 'forOf': {
      const lowered = lowerIrIterationVariableVariableHoisting(statement.variable, statement.body, analysis);
      return [
        {
          ...statement,
          body: lowered.body,
          iterable: lowerIrExpressionVariableHoisting(statement.iterable, analysis),
          variable: lowered.variable,
        },
      ];
    }
    case 'if':
      return [
        {
          ...statement,
          condition: lowerIrExpressionVariableHoisting(statement.condition, analysis),
          consequent: collapseIrStatementsVariableHoisting(
            lowerIrStatementVariableHoisting(statement.consequent, analysis),
          ),
          ...(statement.otherwise
            ? {
                otherwise: collapseIrStatementsVariableHoisting(
                  lowerIrStatementVariableHoisting(statement.otherwise, analysis),
                ),
              }
            : {}),
        },
      ];
    case 'return':
      return [
        {
          ...statement,
          ...(statement.expression
            ? { expression: lowerIrExpressionVariableHoisting(statement.expression, analysis) }
            : {}),
        },
      ];
    case 'switch':
      return [
        {
          ...statement,
          cases: statement.cases.map((switchCase) => ({
            ...switchCase,
            ...(switchCase.expression
              ? { expression: lowerIrExpressionVariableHoisting(switchCase.expression, analysis) }
              : {}),
            statements: switchCase.statements.flatMap((child) => lowerIrStatementVariableHoisting(child, analysis)),
          })),
          expression: lowerIrExpressionVariableHoisting(statement.expression, analysis),
        },
      ];
    case 'try':
      return [
        {
          ...statement,
          ...(statement.catchClause
            ? {
                catchClause: {
                  ...statement.catchClause,
                  body: collapseIrStatementsVariableHoisting(
                    lowerIrStatementVariableHoisting(statement.catchClause.body, analysis),
                  ),
                },
              }
            : {}),
          ...(statement.finallyBody
            ? {
                finallyBody: collapseIrStatementsVariableHoisting(
                  lowerIrStatementVariableHoisting(statement.finallyBody, analysis),
                ),
              }
            : {}),
          tryBody: collapseIrStatementsVariableHoisting(lowerIrStatementVariableHoisting(statement.tryBody, analysis)),
        },
      ];
    case 'variable':
      return statement.declarations.flatMap((variable) => lowerIrVariableStatementVariableHoisting(variable, analysis));
    case 'break':
    case 'continue':
      return [statement];
  }
}

function lowerIrIterationVariableVariableHoisting(
  variable: Readonly<IrVariable>,
  body: Readonly<IrStatement>,
  analysis: VariableHoistingAnalysis,
): Readonly<{ body: IrStatement; variable: IrVariable }> {
  if ('pattern' in variable) {
    throw createCompilerLoweringFailure(
      'unsupported-ir',
      compilerLoweringPassNameVariableHoisting,
      analysis.sourceIdentity,
      'variable hoisting requires prior binding-pattern normalization',
    );
  }
  if (variable.binding.scope !== 'function') {
    return {
      body: collapseIrStatementsVariableHoisting(lowerIrStatementVariableHoisting(body, analysis)),
      variable: lowerIrVariableVariableHoisting(variable, analysis),
    };
  }
  if (variable.initializer) {
    throw createCompilerLoweringFailure(
      'unsupported-ir',
      compilerLoweringPassNameVariableHoisting,
      analysis.sourceIdentity,
      `function-scoped iteration variable ${variable.binding.name} cannot have an initializer`,
    );
  }
  addIrVariableHoistingDeclaration(variable, analysis);
  const carrier = createIrVariableHoistingIterationCarrier(variable, analysis);
  const assignment = createIrVariableHoistingAssignment(variable, {
    kind: 'identifier',
    reference: { binding: carrier.binding, kind: 'binding' },
  });
  const loweredBody = collapseIrStatementsVariableHoisting(lowerIrStatementVariableHoisting(body, analysis));
  return {
    body:
      loweredBody.kind === 'block'
        ? { ...loweredBody, statements: [assignment, ...loweredBody.statements] }
        : { kind: 'block', statements: [assignment, loweredBody] },
    variable: carrier,
  };
}

function lowerIrVariableStatementVariableHoisting(
  variable: Readonly<IrVariable>,
  analysis: VariableHoistingAnalysis,
): readonly IrStatement[] {
  if ('pattern' in variable) {
    throw createCompilerLoweringFailure(
      'unsupported-ir',
      compilerLoweringPassNameVariableHoisting,
      analysis.sourceIdentity,
      'variable hoisting requires prior binding-pattern normalization',
    );
  }
  return lowerIrNamedVariableVariableHoisting(variable, analysis);
}

function lowerIrVariableVariableHoisting(
  variable: Readonly<IrVariable>,
  analysis: VariableHoistingAnalysis,
): IrVariable {
  return {
    ...variable,
    ...(variable.initializer ? { initializer: lowerIrExpressionVariableHoisting(variable.initializer, analysis) } : {}),
    ...('pattern' in variable ? { pattern: lowerIrBindingPatternVariableHoisting(variable.pattern, analysis) } : {}),
  };
}

function getIrVariableScopeVariableHoisting(variable: Readonly<IrVariable>): string {
  return 'pattern' in variable
    ? variable.pattern.kind !== 'binding'
      ? variable.pattern.scope
      : variable.pattern.binding.scope
    : variable.binding.scope;
}

function visitIrExpressionChildrenVariableHoisting(
  expression: Readonly<IrExpression>,
  visit: (expression: Readonly<IrExpression>) => void,
): void {
  switch (expression.kind) {
    case 'array':
      expression.elements.forEach((element) => {
        if (element) visit(element);
      });
      return;
    case 'objectRest':
      visit(expression.object);
      expression.excluded.forEach((key) => {
        if (key.kind === 'computed') visit(key.expression);
      });
      return;
    case 'assignment':
    case 'binary':
      visit(expression.left);
      visit(expression.right);
      return;
    case 'await':
    case 'cast':
    case 'spread':
      visit(expression.expression);
      return;
    case 'call':
    case 'new':
      visit(expression.callee);
      expression.arguments.forEach(visit);
      return;
    case 'conditional':
      visit(expression.condition);
      visit(expression.whenFalse);
      visit(expression.whenTrue);
      return;
    case 'element':
      visit(expression.object);
      visit(expression.index);
      return;
    case 'function':
      return;
    case 'object':
      expression.members.forEach((member) => {
        if (member.kind === 'computedProperty') visit(member.key);
        if (member.kind === 'spread') visit(member.expression);
        else visit(member.value);
      });
      return;
    case 'property':
      visit(expression.object);
      return;
    case 'template':
      expression.parts.forEach((part) => {
        if (typeof part !== 'string') visit(part);
      });
      return;
    case 'tuple':
      expression.elements.forEach((element) => {
        if (element.expression) visit(element.expression);
      });
      return;
    case 'tupleSpread':
      expression.segments.forEach((segment) => {
        const value = segment.kind === 'spread' ? segment.expression : segment.element.expression;
        if (value) visit(value);
      });
      return;
    case 'tupleRest':
    case 'tupleSuffix':
      visit(expression.object);
      return;
    case 'unary':
      visit(expression.operand);
      return;
    case 'undefinedDefault':
      visit(expression.value);
      visit(expression.fallback);
      return;
    case 'identifier':
    case 'literal':
    case 'regexp':
    case 'undefinedValue':
      return;
  }
}

const compilerLoweringPassNameVariableHoisting = 'variable-hoisting';
