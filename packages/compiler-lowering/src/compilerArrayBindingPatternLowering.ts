import type {
  CompilerLoweringPass,
  CompilerSourceIdentity,
  IrArrayBindingPattern,
  IrBindingIdentity,
  IrDeclaration,
  IrExpression,
  IrModule,
  IrNamedVariable,
  IrObjectMember,
  IrParameter,
  IrStatement,
  IrType,
  IrVariable,
  IrVariableDeclaration,
} from '../../compiler-types/src/index.js';
import { hasIrModuleArrayBindingPattern } from './compilerArrayBindingPatternPresence.js';
import { createCompilerLoweringFailure } from './compilerLoweringPass.js';

interface ArrayBindingPatternLoweringAnalysis {
  readonly sourceIdentity: Readonly<CompilerSourceIdentity>;
}

interface LoweredArrayBindingVariable {
  readonly synthetic: boolean;
  readonly variable: IrVariable;
}

export function createCompilerLoweringPassArrayBindingPattern(): CompilerLoweringPass {
  return {
    idempotent: true,
    lowerIrModule(module) {
      return lowerIrModuleArrayBindingPattern(module);
    },
    name: compilerLoweringPassNameArrayBindingPattern,
    runsAfter: [],
    verifyIrModule(module) {
      return hasIrModuleArrayBindingPattern(module)
        ? { kind: 'invalid', reason: 'array binding pattern remains after normalization' }
        : { kind: 'valid' };
    },
  };
}

function createIrArrayBindingPatternTemporary(
  pattern: Readonly<IrArrayBindingPattern>,
  path: string,
): IrBindingIdentity {
  return {
    column: pattern.column,
    fingerprint: pattern.fingerprint,
    id: `binding:${JSON.stringify([pattern.packageName, pattern.source, `array-pattern:${path}`])}`,
    kind: 'variable',
    line: pattern.line,
    name: 'arrayPatternValue',
    packageName: pattern.packageName,
    scope: pattern.scope === 'function' ? 'block' : pattern.scope,
    source: pattern.source,
    space: 'value',
  };
}

function createIrArrayBindingPatternElementAccess(binding: Readonly<IrBindingIdentity>, index: number): IrExpression {
  return {
    index: { kind: 'literal', value: index },
    kind: 'element',
    object: { kind: 'identifier', reference: { binding, kind: 'binding' } },
    optional: false,
    semantics: { key: 'number', receivers: ['tuple'] },
  };
}

function hasIrTypeArrayBindingPatternMember(type: Readonly<IrType>, kind: 'null' | 'undefined'): boolean {
  return type.kind === kind || (type.kind === 'union' && type.types.some((member) => member.kind === kind));
}

function hasIrTypeArrayBindingPatternUnresolvedUndefined(type: Readonly<IrType>): boolean {
  if (type.kind === 'union') return type.types.some(hasIrTypeArrayBindingPatternUnresolvedUndefined);
  return (
    type.kind === 'indexedAccess' ||
    type.kind === 'intersection' ||
    type.kind === 'keyof' ||
    type.kind === 'named' ||
    type.kind === 'typeOf' ||
    type.kind === 'unknown'
  );
}

function removeIrTypeArrayBindingPatternUndefined(type: Readonly<IrType>): IrType {
  if (type.kind !== 'union') return type;
  const retained = type.types.filter((member) => member.kind !== 'undefined');
  if (retained.length === 1) return retained[0]!;
  if (retained.length >= 2) return { kind: 'union', types: [retained[0]!, retained[1]!, ...retained.slice(2)] };
  return { kind: 'never' };
}

function createIrArrayBindingPatternTupleSuffix(
  sourceBinding: Readonly<IrBindingIdentity>,
  sourceType: Readonly<Extract<IrType, { kind: 'tuple' }>>,
  start: number,
): Readonly<{ expression: IrExpression; type: Extract<IrType, { kind: 'tuple' }> }> {
  const elements = sourceType.elements.slice(start);
  return {
    expression: {
      kind: 'tupleSuffix',
      object: { kind: 'identifier', reference: { binding: sourceBinding, kind: 'binding' } },
      start,
      width: elements.length,
    },
    type: { elements, kind: 'tuple', readonly: false },
  };
}

function lowerIrArrayBindingPattern(
  pattern: Readonly<IrArrayBindingPattern>,
  sourceBinding: Readonly<IrBindingIdentity>,
  sourceType: Readonly<IrType>,
  mutable: boolean,
  path: string,
  analysis: Readonly<ArrayBindingPatternLoweringAnalysis>,
): readonly LoweredArrayBindingVariable[] {
  if (sourceType.kind !== 'tuple') {
    throw createCompilerLoweringFailure(
      'unsupported-ir',
      compilerLoweringPassNameArrayBindingPattern,
      pattern,
      'array binding lowering requires a statically known tuple type',
    );
  }
  for (const index of pattern.elements.keys()) {
    const patternElement = pattern.elements[index];
    if (!patternElement) continue;
    const tupleElement = sourceType.elements[index];
    if (!tupleElement || tupleElement.rest || (tupleElement.optional && !patternElement.initializer)) {
      throw createCompilerLoweringFailure(
        'unsupported-ir',
        compilerLoweringPassNameArrayBindingPattern,
        pattern,
        `array binding index ${String(index)} requires a present tuple element or default initializer`,
      );
    }
    if (
      patternElement.initializer &&
      !tupleElement.optional &&
      !hasIrTypeArrayBindingPatternMember(tupleElement.type, 'undefined') &&
      hasIrTypeArrayBindingPatternUnresolvedUndefined(tupleElement.type)
    ) {
      throw createCompilerLoweringFailure(
        'unsupported-ir',
        compilerLoweringPassNameArrayBindingPattern,
        pattern,
        `array binding default at index ${String(index)} requires resolved undefined membership`,
      );
    }
    const appliesDefault =
      patternElement.initializer !== undefined &&
      (tupleElement.optional || hasIrTypeArrayBindingPatternMember(tupleElement.type, 'undefined'));
    if (appliesDefault && hasIrTypeArrayBindingPatternMember(tupleElement.type, 'null')) {
      throw createCompilerLoweringFailure(
        'unsupported-ir',
        compilerLoweringPassNameArrayBindingPattern,
        pattern,
        `array binding default at index ${String(index)} requires distinct null and undefined representations`,
      );
    }
  }
  const variables = pattern.elements.flatMap((element, index): readonly LoweredArrayBindingVariable[] => {
    if (!element) return [];
    const tupleElement = sourceType.elements[index]!;
    const elementPath = `${path}.elements[${String(index)}]`;
    const elementAccess = createIrArrayBindingPatternElementAccess(sourceBinding, index);
    const appliesDefault =
      element.initializer !== undefined &&
      (tupleElement.optional || hasIrTypeArrayBindingPatternMember(tupleElement.type, 'undefined'));
    const elementType = appliesDefault
      ? removeIrTypeArrayBindingPatternUndefined(tupleElement.type)
      : tupleElement.type;
    const initializer: IrExpression =
      appliesDefault && element.initializer
        ? {
            fallback: lowerIrExpressionArrayBindingPattern(element.initializer, `${elementPath}.initializer`, analysis),
            kind: 'undefinedDefault',
            value: elementAccess,
          }
        : elementAccess;
    if (element.pattern.kind === 'binding') {
      return [
        {
          synthetic: false,
          variable: {
            binding: element.pattern.binding,
            initializer,
            mutable,
            type: appliesDefault ? elementType : (element.pattern.type ?? elementType),
          },
        },
      ];
    }
    if (element.pattern.kind !== 'array') {
      return [
        {
          synthetic: false,
          variable: {
            initializer,
            mutable,
            pattern: element.pattern,
            type: elementType,
          },
        },
      ];
    }
    const temporaryBinding = createIrArrayBindingPatternTemporary(element.pattern, elementPath);
    const temporary: LoweredArrayBindingVariable = {
      synthetic: true,
      variable: {
        binding: temporaryBinding,
        initializer,
        mutable: false,
        type: elementType,
      },
    };
    return [
      temporary,
      ...lowerIrArrayBindingPattern(element.pattern, temporaryBinding, elementType, mutable, elementPath, analysis),
    ];
  });
  if (!pattern.rest) return variables;
  const restIndex = pattern.elements.length;
  const tupleRest = sourceType.elements[restIndex];
  if (tupleRest?.rest) {
    if (pattern.rest.kind !== 'binding') {
      throw createCompilerLoweringFailure(
        'unsupported-ir',
        compilerLoweringPassNameArrayBindingPattern,
        pattern,
        'nested variadic array binding rest requires variadic tuple-tail destructuring lowering',
      );
    }
    return [
      ...variables,
      {
        synthetic: false,
        variable: {
          binding: pattern.rest.binding,
          initializer: {
            kind: 'tupleRest',
            object: { kind: 'identifier', reference: { binding: sourceBinding, kind: 'binding' } },
            start: restIndex,
          },
          mutable,
          type: pattern.rest.type ?? tupleRest.type,
        },
      },
    ];
  }
  const suffix = createIrArrayBindingPatternTupleSuffix(sourceBinding, sourceType, restIndex);
  if (pattern.rest.kind === 'binding') {
    return [
      ...variables,
      {
        synthetic: false,
        variable: {
          binding: pattern.rest.binding,
          initializer: suffix.expression,
          mutable,
          type: suffix.type,
        },
      },
    ];
  }
  if (pattern.rest.kind !== 'array') {
    return [
      ...variables,
      {
        synthetic: false,
        variable: {
          initializer: suffix.expression,
          mutable,
          pattern: pattern.rest,
          type: suffix.type,
        },
      },
    ];
  }
  const restPath = `${path}.rest`;
  const temporaryBinding = createIrArrayBindingPatternTemporary(pattern.rest, restPath);
  return [
    ...variables,
    {
      synthetic: true,
      variable: {
        binding: temporaryBinding,
        initializer: suffix.expression,
        mutable: false,
        type: suffix.type,
      },
    },
    ...lowerIrArrayBindingPattern(pattern.rest, temporaryBinding, suffix.type, mutable, restPath, analysis),
  ];
}

function lowerIrDeclarationArrayBindingPattern(
  declaration: Readonly<IrDeclaration>,
  path: string,
  analysis: Readonly<ArrayBindingPatternLoweringAnalysis>,
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
                  body: declaration.classConstructor.body.map((statement, index) =>
                    lowerIrStatementArrayBindingPattern(
                      statement,
                      `${path}.classConstructor.body[${String(index)}]`,
                      analysis,
                    ),
                  ),
                  parameters: declaration.classConstructor.parameters.map((parameter, index) =>
                    lowerIrParameterArrayBindingPattern(
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
                  initializer: lowerIrExpressionArrayBindingPattern(
                    field.initializer,
                    `${path}.fields[${String(index)}].initializer`,
                    analysis,
                  ),
                }
              : {}),
          })),
          methods: declaration.methods.map((method, methodIndex) => ({
            ...method,
            body: method.body.map((statement, statementIndex) =>
              lowerIrStatementArrayBindingPattern(
                statement,
                `${path}.methods[${String(methodIndex)}].body[${String(statementIndex)}]`,
                analysis,
              ),
            ),
            parameters: method.parameters.map((parameter, parameterIndex) =>
              lowerIrParameterArrayBindingPattern(
                parameter,
                `${path}.methods[${String(methodIndex)}].parameters[${String(parameterIndex)}]`,
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
          body: declaration.body.map((statement, index) =>
            lowerIrStatementArrayBindingPattern(statement, `${path}.body[${String(index)}]`, analysis),
          ),
          overloads: declaration.overloads.map((overload, overloadIndex) => ({
            ...overload,
            parameters: overload.parameters.map((parameter, parameterIndex) =>
              lowerIrParameterArrayBindingPattern(
                parameter,
                `${path}.overloads[${String(overloadIndex)}].parameters[${String(parameterIndex)}]`,
                analysis,
              ),
            ),
          })),
          parameters: declaration.parameters.map((parameter, index) =>
            lowerIrParameterArrayBindingPattern(parameter, `${path}.parameters[${String(index)}]`, analysis),
          ),
        },
      ];
    case 'variable':
      return lowerIrVariableArrayBindingPattern(declaration, path, analysis).map(
        ({ synthetic, variable }): IrVariableDeclaration => ({
          ...variable,
          exported: synthetic ? false : declaration.exported,
          kind: 'variable',
          origin: declaration.origin,
        }),
      );
    case 'enum':
    case 'interface':
    case 'typeAlias':
      return [declaration];
  }
}

function lowerIrExpressionArrayBindingPattern(
  expression: Readonly<IrExpression>,
  path: string,
  analysis: Readonly<ArrayBindingPatternLoweringAnalysis>,
): IrExpression {
  switch (expression.kind) {
    case 'array':
      return {
        ...expression,
        elements: expression.elements.map((element, index) =>
          element
            ? lowerIrExpressionArrayBindingPattern(element, `${path}.elements[${String(index)}]`, analysis)
            : undefined,
        ),
      };
    case 'assignment':
    case 'binary':
      return {
        ...expression,
        left: lowerIrExpressionArrayBindingPattern(expression.left, `${path}.left`, analysis),
        right: lowerIrExpressionArrayBindingPattern(expression.right, `${path}.right`, analysis),
      };
    case 'await':
    case 'cast':
    case 'spread':
      return {
        ...expression,
        expression: lowerIrExpressionArrayBindingPattern(expression.expression, `${path}.expression`, analysis),
      };
    case 'call':
    case 'new':
      return {
        ...expression,
        arguments: expression.arguments.map((argument, index) =>
          lowerIrExpressionArrayBindingPattern(argument, `${path}.arguments[${String(index)}]`, analysis),
        ),
        callee: lowerIrExpressionArrayBindingPattern(expression.callee, `${path}.callee`, analysis),
      };
    case 'conditional':
      return {
        ...expression,
        condition: lowerIrExpressionArrayBindingPattern(expression.condition, `${path}.condition`, analysis),
        whenFalse: lowerIrExpressionArrayBindingPattern(expression.whenFalse, `${path}.whenFalse`, analysis),
        whenTrue: lowerIrExpressionArrayBindingPattern(expression.whenTrue, `${path}.whenTrue`, analysis),
      };
    case 'element':
      return {
        ...expression,
        index: lowerIrExpressionArrayBindingPattern(expression.index, `${path}.index`, analysis),
        object: lowerIrExpressionArrayBindingPattern(expression.object, `${path}.object`, analysis),
      };
    case 'function':
      return {
        ...expression,
        body: expression.body.map((statement, index) =>
          lowerIrStatementArrayBindingPattern(statement, `${path}.body[${String(index)}]`, analysis),
        ),
        ...(expression.expression
          ? {
              expression: lowerIrExpressionArrayBindingPattern(expression.expression, `${path}.expression`, analysis),
            }
          : {}),
        parameters: expression.parameters.map((parameter, index) =>
          lowerIrParameterArrayBindingPattern(parameter, `${path}.parameters[${String(index)}]`, analysis),
        ),
      };
    case 'object':
      return {
        ...expression,
        members: expression.members.map((member, index) =>
          lowerIrObjectMemberArrayBindingPattern(member, `${path}.members[${String(index)}]`, analysis),
        ),
      };
    case 'objectRest':
      return {
        ...expression,
        excluded: expression.excluded.map((key, index) =>
          key.kind === 'computed'
            ? {
                ...key,
                expression: lowerIrExpressionArrayBindingPattern(
                  key.expression,
                  `${path}.excluded[${String(index)}].expression`,
                  analysis,
                ),
              }
            : key,
        ),
        object: expression.object,
      };
    case 'property':
      return {
        ...expression,
        object: lowerIrExpressionArrayBindingPattern(expression.object, `${path}.object`, analysis),
      };
    case 'template':
      return {
        ...expression,
        parts: expression.parts.map((part, index) =>
          typeof part === 'string'
            ? part
            : lowerIrExpressionArrayBindingPattern(part, `${path}.parts[${String(index)}]`, analysis),
        ),
      };
    case 'tuple':
      return {
        ...expression,
        elements: expression.elements.map((element, index) =>
          element.expression
            ? {
                ...element,
                expression: lowerIrExpressionArrayBindingPattern(
                  element.expression,
                  `${path}.elements[${String(index)}].expression`,
                  analysis,
                ),
              }
            : element,
        ),
      };
    case 'tupleSpread':
      return {
        ...expression,
        segments: expression.segments.map((segment, index) =>
          segment.kind === 'spread'
            ? {
                ...segment,
                expression: lowerIrExpressionArrayBindingPattern(
                  segment.expression,
                  `${path}.segments[${String(index)}].expression`,
                  analysis,
                ),
              }
            : segment.element.expression
              ? {
                  ...segment,
                  element: {
                    ...segment.element,
                    expression: lowerIrExpressionArrayBindingPattern(
                      segment.element.expression,
                      `${path}.segments[${String(index)}].element.expression`,
                      analysis,
                    ),
                  },
                }
              : segment,
        ),
      };
    case 'tupleRest':
      return {
        ...expression,
        object: lowerIrExpressionArrayBindingPattern(expression.object, `${path}.object`, analysis),
      };
    case 'tupleSuffix':
      return expression;
    case 'unary':
      return {
        ...expression,
        operand: lowerIrExpressionArrayBindingPattern(expression.operand, `${path}.operand`, analysis),
      };
    case 'undefinedDefault':
      return {
        ...expression,
        fallback: lowerIrExpressionArrayBindingPattern(expression.fallback, `${path}.fallback`, analysis),
        value: lowerIrExpressionArrayBindingPattern(expression.value, `${path}.value`, analysis),
      };
    case 'identifier':
    case 'literal':
    case 'regexp':
    case 'undefinedValue':
      return expression;
  }
}

function lowerIrModuleArrayBindingPattern(module: Readonly<IrModule>): IrModule {
  const cloned = structuredClone(module);
  const analysis: ArrayBindingPatternLoweringAnalysis = { sourceIdentity: module };
  return {
    ...cloned,
    declarations: cloned.declarations.flatMap((declaration, index) =>
      lowerIrDeclarationArrayBindingPattern(declaration, `$.declarations[${String(index)}]`, analysis),
    ),
    exports: cloned.exports.map((item, index) =>
      item.kind === 'default'
        ? {
            ...item,
            expression: lowerIrExpressionArrayBindingPattern(
              item.expression,
              `$.exports[${String(index)}].expression`,
              analysis,
            ),
          }
        : item,
    ),
  };
}

function lowerIrObjectMemberArrayBindingPattern(
  member: Readonly<IrObjectMember>,
  path: string,
  analysis: Readonly<ArrayBindingPatternLoweringAnalysis>,
): IrObjectMember {
  switch (member.kind) {
    case 'computedProperty':
      return {
        ...member,
        key: lowerIrExpressionArrayBindingPattern(member.key, `${path}.key`, analysis),
        value: lowerIrExpressionArrayBindingPattern(member.value, `${path}.value`, analysis),
      };
    case 'property':
      return {
        ...member,
        value: lowerIrExpressionArrayBindingPattern(member.value, `${path}.value`, analysis),
      };
    case 'spread':
      return {
        ...member,
        expression: lowerIrExpressionArrayBindingPattern(member.expression, `${path}.expression`, analysis),
      };
  }
}

function lowerIrParameterArrayBindingPattern(
  parameter: Readonly<IrParameter>,
  path: string,
  analysis: Readonly<ArrayBindingPatternLoweringAnalysis>,
): IrParameter {
  return parameter.initializer
    ? {
        ...parameter,
        initializer: lowerIrExpressionArrayBindingPattern(parameter.initializer, `${path}.initializer`, analysis),
      }
    : parameter;
}

function lowerIrStatementArrayBindingPattern(
  statement: Readonly<IrStatement>,
  path: string,
  analysis: Readonly<ArrayBindingPatternLoweringAnalysis>,
): IrStatement {
  switch (statement.kind) {
    case 'block':
      return {
        ...statement,
        statements: statement.statements.map((item, index) =>
          lowerIrStatementArrayBindingPattern(item, `${path}.statements[${String(index)}]`, analysis),
        ),
      };
    case 'do':
    case 'while':
      return {
        ...statement,
        body: lowerIrStatementArrayBindingPattern(statement.body, `${path}.body`, analysis),
        condition: lowerIrExpressionArrayBindingPattern(statement.condition, `${path}.condition`, analysis),
      };
    case 'expression':
    case 'throw':
      return {
        ...statement,
        expression: lowerIrExpressionArrayBindingPattern(statement.expression, `${path}.expression`, analysis),
      };
    case 'for':
      return {
        ...statement,
        body: lowerIrStatementArrayBindingPattern(statement.body, `${path}.body`, analysis),
        ...(statement.condition
          ? {
              condition: lowerIrExpressionArrayBindingPattern(statement.condition, `${path}.condition`, analysis),
            }
          : {}),
        ...(statement.increment
          ? {
              increment: lowerIrExpressionArrayBindingPattern(statement.increment, `${path}.increment`, analysis),
            }
          : {}),
        ...(statement.initializer
          ? {
              initializer: isIrVariableList(statement.initializer)
                ? statement.initializer.flatMap((variable, index) =>
                    lowerIrVariableArrayBindingPattern(variable, `${path}.initializer[${String(index)}]`, analysis).map(
                      (item) => item.variable,
                    ),
                  )
                : lowerIrExpressionArrayBindingPattern(statement.initializer, `${path}.initializer`, analysis),
            }
          : {}),
      };
    case 'forIn':
      if ('pattern' in statement.variable) {
        throw createCompilerLoweringFailure(
          'unsupported-ir',
          compilerLoweringPassNameArrayBindingPattern,
          analysis.sourceIdentity,
          'forIn array bindings require iteration destructuring lowering',
        );
      }
      return {
        ...statement,
        body: lowerIrStatementArrayBindingPattern(statement.body, `${path}.body`, analysis),
        object: lowerIrExpressionArrayBindingPattern(statement.object, `${path}.object`, analysis),
        variable: lowerIrNamedVariableArrayBindingPattern(statement.variable, `${path}.variable`, analysis),
      };
    case 'forOf':
      if ('pattern' in statement.variable) {
        if (statement.await) {
          throw createCompilerLoweringFailure(
            'unsupported-ir',
            compilerLoweringPassNameArrayBindingPattern,
            analysis.sourceIdentity,
            'async forOf array bindings require task-aware iteration destructuring lowering',
          );
        }
        if (statement.variable.pattern.kind !== 'array') {
          throw createCompilerLoweringFailure(
            'unsupported-ir',
            compilerLoweringPassNameArrayBindingPattern,
            analysis.sourceIdentity,
            'only array binding patterns can be normalized by this pass',
          );
        }
        const sourceType = statement.variable.pattern.type ?? statement.variable.type;
        if (!sourceType) {
          throw createCompilerLoweringFailure(
            'unsupported-ir',
            compilerLoweringPassNameArrayBindingPattern,
            analysis.sourceIdentity,
            'forOf array binding lowering requires a statically known element type',
          );
        }
        const variablePath = `${path}.variable`;
        const temporaryBinding = createIrArrayBindingPatternTemporary(statement.variable.pattern, variablePath);
        const loweredVariables = lowerIrArrayBindingPattern(
          statement.variable.pattern,
          temporaryBinding,
          sourceType,
          statement.variable.mutable,
          variablePath,
          analysis,
        ).map((item) => item.variable);
        const body = lowerIrStatementArrayBindingPattern(statement.body, `${path}.body`, analysis);
        return {
          ...statement,
          body: prependIrStatementArrayBindingPatternVariables(body, loweredVariables),
          iterable: lowerIrExpressionArrayBindingPattern(statement.iterable, `${path}.iterable`, analysis),
          variable: {
            binding: temporaryBinding,
            mutable: false,
            type: statement.variable.type ?? sourceType,
          },
        };
      }
      return {
        ...statement,
        body: lowerIrStatementArrayBindingPattern(statement.body, `${path}.body`, analysis),
        iterable: lowerIrExpressionArrayBindingPattern(statement.iterable, `${path}.iterable`, analysis),
        variable: lowerIrNamedVariableArrayBindingPattern(statement.variable, `${path}.variable`, analysis),
      };
    case 'if':
      return {
        ...statement,
        condition: lowerIrExpressionArrayBindingPattern(statement.condition, `${path}.condition`, analysis),
        consequent: lowerIrStatementArrayBindingPattern(statement.consequent, `${path}.consequent`, analysis),
        ...(statement.otherwise
          ? {
              otherwise: lowerIrStatementArrayBindingPattern(statement.otherwise, `${path}.otherwise`, analysis),
            }
          : {}),
      };
    case 'return':
      return {
        ...statement,
        ...(statement.expression
          ? {
              expression: lowerIrExpressionArrayBindingPattern(statement.expression, `${path}.expression`, analysis),
            }
          : {}),
      };
    case 'switch':
      return {
        ...statement,
        cases: statement.cases.map((item, caseIndex) => ({
          ...item,
          ...(item.expression
            ? {
                expression: lowerIrExpressionArrayBindingPattern(
                  item.expression,
                  `${path}.cases[${String(caseIndex)}].expression`,
                  analysis,
                ),
              }
            : {}),
          statements: item.statements.map((caseStatement, statementIndex) =>
            lowerIrStatementArrayBindingPattern(
              caseStatement,
              `${path}.cases[${String(caseIndex)}].statements[${String(statementIndex)}]`,
              analysis,
            ),
          ),
        })),
        expression: lowerIrExpressionArrayBindingPattern(statement.expression, `${path}.expression`, analysis),
      };
    case 'try':
      return {
        ...statement,
        ...(statement.catchClause
          ? {
              catchClause: {
                ...statement.catchClause,
                body: lowerIrStatementArrayBindingPattern(
                  statement.catchClause.body,
                  `${path}.catchClause.body`,
                  analysis,
                ),
              },
            }
          : {}),
        ...(statement.finallyBody
          ? {
              finallyBody: lowerIrStatementArrayBindingPattern(statement.finallyBody, `${path}.finallyBody`, analysis),
            }
          : {}),
        tryBody: lowerIrStatementArrayBindingPattern(statement.tryBody, `${path}.tryBody`, analysis),
      };
    case 'variable':
      return {
        ...statement,
        declarations: statement.declarations.flatMap((variable, index) =>
          lowerIrVariableArrayBindingPattern(variable, `${path}.declarations[${String(index)}]`, analysis).map(
            (item) => item.variable,
          ),
        ),
      };
    case 'break':
    case 'continue':
      return statement;
  }
}

function prependIrStatementArrayBindingPatternVariables(
  body: Readonly<IrStatement>,
  variables: readonly IrVariable[],
): IrStatement {
  if (variables.length === 0) return body;
  const declaration: IrStatement = { declarations: variables, kind: 'variable' };
  return body.kind === 'block'
    ? { ...body, statements: [declaration, ...body.statements] }
    : { kind: 'block', statements: [declaration, body] };
}

function lowerIrNamedVariableArrayBindingPattern(
  variable: Readonly<IrNamedVariable>,
  path: string,
  analysis: Readonly<ArrayBindingPatternLoweringAnalysis>,
): IrNamedVariable {
  return {
    ...variable,
    ...(variable.initializer
      ? {
          initializer: lowerIrExpressionArrayBindingPattern(variable.initializer, `${path}.initializer`, analysis),
        }
      : {}),
  };
}

function lowerIrVariableArrayBindingPattern(
  variable: Readonly<IrVariable>,
  path: string,
  analysis: Readonly<ArrayBindingPatternLoweringAnalysis>,
): readonly LoweredArrayBindingVariable[] {
  if (!('pattern' in variable)) {
    return [
      {
        synthetic: false,
        variable: lowerIrNamedVariableArrayBindingPattern(variable, path, analysis),
      },
    ];
  }
  if (variable.pattern.kind !== 'array') {
    return [
      {
        synthetic: false,
        variable: {
          ...variable,
          ...(variable.initializer
            ? {
                initializer: lowerIrExpressionArrayBindingPattern(
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
      compilerLoweringPassNameArrayBindingPattern,
      analysis.sourceIdentity,
      'array binding pattern requires an initializer outside iteration statements',
    );
  }
  const sourceType = variable.pattern.type ?? variable.type;
  if (!sourceType) {
    throw createCompilerLoweringFailure(
      'unsupported-ir',
      compilerLoweringPassNameArrayBindingPattern,
      analysis.sourceIdentity,
      'array binding lowering requires a statically known tuple type',
    );
  }
  const temporaryBinding = createIrArrayBindingPatternTemporary(variable.pattern, path);
  return [
    {
      synthetic: true,
      variable: {
        binding: temporaryBinding,
        initializer: lowerIrExpressionArrayBindingPattern(variable.initializer, `${path}.initializer`, analysis),
        mutable: false,
        type: variable.type ?? sourceType,
      },
    },
    ...lowerIrArrayBindingPattern(variable.pattern, temporaryBinding, sourceType, variable.mutable, path, analysis),
  ];
}

function isIrVariableList(value: IrExpression | readonly IrVariable[] | undefined): value is readonly IrVariable[] {
  return Array.isArray(value);
}

const compilerLoweringPassNameArrayBindingPattern = 'array-binding-pattern';
