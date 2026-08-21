import { compareTextCodeUnits } from '../../compiler-canonical-form/src/index.js';
import type {
  CompilerRuntimeExternalSymbolIdentity,
  IrBindingPattern,
  IrDeclaration,
  IrExpression,
  IrFunctionSignature,
  IrModule,
  IrParameter,
  IrStatement,
  IrType,
  IrTypeParameter,
  IrVariable,
} from '../../compiler-types/src/index.js';

export function collectIrModulesRuntimeExternalSymbolIdentities(
  modules: readonly Readonly<IrModule>[],
): readonly CompilerRuntimeExternalSymbolIdentity[] {
  const identities = new Map<string, CompilerRuntimeExternalSymbolIdentity>();
  const add: AddExternalSymbol = (sourceName, space) => {
    const normalized = sourceName.normalize('NFC');
    if (space === 'type' && compilerIntrinsicTypeNames.has(normalized)) return;
    if (space === 'value' && compilerIntrinsicValueNames.has(normalized)) return;
    const identity = { sourceName: normalized, space } as const;
    identities.set(JSON.stringify([identity.sourceName, identity.space]), identity);
  };
  for (const module of modules) collectModuleExternalSymbols(module, add);
  return [...identities.values()].sort(compareExternalSymbolIdentities);
}

function collectDeclarationExternalSymbols(declaration: Readonly<IrDeclaration>, add: AddExternalSymbol): void {
  switch (declaration.kind) {
    case 'class':
      visitTypeParameters(declaration.typeParameters, add);
      if (declaration.extends) visitType(declaration.extends, add);
      declaration.implements.forEach((implemented) => visitType(implemented, add));
      declaration.fields.forEach((field) => {
        visitType(field.type, add);
        if (field.initializer) visitExpression(field.initializer, add);
      });
      if (declaration.classConstructor) {
        visitParameters(declaration.classConstructor.parameters, add);
        declaration.classConstructor.body.forEach((statement) => visitStatement(statement, add));
      }
      declaration.methods.forEach((method) => {
        visitFunctionSignature(method, add);
        method.body.forEach((statement) => visitStatement(statement, add));
      });
      break;
    case 'enum':
      break;
    case 'function':
      visitFunctionSignature(declaration, add);
      declaration.overloads.forEach((overload) => visitFunctionSignature(overload, add));
      declaration.body.forEach((statement) => visitStatement(statement, add));
      break;
    case 'interface':
      visitTypeParameters(declaration.typeParameters, add);
      declaration.extends.forEach((extended) => visitType(extended, add));
      declaration.properties.forEach((property) => visitType(property.type, add));
      break;
    case 'typeAlias':
      visitTypeParameters(declaration.typeParameters, add);
      visitType(declaration.type, add);
      break;
    case 'variable':
      visitVariable(declaration, add);
      break;
    default:
      return assertNeverIr(declaration);
  }
}

function collectModuleExternalSymbols(module: Readonly<IrModule>, add: AddExternalSymbol): void {
  module.declarations.forEach((declaration) => collectDeclarationExternalSymbols(declaration, add));
  module.exports.forEach((exported) => {
    if (exported.kind === 'default') visitExpression(exported.expression, add);
  });
}

function isIrVariableList(value: IrExpression | readonly IrVariable[] | undefined): value is readonly IrVariable[] {
  return Array.isArray(value);
}

function visitExpression(expression: Readonly<IrExpression>, add: AddExternalSymbol): void {
  switch (expression.kind) {
    case 'array':
      expression.elements.forEach((element) => {
        if (element) visitExpression(element, add);
      });
      break;
    case 'assignment':
    case 'binary':
      visitExpression(expression.left, add);
      visitExpression(expression.right, add);
      break;
    case 'await':
    case 'spread':
      visitExpression(expression.expression, add);
      break;
    case 'call':
    case 'new':
      visitExpression(expression.callee, add);
      expression.arguments.forEach((argument) => visitExpression(argument, add));
      expression.typeArguments.forEach((typeArgument) => visitType(typeArgument, add));
      break;
    case 'cast':
      visitExpression(expression.expression, add);
      visitType(expression.type, add);
      break;
    case 'conditional':
      visitExpression(expression.condition, add);
      visitExpression(expression.whenFalse, add);
      visitExpression(expression.whenTrue, add);
      break;
    case 'element':
      visitExpression(expression.index, add);
      visitExpression(expression.object, add);
      break;
    case 'function':
      visitParameters(expression.parameters, add);
      visitType(expression.returns, add);
      visitTypeParameters(expression.typeParameters, add);
      expression.body.forEach((statement) => visitStatement(statement, add));
      if (expression.expression) visitExpression(expression.expression, add);
      break;
    case 'identifier':
      if (expression.reference.kind === 'ambient') add(expression.reference.name, 'value');
      break;
    case 'literal':
    case 'regexp':
      break;
    case 'object':
      expression.members.forEach((member) => {
        switch (member.kind) {
          case 'computedProperty':
            visitExpression(member.key, add);
            visitExpression(member.value, add);
            break;
          case 'property':
            visitExpression(member.value, add);
            break;
          case 'spread':
            visitExpression(member.expression, add);
            break;
          default:
            return assertNeverIr(member);
        }
      });
      break;
    case 'property':
      visitExpression(expression.object, add);
      break;
    case 'template':
      expression.parts.forEach((part) => {
        if (typeof part !== 'string') visitExpression(part, add);
      });
      break;
    case 'tuple':
      expression.elements.forEach((element) => {
        if (element.expression) visitExpression(element.expression, add);
      });
      break;
    case 'tupleRest':
      visitExpression(expression.object, add);
      break;
    case 'unary':
      visitExpression(expression.operand, add);
      break;
    case 'undefinedDefault':
      visitExpression(expression.fallback, add);
      visitExpression(expression.value, add);
      break;
    default:
      return assertNeverIr(expression);
  }
}

function visitFunctionSignature(signature: Readonly<IrFunctionSignature>, add: AddExternalSymbol): void {
  visitParameters(signature.parameters, add);
  visitType(signature.returns, add);
  visitTypeParameters(signature.typeParameters, add);
}

function visitParameters(parameters: readonly Readonly<IrParameter>[], add: AddExternalSymbol): void {
  parameters.forEach((parameter) => {
    visitType(parameter.type, add);
    if (parameter.initializer) visitExpression(parameter.initializer, add);
  });
}

function visitStatement(statement: Readonly<IrStatement>, add: AddExternalSymbol): void {
  switch (statement.kind) {
    case 'block':
      statement.statements.forEach((child) => visitStatement(child, add));
      break;
    case 'break':
    case 'continue':
      break;
    case 'do':
    case 'while':
      visitStatement(statement.body, add);
      visitExpression(statement.condition, add);
      break;
    case 'expression':
    case 'throw':
      visitExpression(statement.expression, add);
      break;
    case 'for':
      if (isIrVariableList(statement.initializer)) {
        statement.initializer.forEach((variable) => visitVariable(variable, add));
      } else if (statement.initializer) {
        visitExpression(statement.initializer, add);
      }
      if (statement.condition) visitExpression(statement.condition, add);
      if (statement.increment) visitExpression(statement.increment, add);
      visitStatement(statement.body, add);
      break;
    case 'forIn':
      visitVariable(statement.variable, add);
      visitExpression(statement.object, add);
      visitStatement(statement.body, add);
      break;
    case 'forOf':
      visitVariable(statement.variable, add);
      visitExpression(statement.iterable, add);
      visitStatement(statement.body, add);
      break;
    case 'if':
      visitExpression(statement.condition, add);
      visitStatement(statement.consequent, add);
      if (statement.otherwise) visitStatement(statement.otherwise, add);
      break;
    case 'return':
      if (statement.expression) visitExpression(statement.expression, add);
      break;
    case 'switch':
      visitExpression(statement.expression, add);
      statement.cases.forEach((switchCase) => {
        if (switchCase.expression) visitExpression(switchCase.expression, add);
        switchCase.statements.forEach((child) => visitStatement(child, add));
      });
      break;
    case 'try':
      visitStatement(statement.tryBody, add);
      if (statement.catchClause) visitStatement(statement.catchClause.body, add);
      if (statement.finallyBody) visitStatement(statement.finallyBody, add);
      break;
    case 'variable':
      statement.declarations.forEach((variable) => visitVariable(variable, add));
      break;
    default:
      return assertNeverIr(statement);
  }
}

function visitType(type: Readonly<IrType>, add: AddExternalSymbol): void {
  switch (type.kind) {
    case 'array':
      visitType(type.element, add);
      break;
    case 'function':
      type.parameters.forEach((parameter) => visitType(parameter.type, add));
      visitType(type.returns, add);
      visitTypeParameters(type.typeParameters, add);
      break;
    case 'indexedAccess':
      visitType(type.index, add);
      visitType(type.object, add);
      break;
    case 'intersection':
    case 'union':
      type.types.forEach((member) => visitType(member, add));
      break;
    case 'keyof':
      visitType(type.type, add);
      break;
    case 'literal':
    case 'never':
    case 'null':
    case 'primitive':
    case 'undefined':
    case 'unknown':
      break;
    case 'named':
      if (type.reference.kind === 'ambient') add(type.reference.name, 'type');
      type.typeArguments.forEach((typeArgument) => visitType(typeArgument, add));
      break;
    case 'object':
      type.properties.forEach((property) => visitType(property.type, add));
      break;
    case 'tuple':
      type.elements.forEach((element) => visitType(element.type, add));
      break;
    case 'typeOf':
      if (type.reference.kind === 'ambient') add(type.reference.name, 'value');
      break;
    default:
      return assertNeverIr(type);
  }
}

function visitTypeParameters(parameters: readonly Readonly<IrTypeParameter>[], add: AddExternalSymbol): void {
  parameters.forEach((parameter) => {
    if (parameter.constraint) visitType(parameter.constraint, add);
    if (parameter.default) visitType(parameter.default, add);
  });
}

function visitVariable(variable: Readonly<IrVariable>, add: AddExternalSymbol): void {
  if ('pattern' in variable) visitBindingPattern(variable.pattern, add);
  if (variable.type) visitType(variable.type, add);
  if (variable.initializer) visitExpression(variable.initializer, add);
}

function visitBindingPattern(pattern: Readonly<IrBindingPattern>, add: AddExternalSymbol): void {
  switch (pattern.kind) {
    case 'array':
      pattern.elements.forEach((element) => {
        if (!element) return;
        visitBindingPattern(element.pattern, add);
        if (element.initializer) visitExpression(element.initializer, add);
      });
      if (pattern.rest) visitBindingPattern(pattern.rest, add);
      break;
    case 'binding':
      if (pattern.type) visitType(pattern.type, add);
      break;
    default:
      return assertNeverIr(pattern);
  }
}

type AddExternalSymbol = (sourceName: string, space: CompilerRuntimeExternalSymbolIdentity['space']) => void;

function compareExternalSymbolIdentities(
  left: Readonly<CompilerRuntimeExternalSymbolIdentity>,
  right: Readonly<CompilerRuntimeExternalSymbolIdentity>,
): number {
  return compareTextCodeUnits(left.sourceName, right.sourceName) || compareTextCodeUnits(left.space, right.space);
}

function assertNeverIr(value: never): never {
  const kind = (value as { readonly kind?: unknown }).kind;
  throw new Error(`Unexpected neutral IR kind ${String(kind)}`);
}

// These TypeScript utility wrappers change compile-time type meaning but do not name runtime storage.
const compilerIntrinsicTypeNames = new Set(['Partial', 'Readonly', 'Required']);
const compilerIntrinsicValueNames = new Set(['undefined']);
