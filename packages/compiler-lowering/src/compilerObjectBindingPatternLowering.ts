import type {
  CompilerLoweringPass,
  CompilerSourceIdentity,
  IrBindingIdentity,
  IrBindingPattern,
  IrDeclaration,
  IrExpression,
  IrNamedVariable,
  IrObjectBindingPattern,
  IrObjectMember,
  IrObjectRestKey,
  IrParameter,
  IrStatement,
  IrType,
  IrVariable,
  IrVariableDeclaration,
} from '../../compiler-types/src/index.js';
import { createCompilerLoweringFailure } from './compilerLoweringPass.js';

interface ObjectBindingPatternLoweringAnalysis {
  readonly sourceIdentity: Readonly<CompilerSourceIdentity>;
}

interface LoweredObjectBindingVariable {
  readonly synthetic: boolean;
  readonly variable: IrVariable;
}

export function createCompilerLoweringPassObjectBindingPattern(): CompilerLoweringPass {
  return {
    idempotent: true,
    lowerIrModule(module) {
      const analysis = { sourceIdentity: module };
      return {
        ...module,
        declarations: module.declarations.flatMap((declaration, index) =>
          lowerIrDeclarationObjectBindingPattern(declaration, `declarations[${String(index)}]`, analysis),
        ),
        exports: module.exports.map((item, index) =>
          item.kind === 'default'
            ? {
                ...item,
                expression: lowerIrExpressionObjectBindingPattern(
                  item.expression,
                  `exports[${String(index)}].expression`,
                  analysis,
                ),
              }
            : item,
        ),
      };
    },
    name: compilerLoweringPassNameObjectBindingPattern,
    runsAfter: [],
    verifyIrModule(module) {
      return hasIrObjectBindingPatternValue(module)
        ? { kind: 'invalid', reason: 'object binding pattern remains after normalization' }
        : { kind: 'valid' };
    },
  };
}

function createIrObjectBindingPatternTemporary(
  pattern: Readonly<IrObjectBindingPattern>,
  path: string,
  name: 'objectPatternKey' | 'objectPatternValue',
): IrBindingIdentity {
  return {
    column: pattern.column,
    fingerprint: pattern.fingerprint,
    id: `binding:${JSON.stringify([pattern.packageName, pattern.source, `${name}:${path}`])}`,
    kind: 'variable',
    line: pattern.line,
    name,
    packageName: pattern.packageName,
    scope: pattern.scope === 'function' ? 'block' : pattern.scope,
    source: pattern.source,
    space: 'value',
  };
}

function getIrBindingPatternTypeObjectBindingPattern(pattern: Readonly<IrBindingPattern>): IrType | undefined {
  return pattern.type;
}

function getIrObjectPropertyTypeObjectBindingPattern(
  sourceType: Readonly<IrType> | undefined,
  name: string,
): IrType | undefined {
  if (sourceType?.kind !== 'object') return undefined;
  const property = sourceType.properties.find((candidate) => candidate.name === name);
  if (!property) return undefined;
  if (!property.optional) return property.type;
  if (
    property.type.kind === 'undefined' ||
    (property.type.kind === 'union' && property.type.types.some((member) => member.kind === 'undefined'))
  ) {
    return property.type;
  }
  return property.type.kind === 'union'
    ? {
        kind: 'union',
        types: [property.type.types[0], property.type.types[1], ...property.type.types.slice(2), { kind: 'undefined' }],
      }
    : { kind: 'union', types: [property.type, { kind: 'undefined' }] };
}

function removeIrObjectPropertyUndefinedObjectBindingPattern(type: Readonly<IrType> | undefined): IrType | undefined {
  if (type?.kind !== 'union') return type;
  const retained = type.types.filter((member) => member.kind !== 'undefined');
  if (retained.length === 1) return retained[0];
  return retained.length >= 2
    ? { kind: 'union', types: [retained[0]!, retained[1]!, ...retained.slice(2)] }
    : undefined;
}

function hasIrObjectPropertyMemberObjectBindingPattern(
  type: Readonly<IrType> | undefined,
  kind: 'null' | 'undefined',
): boolean {
  return type?.kind === kind || (type?.kind === 'union' && type.types.some((member) => member.kind === kind));
}

function hasIrObjectPropertyUnresolvedUndefinedObjectBindingPattern(type: Readonly<IrType> | undefined): boolean {
  if (!type) return true;
  if (type.kind === 'union') return type.types.some(hasIrObjectPropertyUnresolvedUndefinedObjectBindingPattern);
  return (
    type.kind === 'indexedAccess' ||
    type.kind === 'intersection' ||
    type.kind === 'keyof' ||
    type.kind === 'named' ||
    type.kind === 'typeOf' ||
    type.kind === 'unknown'
  );
}

function lowerIrObjectBindingPattern(
  pattern: Readonly<IrObjectBindingPattern>,
  sourceBinding: Readonly<IrBindingIdentity>,
  sourceType: Readonly<IrType> | undefined,
  mutable: boolean,
  path: string,
  analysis: Readonly<ObjectBindingPatternLoweringAnalysis>,
): readonly LoweredObjectBindingVariable[] {
  const variables: LoweredObjectBindingVariable[] = [];
  const excluded: IrObjectRestKey[] = [];
  pattern.properties.forEach((property, index) => {
    const propertyPath = `${path}.properties[${String(index)}]`;
    let access: IrExpression;
    let propertyType: IrType | undefined;
    if (property.key.kind === 'named') {
      excluded.push(property.key);
      propertyType =
        getIrObjectPropertyTypeObjectBindingPattern(sourceType, property.key.name) ??
        getIrBindingPatternTypeObjectBindingPattern(property.pattern);
      access = {
        kind: 'property',
        name: property.key.name,
        object: { kind: 'identifier', reference: { binding: sourceBinding, kind: 'binding' } },
        optional: false,
      };
    } else {
      const keyBinding = createIrObjectBindingPatternTemporary(pattern, `${propertyPath}.key`, 'objectPatternKey');
      variables.push({
        synthetic: true,
        variable: {
          binding: keyBinding,
          initializer: lowerIrExpressionObjectBindingPattern(
            property.key.expression,
            `${propertyPath}.key.expression`,
            analysis,
          ),
          mutable: false,
          type: { kind: 'unknown', source: 'unknown' },
        },
      });
      const key = {
        expression: { kind: 'identifier', reference: { binding: keyBinding, kind: 'binding' } },
        kind: 'computed',
      } as const;
      excluded.push(key);
      propertyType = getIrBindingPatternTypeObjectBindingPattern(property.pattern);
      access = {
        index: key.expression,
        kind: 'element',
        object: { kind: 'identifier', reference: { binding: sourceBinding, kind: 'binding' } },
        optional: false,
        semantics: { receivers: ['object'] },
      };
    }
    if (
      property.initializer &&
      !hasIrObjectPropertyMemberObjectBindingPattern(propertyType, 'undefined') &&
      hasIrObjectPropertyUnresolvedUndefinedObjectBindingPattern(propertyType)
    ) {
      throw createCompilerLoweringFailure(
        'unsupported-ir',
        compilerLoweringPassNameObjectBindingPattern,
        pattern,
        `object binding default at property ${String(index)} requires resolved undefined membership`,
      );
    }
    if (property.initializer && hasIrObjectPropertyMemberObjectBindingPattern(propertyType, 'null')) {
      throw createCompilerLoweringFailure(
        'unsupported-ir',
        compilerLoweringPassNameObjectBindingPattern,
        pattern,
        `object binding default at property ${String(index)} requires distinct null and undefined representations`,
      );
    }
    const valueType = property.initializer
      ? removeIrObjectPropertyUndefinedObjectBindingPattern(propertyType)
      : propertyType;
    const initializer: IrExpression = property.initializer
      ? {
          fallback: lowerIrExpressionObjectBindingPattern(
            property.initializer,
            `${propertyPath}.initializer`,
            analysis,
          ),
          kind: 'undefinedDefault',
          value: access,
        }
      : access;
    if (property.pattern.kind === 'binding') {
      variables.push({
        synthetic: false,
        variable: {
          binding: property.pattern.binding,
          initializer,
          mutable,
          ...(valueType ? { type: valueType } : {}),
        },
      });
      return;
    }
    if (property.pattern.kind === 'array') {
      variables.push({
        synthetic: false,
        variable: {
          initializer,
          mutable,
          pattern: property.pattern,
          ...(valueType ? { type: valueType } : {}),
        },
      });
      return;
    }
    const nestedBinding = createIrObjectBindingPatternTemporary(
      property.pattern,
      `${propertyPath}.pattern`,
      'objectPatternValue',
    );
    variables.push({
      synthetic: true,
      variable: { binding: nestedBinding, initializer, mutable: false, ...(valueType ? { type: valueType } : {}) },
    });
    variables.push(
      ...lowerIrObjectBindingPattern(
        property.pattern,
        nestedBinding,
        property.pattern.type ?? valueType,
        mutable,
        `${propertyPath}.pattern`,
        analysis,
      ),
    );
  });
  if (pattern.rest) {
    if (pattern.rest.kind !== 'binding') {
      throw createCompilerLoweringFailure(
        'unsupported-ir',
        compilerLoweringPassNameObjectBindingPattern,
        pattern,
        'object binding rest must introduce one binding',
      );
    }
    variables.push({
      synthetic: false,
      variable: {
        binding: pattern.rest.binding,
        initializer: {
          excluded,
          kind: 'objectRest',
          object: { kind: 'identifier', reference: { binding: sourceBinding, kind: 'binding' } },
        },
        mutable,
        ...(pattern.rest.type ? { type: pattern.rest.type } : {}),
      },
    });
  }
  return variables;
}

function lowerIrVariableObjectBindingPattern(
  variable: Readonly<IrVariable>,
  path: string,
  analysis: Readonly<ObjectBindingPatternLoweringAnalysis>,
): readonly LoweredObjectBindingVariable[] {
  if (!('pattern' in variable)) {
    return [
      {
        synthetic: false,
        variable: {
          ...variable,
          ...(variable.initializer
            ? {
                initializer: lowerIrExpressionObjectBindingPattern(
                  variable.initializer,
                  `${path}.initializer`,
                  analysis,
                ),
              }
            : {}),
        },
      },
    ];
  }
  if (variable.pattern.kind !== 'object') {
    if (hasIrObjectBindingPatternValue(variable.pattern)) {
      throw createCompilerLoweringFailure(
        'unsupported-ir',
        compilerLoweringPassNameObjectBindingPattern,
        analysis.sourceIdentity,
        'an object binding nested in an array requires unified binding-pattern lowering',
      );
    }
    return [
      {
        synthetic: false,
        variable: {
          ...variable,
          ...(variable.initializer
            ? {
                initializer: lowerIrExpressionObjectBindingPattern(
                  variable.initializer,
                  `${path}.initializer`,
                  analysis,
                ),
              }
            : {}),
        },
      },
    ];
  }
  if (!variable.initializer) {
    throw createCompilerLoweringFailure(
      'unsupported-ir',
      compilerLoweringPassNameObjectBindingPattern,
      variable.pattern,
      'object binding pattern requires an initializer outside iteration statements',
    );
  }
  const sourceType = variable.pattern.type ?? variable.type;
  const storageType = variable.type ?? variable.pattern.type;
  const sourceBinding = createIrObjectBindingPatternTemporary(variable.pattern, path, 'objectPatternValue');
  return [
    {
      synthetic: true,
      variable: {
        binding: sourceBinding,
        initializer: lowerIrExpressionObjectBindingPattern(variable.initializer, `${path}.initializer`, analysis),
        mutable: false,
        ...(storageType ? { type: storageType } : {}),
      },
    },
    ...lowerIrObjectBindingPattern(variable.pattern, sourceBinding, sourceType, variable.mutable, path, analysis),
  ];
}

function lowerIrDeclarationObjectBindingPattern(
  declaration: Readonly<IrDeclaration>,
  path: string,
  analysis: Readonly<ObjectBindingPatternLoweringAnalysis>,
): readonly IrDeclaration[] {
  switch (declaration.kind) {
    case 'class':
      return [
        {
          ...declaration,
          ...(declaration.classConstructor
            ? {
                classConstructor: {
                  ...declaration.classConstructor,
                  body: lowerIrStatementListObjectBindingPattern(
                    declaration.classConstructor.body,
                    `${path}.classConstructor.body`,
                    analysis,
                  ),
                  parameters: declaration.classConstructor.parameters.map((parameter, index) =>
                    lowerIrParameterObjectBindingPattern(
                      parameter,
                      `${path}.classConstructor.parameters[${String(index)}]`,
                      analysis,
                    ),
                  ),
                },
              }
            : {}),
          fields: declaration.fields.map((field, index) => ({
            ...field,
            ...(field.initializer
              ? {
                  initializer: lowerIrExpressionObjectBindingPattern(
                    field.initializer,
                    `${path}.fields[${String(index)}].initializer`,
                    analysis,
                  ),
                }
              : {}),
          })),
          methods: declaration.methods.map((method, index) => ({
            ...method,
            body: lowerIrStatementListObjectBindingPattern(
              method.body,
              `${path}.methods[${String(index)}].body`,
              analysis,
            ),
            parameters: method.parameters.map((parameter, parameterIndex) =>
              lowerIrParameterObjectBindingPattern(
                parameter,
                `${path}.methods[${String(index)}].parameters[${String(parameterIndex)}]`,
                analysis,
              ),
            ),
          })),
        },
      ];
    case 'function':
      return [
        {
          ...declaration,
          body: lowerIrStatementListObjectBindingPattern(declaration.body, `${path}.body`, analysis),
          overloads: declaration.overloads.map((overload, index) => ({
            ...overload,
            parameters: overload.parameters.map((parameter, parameterIndex) =>
              lowerIrParameterObjectBindingPattern(
                parameter,
                `${path}.overloads[${String(index)}].parameters[${String(parameterIndex)}]`,
                analysis,
              ),
            ),
          })),
          parameters: declaration.parameters.map((parameter, index) =>
            lowerIrParameterObjectBindingPattern(parameter, `${path}.parameters[${String(index)}]`, analysis),
          ),
        },
      ];
    case 'variable':
      return lowerIrVariableObjectBindingPattern(declaration, path, analysis).map(
        ({ synthetic, variable }): IrVariableDeclaration => {
          if ('pattern' in variable) {
            throw createCompilerLoweringFailure(
              'unsupported-ir',
              compilerLoweringPassNameObjectBindingPattern,
              declaration.origin,
              'module object binding cannot leave a nested array binding',
            );
          }
          return {
            ...variable,
            exported: synthetic ? false : declaration.exported,
            kind: 'variable',
            origin: declaration.origin,
          };
        },
      );
    case 'enum':
    case 'interface':
    case 'typeAlias':
      return [declaration];
  }
}

function lowerIrStatementListObjectBindingPattern(
  statements: readonly IrStatement[],
  path: string,
  analysis: Readonly<ObjectBindingPatternLoweringAnalysis>,
): IrStatement[] {
  return statements.map((statement, index) =>
    lowerIrStatementObjectBindingPattern(statement, `${path}[${String(index)}]`, analysis),
  );
}

function lowerIrStatementObjectBindingPattern(
  statement: Readonly<IrStatement>,
  path: string,
  analysis: Readonly<ObjectBindingPatternLoweringAnalysis>,
): IrStatement {
  switch (statement.kind) {
    case 'block':
      return {
        ...statement,
        statements: lowerIrStatementListObjectBindingPattern(statement.statements, `${path}.statements`, analysis),
      };
    case 'do':
    case 'while':
      return {
        ...statement,
        body: lowerIrStatementObjectBindingPattern(statement.body, `${path}.body`, analysis),
        condition: lowerIrExpressionObjectBindingPattern(statement.condition, `${path}.condition`, analysis),
      };
    case 'expression':
    case 'throw':
      return {
        ...statement,
        expression: lowerIrExpressionObjectBindingPattern(statement.expression, `${path}.expression`, analysis),
      };
    case 'for':
      return {
        ...statement,
        body: lowerIrStatementObjectBindingPattern(statement.body, `${path}.body`, analysis),
        ...(statement.condition
          ? { condition: lowerIrExpressionObjectBindingPattern(statement.condition, `${path}.condition`, analysis) }
          : {}),
        ...(statement.increment
          ? { increment: lowerIrExpressionObjectBindingPattern(statement.increment, `${path}.increment`, analysis) }
          : {}),
        ...(Array.isArray(statement.initializer)
          ? {
              initializer: statement.initializer.flatMap((variable, index) =>
                lowerIrVariableObjectBindingPattern(variable, `${path}.initializer[${String(index)}]`, analysis).map(
                  (item) => item.variable,
                ),
              ),
            }
          : statement.initializer
            ? {
                initializer: lowerIrExpressionObjectBindingPattern(
                  statement.initializer as IrExpression,
                  `${path}.initializer`,
                  analysis,
                ),
              }
            : {}),
      };
    case 'forIn':
    case 'forOf': {
      const iterable =
        statement.kind === 'forIn'
          ? lowerIrExpressionObjectBindingPattern(statement.object, `${path}.object`, analysis)
          : lowerIrExpressionObjectBindingPattern(statement.iterable, `${path}.iterable`, analysis);
      if ('pattern' in statement.variable && statement.variable.pattern.kind === 'object') {
        const sourceType = statement.variable.pattern.type ?? statement.variable.type;
        const binding = createIrObjectBindingPatternTemporary(
          statement.variable.pattern,
          `${path}.variable`,
          'objectPatternValue',
        );
        const variables = lowerIrObjectBindingPattern(
          statement.variable.pattern,
          binding,
          sourceType,
          statement.variable.mutable,
          `${path}.variable`,
          analysis,
        ).map((item) => item.variable);
        const body = lowerIrStatementObjectBindingPattern(statement.body, `${path}.body`, analysis);
        const loweredBody: IrStatement = {
          kind: 'block',
          statements: [
            { declarations: variables, kind: 'variable' },
            ...(body.kind === 'block' ? body.statements : [body]),
          ],
        };
        const variable: IrNamedVariable = { binding, mutable: false, ...(sourceType ? { type: sourceType } : {}) };
        return statement.kind === 'forIn'
          ? { ...statement, body: loweredBody, object: iterable, variable }
          : { ...statement, body: loweredBody, iterable, variable };
      }
      if ('pattern' in statement.variable && hasIrObjectBindingPatternValue(statement.variable.pattern)) {
        throw createCompilerLoweringFailure(
          'unsupported-ir',
          compilerLoweringPassNameObjectBindingPattern,
          analysis.sourceIdentity,
          'an object binding nested in an array iteration requires unified binding-pattern lowering',
        );
      }
      const variable = lowerIrVariableObjectBindingPattern(statement.variable, `${path}.variable`, analysis)[0]!
        .variable;
      return statement.kind === 'forIn'
        ? {
            ...statement,
            body: lowerIrStatementObjectBindingPattern(statement.body, `${path}.body`, analysis),
            object: iterable,
            variable,
          }
        : {
            ...statement,
            body: lowerIrStatementObjectBindingPattern(statement.body, `${path}.body`, analysis),
            iterable,
            variable,
          };
    }
    case 'if':
      return {
        ...statement,
        condition: lowerIrExpressionObjectBindingPattern(statement.condition, `${path}.condition`, analysis),
        consequent: lowerIrStatementObjectBindingPattern(statement.consequent, `${path}.consequent`, analysis),
        ...(statement.otherwise
          ? { otherwise: lowerIrStatementObjectBindingPattern(statement.otherwise, `${path}.otherwise`, analysis) }
          : {}),
      };
    case 'return':
      return {
        ...statement,
        ...(statement.expression
          ? { expression: lowerIrExpressionObjectBindingPattern(statement.expression, `${path}.expression`, analysis) }
          : {}),
      };
    case 'switch':
      return {
        ...statement,
        cases: statement.cases.map((item, index) => ({
          ...item,
          ...(item.expression
            ? {
                expression: lowerIrExpressionObjectBindingPattern(
                  item.expression,
                  `${path}.cases[${String(index)}].expression`,
                  analysis,
                ),
              }
            : {}),
          statements: lowerIrStatementListObjectBindingPattern(
            item.statements,
            `${path}.cases[${String(index)}].statements`,
            analysis,
          ),
        })),
        expression: lowerIrExpressionObjectBindingPattern(statement.expression, `${path}.expression`, analysis),
      };
    case 'try':
      return {
        ...statement,
        ...(statement.catchClause
          ? {
              catchClause: {
                ...statement.catchClause,
                body: lowerIrStatementObjectBindingPattern(
                  statement.catchClause.body,
                  `${path}.catchClause.body`,
                  analysis,
                ),
              },
            }
          : {}),
        ...(statement.finallyBody
          ? {
              finallyBody: lowerIrStatementObjectBindingPattern(statement.finallyBody, `${path}.finallyBody`, analysis),
            }
          : {}),
        tryBody: lowerIrStatementObjectBindingPattern(statement.tryBody, `${path}.tryBody`, analysis),
      };
    case 'variable':
      return {
        ...statement,
        declarations: statement.declarations.flatMap((variable, index) =>
          lowerIrVariableObjectBindingPattern(variable, `${path}.declarations[${String(index)}]`, analysis).map(
            (item) => item.variable,
          ),
        ),
      };
    case 'break':
    case 'continue':
      return statement;
  }
}

function lowerIrParameterObjectBindingPattern(
  parameter: Readonly<IrParameter>,
  path: string,
  analysis: Readonly<ObjectBindingPatternLoweringAnalysis>,
): IrParameter {
  return parameter.initializer
    ? {
        ...parameter,
        initializer: lowerIrExpressionObjectBindingPattern(parameter.initializer, `${path}.initializer`, analysis),
      }
    : parameter;
}

function lowerIrExpressionObjectBindingPattern(
  expression: Readonly<IrExpression>,
  path: string,
  analysis: Readonly<ObjectBindingPatternLoweringAnalysis>,
): IrExpression {
  const lower = (value: Readonly<IrExpression>, suffix: string): IrExpression =>
    lowerIrExpressionObjectBindingPattern(value, `${path}.${suffix}`, analysis);
  switch (expression.kind) {
    case 'array':
      return {
        ...expression,
        elements: expression.elements.map((element, index) =>
          element ? lower(element, `elements[${String(index)}]`) : undefined,
        ),
      };
    case 'assignment':
    case 'binary':
      return { ...expression, left: lower(expression.left, 'left'), right: lower(expression.right, 'right') };
    case 'await':
    case 'cast':
    case 'spread':
      return { ...expression, expression: lower(expression.expression, 'expression') };
    case 'call':
    case 'new':
      return {
        ...expression,
        arguments: expression.arguments.map((argument, index) => lower(argument, `arguments[${String(index)}]`)),
        callee: lower(expression.callee, 'callee'),
      };
    case 'conditional':
      return {
        ...expression,
        condition: lower(expression.condition, 'condition'),
        whenFalse: lower(expression.whenFalse, 'whenFalse'),
        whenTrue: lower(expression.whenTrue, 'whenTrue'),
      };
    case 'element':
      return { ...expression, index: lower(expression.index, 'index'), object: lower(expression.object, 'object') };
    case 'function':
      return {
        ...expression,
        body: lowerIrStatementListObjectBindingPattern(expression.body, `${path}.body`, analysis),
        ...(expression.expression ? { expression: lower(expression.expression, 'expression') } : {}),
        parameters: expression.parameters.map((parameter, index) =>
          lowerIrParameterObjectBindingPattern(parameter, `${path}.parameters[${String(index)}]`, analysis),
        ),
      };
    case 'object':
      return {
        ...expression,
        members: expression.members.map((member, index) =>
          lowerIrObjectMemberObjectBindingPattern(member, `${path}.members[${String(index)}]`, analysis),
        ),
      };
    case 'objectRest':
      return {
        ...expression,
        excluded: expression.excluded.map((key, index) =>
          key.kind === 'computed'
            ? { expression: lower(key.expression, `excluded[${String(index)}].expression`), kind: 'computed' }
            : key,
        ),
      };
    case 'property':
      return { ...expression, object: lower(expression.object, 'object') };
    case 'template':
      return {
        ...expression,
        parts: expression.parts.map((part, index) =>
          typeof part === 'string' ? part : lower(part, `parts[${String(index)}]`),
        ),
      };
    case 'tuple':
      return {
        ...expression,
        elements: expression.elements.map((element, index) =>
          element.expression
            ? { ...element, expression: lower(element.expression, `elements[${String(index)}].expression`) }
            : element,
        ),
      };
    case 'tupleSpread':
      return {
        ...expression,
        segments: expression.segments.map((segment, index) =>
          segment.kind === 'spread'
            ? { ...segment, expression: lower(segment.expression, `segments[${String(index)}].expression`) }
            : segment.element.expression
              ? {
                  ...segment,
                  element: {
                    ...segment.element,
                    expression: lower(segment.element.expression, `segments[${String(index)}].element.expression`),
                  },
                }
              : segment,
        ),
      };
    case 'tupleRest':
      return { ...expression, object: lower(expression.object, 'object') };
    case 'unary':
      return { ...expression, operand: lower(expression.operand, 'operand') };
    case 'undefinedDefault':
      return {
        ...expression,
        fallback: lower(expression.fallback, 'fallback'),
        value: lower(expression.value, 'value'),
      };
    case 'identifier':
    case 'literal':
    case 'regexp':
    case 'tupleSuffix':
      return expression;
  }
}

function lowerIrObjectMemberObjectBindingPattern(
  member: Readonly<IrObjectMember>,
  path: string,
  analysis: Readonly<ObjectBindingPatternLoweringAnalysis>,
): IrObjectMember {
  switch (member.kind) {
    case 'computedProperty':
      return {
        ...member,
        key: lowerIrExpressionObjectBindingPattern(member.key, `${path}.key`, analysis),
        value: lowerIrExpressionObjectBindingPattern(member.value, `${path}.value`, analysis),
      };
    case 'property':
      return { ...member, value: lowerIrExpressionObjectBindingPattern(member.value, `${path}.value`, analysis) };
    case 'spread':
      return {
        ...member,
        expression: lowerIrExpressionObjectBindingPattern(member.expression, `${path}.expression`, analysis),
      };
  }
}

function hasIrObjectBindingPatternValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasIrObjectBindingPatternValue);
  if (!value || typeof value !== 'object') return false;
  const record = value as Readonly<Record<string, unknown>>;
  if (record.kind === 'object' && Array.isArray(record.properties) && typeof record.scope === 'string') return true;
  return Object.values(record).some(hasIrObjectBindingPatternValue);
}

const compilerLoweringPassNameObjectBindingPattern = 'object-binding-pattern';
