import type {
  CompilerStaticFactAudit,
  CompilerStaticFactCount,
  CompilerStaticIndexedAccessMode,
  CompilerStaticNumericArithmeticFact,
  CompilerStaticTruthinessContext,
  IrBindingPattern,
  IrBinaryOperator,
  IrBinaryOperatorSemantics,
  IrDeclaration,
  IrExpression,
  IrIndexedReceiver,
  IrModule,
  IrOperatorOperandDomains,
  IrOperatorValueDomain,
  IrStatement,
  IrTypedArrayElementWidth,
  IrTypedArrayReceiver,
  IrVariable,
} from '../../compiler-types/src/index.js';
import { getCompilerStaticNumericArithmeticFact } from './compilerStaticNumericArithmetic.js';

interface StaticFactAnalysis {
  counts: Map<string, { count: number; fact: StaticFact }>;
}

type StaticFact =
  | Readonly<{
      context: CompilerStaticTruthinessContext;
      domain: IrOperatorValueDomain;
      kind: 'truthiness';
    }>
  | Readonly<{ domain: 'bigint' | 'number'; kind: 'numericRelation' }>
  | Readonly<{
      kind: 'logicalExpression';
      left: IrOperatorValueDomain;
      operator: Extract<IrBinaryOperator, '&&' | '||'>;
      result: IrOperatorValueDomain;
      right: IrOperatorValueDomain;
    }>
  | CompilerStaticNumericArithmeticFact
  | Readonly<{
      access: CompilerStaticIndexedAccessMode;
      kind: 'indexedAccess';
      receivers: readonly [IrIndexedReceiver, ...IrIndexedReceiver[]];
    }>
  | Readonly<{
      kind: 'typedArraySet';
      receivers: readonly [IrTypedArrayReceiver, ...IrTypedArrayReceiver[]];
    }>
  | Readonly<{
      kind: 'mixedWidthIndexedWrite';
      receivers: readonly [IrTypedArrayReceiver, IrTypedArrayReceiver, ...IrTypedArrayReceiver[]];
      widths: readonly [IrTypedArrayElementWidth, IrTypedArrayElementWidth, ...IrTypedArrayElementWidth[]];
    }>;

export function analyzeIrModulesStaticFacts(modules: readonly Readonly<IrModule>[]): CompilerStaticFactAudit {
  const analysis: StaticFactAnalysis = { counts: new Map() };
  for (const module of modules) {
    for (const declaration of module.declarations) analyzeDeclaration(declaration, analysis);
    for (const item of module.exports) {
      if (item.kind === 'default') analyzeExpression(item.expression, analysis, 'read');
    }
  }
  return createStaticFactAudit(analysis, modules.length);
}

export function combineCompilerStaticFactAudits(
  audits: readonly Readonly<CompilerStaticFactAudit>[],
): CompilerStaticFactAudit {
  const analysis: StaticFactAnalysis = { counts: new Map() };
  let modules = 0;
  for (const audit of audits) {
    modules += audit.modules;
    for (const fact of audit.facts) addStaticFact(getStaticFactWithoutCount(fact), analysis, fact.count);
  }
  return createStaticFactAudit(analysis, modules);
}

function addIndexedAccessFact(
  access: CompilerStaticIndexedAccessMode,
  receivers: readonly [IrIndexedReceiver, ...IrIndexedReceiver[]],
  analysis: StaticFactAnalysis,
): void {
  const normalized = [...new Set(receivers)].sort() as [IrIndexedReceiver, ...IrIndexedReceiver[]];
  addStaticFact({ access, kind: 'indexedAccess', receivers: normalized }, analysis);
}

function addNumericArithmeticFact(
  expression: Readonly<Extract<IrExpression, { kind: 'assignment' | 'binary' | 'unary' }>>,
  analysis: StaticFactAnalysis,
): void {
  const fact = getCompilerStaticNumericArithmeticFact(expression);
  if (fact) addStaticFact(fact, analysis);
}

function addNumericRelationFact(domain: 'bigint' | 'number', analysis: StaticFactAnalysis): void {
  addStaticFact({ domain, kind: 'numericRelation' }, analysis);
}

function addLogicalExpressionFact(
  operator: Extract<IrBinaryOperator, '&&' | '||'>,
  semantics: Readonly<IrBinaryOperatorSemantics>,
  analysis: StaticFactAnalysis,
): void {
  addStaticFact(
    {
      kind: 'logicalExpression',
      left: semantics.left.flow,
      operator,
      result: semantics.result,
      right: semantics.right.flow,
    },
    analysis,
  );
}

function addMixedWidthIndexedWriteFact(
  access: CompilerStaticIndexedAccessMode,
  receivers: readonly [IrIndexedReceiver, ...IrIndexedReceiver[]],
  analysis: StaticFactAnalysis,
): void {
  if (access === 'read' || !receivers.every(isIrTypedArrayReceiver)) return;
  const normalizedReceivers = [...new Set(receivers)].sort() as IrTypedArrayReceiver[];
  const widths = [...new Set(normalizedReceivers.map((receiver) => typedArrayElementWidths[receiver]))].sort(
    (left, right) => left - right,
  );
  if (normalizedReceivers.length < 2 || widths.length < 2) return;
  addStaticFact(
    {
      kind: 'mixedWidthIndexedWrite',
      receivers: normalizedReceivers as [IrTypedArrayReceiver, IrTypedArrayReceiver, ...IrTypedArrayReceiver[]],
      widths: widths as [IrTypedArrayElementWidth, IrTypedArrayElementWidth, ...IrTypedArrayElementWidth[]],
    },
    analysis,
  );
}

function addStaticFact(fact: StaticFact, analysis: StaticFactAnalysis, count = 1): void {
  const identity = staticFactIdentity(fact);
  const existing = analysis.counts.get(identity);
  analysis.counts.set(identity, { count: (existing?.count ?? 0) + count, fact });
}

function addTruthinessFact(
  context: CompilerStaticTruthinessContext,
  expression: Readonly<IrExpression>,
  analysis: StaticFactAnalysis,
  domain = getExpressionValueDomain(expression),
): void {
  addStaticFact({ context, domain, kind: 'truthiness' }, analysis);
}

function addTypedArraySetFact(
  receivers: readonly [IrTypedArrayReceiver, ...IrTypedArrayReceiver[]],
  analysis: StaticFactAnalysis,
): void {
  const normalized = [...new Set(receivers)].sort() as [IrTypedArrayReceiver, ...IrTypedArrayReceiver[]];
  addStaticFact({ kind: 'typedArraySet', receivers: normalized }, analysis);
}

function analyzeDeclaration(declaration: Readonly<IrDeclaration>, analysis: StaticFactAnalysis): void {
  switch (declaration.kind) {
    case 'class':
      declaration.classConstructor?.parameters.forEach((parameter) => analyzeInitializer(parameter, analysis));
      declaration.classConstructor?.body.forEach((statement) => analyzeStatement(statement, analysis));
      declaration.fields.forEach((field) => {
        if (field.initializer) analyzeExpression(field.initializer, analysis, 'read');
      });
      declaration.methods.forEach((method) => {
        method.parameters.forEach((parameter) => analyzeInitializer(parameter, analysis));
        method.body.forEach((statement) => analyzeStatement(statement, analysis));
      });
      return;
    case 'function':
      declaration.parameters.forEach((parameter) => analyzeInitializer(parameter, analysis));
      declaration.body.forEach((statement) => analyzeStatement(statement, analysis));
      return;
    case 'variable':
      analyzeVariable(declaration, analysis);
      return;
    case 'enum':
    case 'interface':
    case 'typeAlias':
      return;
  }
}

function analyzeExpression(
  expression: Readonly<IrExpression>,
  analysis: StaticFactAnalysis,
  indexedAccess: CompilerStaticIndexedAccessMode | undefined,
): void {
  switch (expression.kind) {
    case 'array':
      expression.elements.forEach((element) => {
        if (element) analyzeExpression(element, analysis, 'read');
      });
      return;
    case 'assignment': {
      if (expression.operator === '&&=' || expression.operator === '||=') {
        addTruthinessFact('logicalOperand', expression.left, analysis, expression.semantics.left.flow);
      }
      addNumericArithmeticFact(expression, analysis);
      const leftAccess = expression.operator === '=' ? 'write' : 'readWrite';
      analyzeExpression(expression.left, analysis, leftAccess);
      analyzeExpression(expression.right, analysis, 'read');
      return;
    }
    case 'await':
    case 'spread':
      analyzeExpression(expression.expression, analysis, 'read');
      return;
    case 'binary': {
      if (expression.operator === '&&' || expression.operator === '||') {
        addTruthinessFact('logicalOperand', expression.left, analysis, expression.semantics.left.flow);
        addLogicalExpressionFact(expression.operator, expression.semantics, analysis);
      }
      addNumericArithmeticFact(expression, analysis);
      if (
        (expression.operator === '<' ||
          expression.operator === '<=' ||
          expression.operator === '>' ||
          expression.operator === '>=') &&
        expression.semantics.left.flow === expression.semantics.right.flow &&
        (expression.semantics.left.flow === 'bigint' || expression.semantics.left.flow === 'number')
      ) {
        addNumericRelationFact(expression.semantics.left.flow, analysis);
      }
      analyzeExpression(expression.left, analysis, 'read');
      analyzeExpression(expression.right, analysis, 'read');
      return;
    }
    case 'call':
      if (expression.semantics.typedArraySet) {
        addTypedArraySetFact(expression.semantics.typedArraySet.receivers, analysis);
      }
      analyzeExpression(expression.callee, analysis, 'read');
      expression.arguments.forEach((argument) => analyzeExpression(argument, analysis, 'read'));
      return;
    case 'cast':
      analyzeExpression(expression.expression, analysis, indexedAccess);
      return;
    case 'conditional':
      addTruthinessFact('conditionalExpression', expression.condition, analysis);
      analyzeExpression(expression.condition, analysis, 'read');
      analyzeExpression(expression.whenTrue, analysis, 'read');
      analyzeExpression(expression.whenFalse, analysis, 'read');
      return;
    case 'element':
      if (indexedAccess) {
        addIndexedAccessFact(indexedAccess, expression.semantics.receivers, analysis);
        addMixedWidthIndexedWriteFact(indexedAccess, expression.semantics.receivers, analysis);
      }
      analyzeExpression(expression.object, analysis, 'read');
      analyzeExpression(expression.index, analysis, 'read');
      return;
    case 'function':
      expression.parameters.forEach((parameter) => analyzeInitializer(parameter, analysis));
      expression.body.forEach((statement) => analyzeStatement(statement, analysis));
      if (expression.expression) analyzeExpression(expression.expression, analysis, 'read');
      return;
    case 'new':
      analyzeExpression(expression.callee, analysis, 'read');
      expression.arguments.forEach((argument) => analyzeExpression(argument, analysis, 'read'));
      return;
    case 'object':
      expression.members.forEach((member) => {
        if (member.kind === 'computedProperty') analyzeExpression(member.key, analysis, 'read');
        analyzeExpression(member.kind === 'spread' ? member.expression : member.value, analysis, 'read');
      });
      return;
    case 'objectRest':
      analyzeExpression(expression.object, analysis, 'read');
      expression.excluded.forEach((key) => {
        if (key.kind === 'computed') analyzeExpression(key.expression, analysis, 'read');
      });
      return;
    case 'property':
      analyzeExpression(expression.object, analysis, 'read');
      return;
    case 'template':
      expression.parts.forEach((part) => {
        if (typeof part !== 'string') analyzeExpression(part, analysis, 'read');
      });
      return;
    case 'tuple':
      expression.elements.forEach((element) => {
        if (element.expression) analyzeExpression(element.expression, analysis, 'read');
      });
      return;
    case 'tupleSpread':
      expression.segments.forEach((segment) => {
        const value = segment.kind === 'spread' ? segment.expression : segment.element.expression;
        if (value) analyzeExpression(value, analysis, 'read');
      });
      return;
    case 'tupleRest':
      analyzeExpression(expression.object, analysis, 'read');
      return;
    case 'tupleSuffix':
      analyzeExpression(expression.object, analysis, 'read');
      return;
    case 'unary':
      if (expression.operator === '!') {
        addTruthinessFact('negationOperand', expression.operand, analysis, expression.semantics.operand.flow);
      }
      addNumericArithmeticFact(expression, analysis);
      analyzeExpression(
        expression.operand,
        analysis,
        expression.operator === '++' || expression.operator === '--'
          ? 'readWrite'
          : expression.operator === 'delete'
            ? undefined
            : 'read',
      );
      return;
    case 'undefinedDefault':
      analyzeExpression(expression.fallback, analysis, 'read');
      analyzeExpression(expression.value, analysis, 'read');
      return;
    case 'identifier':
    case 'literal':
    case 'regexp':
      return;
  }
}

function analyzeStatement(statement: Readonly<IrStatement>, analysis: StaticFactAnalysis): void {
  switch (statement.kind) {
    case 'block':
      statement.statements.forEach((item) => analyzeStatement(item, analysis));
      return;
    case 'do':
    case 'while':
      addTruthinessFact('controlFlowCondition', statement.condition, analysis);
      analyzeExpression(statement.condition, analysis, 'read');
      analyzeStatement(statement.body, analysis);
      return;
    case 'expression':
    case 'throw':
      analyzeExpression(statement.expression, analysis, 'read');
      return;
    case 'for':
      if (isVariableList(statement.initializer)) {
        statement.initializer.forEach((variable) => analyzeVariable(variable, analysis));
      } else if (statement.initializer) {
        analyzeExpression(statement.initializer, analysis, 'read');
      }
      if (statement.condition) {
        addTruthinessFact('controlFlowCondition', statement.condition, analysis);
        analyzeExpression(statement.condition, analysis, 'read');
      }
      if (statement.increment) analyzeExpression(statement.increment, analysis, 'read');
      analyzeStatement(statement.body, analysis);
      return;
    case 'forIn':
      analyzeVariable(statement.variable, analysis);
      analyzeExpression(statement.object, analysis, 'read');
      analyzeStatement(statement.body, analysis);
      return;
    case 'forOf':
      analyzeVariable(statement.variable, analysis);
      analyzeExpression(statement.iterable, analysis, 'read');
      analyzeStatement(statement.body, analysis);
      return;
    case 'if':
      addTruthinessFact('controlFlowCondition', statement.condition, analysis);
      analyzeExpression(statement.condition, analysis, 'read');
      analyzeStatement(statement.consequent, analysis);
      if (statement.otherwise) analyzeStatement(statement.otherwise, analysis);
      return;
    case 'return':
      if (statement.expression) analyzeExpression(statement.expression, analysis, 'read');
      return;
    case 'switch':
      analyzeExpression(statement.expression, analysis, 'read');
      statement.cases.forEach((item) => {
        if (item.expression) analyzeExpression(item.expression, analysis, 'read');
        item.statements.forEach((caseStatement) => analyzeStatement(caseStatement, analysis));
      });
      return;
    case 'try':
      analyzeStatement(statement.tryBody, analysis);
      if (statement.catchClause) analyzeStatement(statement.catchClause.body, analysis);
      if (statement.finallyBody) analyzeStatement(statement.finallyBody, analysis);
      return;
    case 'variable':
      statement.declarations.forEach((variable) => analyzeVariable(variable, analysis));
      return;
    case 'break':
    case 'continue':
      return;
  }
}

function analyzeVariable(variable: Readonly<IrVariable>, analysis: StaticFactAnalysis): void {
  if ('pattern' in variable) analyzeBindingPattern(variable.pattern, analysis);
  analyzeInitializer(variable, analysis);
}

function analyzeBindingPattern(pattern: Readonly<IrBindingPattern>, analysis: StaticFactAnalysis): void {
  switch (pattern.kind) {
    case 'array':
      pattern.elements.forEach((element) => {
        if (!element) return;
        analyzeBindingPattern(element.pattern, analysis);
        if (element.initializer) analyzeExpression(element.initializer, analysis, 'read');
      });
      if (pattern.rest) analyzeBindingPattern(pattern.rest, analysis);
      return;
    case 'binding':
      return;
  }
}

function compareStaticFacts(left: CompilerStaticFactCount, right: CompilerStaticFactCount): number {
  const leftIdentity = staticFactIdentity(left);
  const rightIdentity = staticFactIdentity(right);
  return leftIdentity === rightIdentity ? 0 : leftIdentity < rightIdentity ? -1 : 1;
}

function createStaticFactAudit(analysis: StaticFactAnalysis, modules: number): CompilerStaticFactAudit {
  return {
    facts: [...analysis.counts.values()]
      .map(({ count, fact }): CompilerStaticFactCount => ({ ...fact, count }) as CompilerStaticFactCount)
      .sort(compareStaticFacts),
    modules,
    schema: 'flight-compiler-static-facts/5',
  };
}

function cloneOperatorOperandDomains(domains: Readonly<IrOperatorOperandDomains>): IrOperatorOperandDomains {
  return { declared: domains.declared, flow: domains.flow };
}

function getExpressionValueDomain(expression: Readonly<IrExpression>): IrOperatorValueDomain {
  switch (expression.kind) {
    case 'array':
    case 'function':
    case 'new':
    case 'object':
    case 'objectRest':
    case 'regexp':
    case 'tuple':
    case 'tupleSpread':
      return 'object';
    case 'assignment':
    case 'binary':
      return expression.semantics.result;
    case 'cast':
      return getExpressionValueDomain(expression.expression);
    case 'conditional': {
      const whenTrue = getExpressionValueDomain(expression.whenTrue);
      return whenTrue === getExpressionValueDomain(expression.whenFalse) ? whenTrue : 'unknown';
    }
    case 'identifier':
      return expression.reference.kind === 'ambient' && expression.reference.name === 'undefined'
        ? 'undefined'
        : expression.reference.kind === 'this'
          ? 'object'
          : 'unknown';
    case 'literal':
      if (expression.value === null) return 'null';
      if (typeof expression.value === 'boolean') return 'boolean';
      if (typeof expression.value === 'number') return 'number';
      return 'string';
    case 'template':
      return 'string';
    case 'tupleRest':
    case 'tupleSuffix':
      return 'object';
    case 'unary':
      return expression.semantics.result;
    case 'undefinedDefault': {
      const fallback = getExpressionValueDomain(expression.fallback);
      const value = getExpressionValueDomain(expression.value);
      return value === 'undefined' || value === fallback ? fallback : 'unknown';
    }
    case 'await':
    case 'call':
    case 'element':
    case 'property':
    case 'spread':
      return 'unknown';
  }
}

function getStaticFactWithoutCount(fact: CompilerStaticFactCount): StaticFact {
  switch (fact.kind) {
    case 'indexedAccess':
      return { access: fact.access, kind: fact.kind, receivers: [...fact.receivers] as typeof fact.receivers };
    case 'logicalExpression':
      return {
        kind: fact.kind,
        left: fact.left,
        operator: fact.operator,
        result: fact.result,
        right: fact.right,
      };
    case 'mixedWidthIndexedWrite':
      return {
        kind: fact.kind,
        receivers: [...fact.receivers] as typeof fact.receivers,
        widths: [...fact.widths] as typeof fact.widths,
      };
    case 'numericArithmetic':
      switch (fact.operation) {
        case 'assignment':
          return {
            kind: fact.kind,
            left: cloneOperatorOperandDomains(fact.left),
            operation: fact.operation,
            operator: fact.operator,
            result: fact.result,
            right: cloneOperatorOperandDomains(fact.right),
          };
        case 'binary':
          return {
            kind: fact.kind,
            left: cloneOperatorOperandDomains(fact.left),
            operation: fact.operation,
            operator: fact.operator,
            result: fact.result,
            right: cloneOperatorOperandDomains(fact.right),
          };
        case 'postfixUnary':
          return {
            kind: fact.kind,
            operand: cloneOperatorOperandDomains(fact.operand),
            operation: fact.operation,
            operator: fact.operator,
            result: fact.result,
          };
        case 'prefixUnary':
          return {
            kind: fact.kind,
            operand: cloneOperatorOperandDomains(fact.operand),
            operation: fact.operation,
            operator: fact.operator,
            result: fact.result,
          };
      }
    case 'numericRelation':
      return { domain: fact.domain, kind: fact.kind };
    case 'truthiness':
      return { context: fact.context, domain: fact.domain, kind: fact.kind };
    case 'typedArraySet':
      return { kind: fact.kind, receivers: [...fact.receivers] as typeof fact.receivers };
  }
}

function isVariableList(value: IrExpression | readonly IrVariable[] | undefined): value is readonly IrVariable[] {
  return Array.isArray(value);
}

function isIrTypedArrayReceiver(value: IrIndexedReceiver): value is IrTypedArrayReceiver {
  return value !== 'array' && value !== 'object' && value !== 'string' && value !== 'tuple' && value !== 'unknown';
}

function analyzeInitializer(
  value: Readonly<{ initializer?: IrExpression | undefined }>,
  analysis: StaticFactAnalysis,
): void {
  if (value.initializer) analyzeExpression(value.initializer, analysis, 'read');
}

function staticFactIdentity(fact: StaticFact): string {
  switch (fact.kind) {
    case 'indexedAccess':
      return JSON.stringify([fact.kind, fact.access, fact.receivers]);
    case 'logicalExpression':
      return JSON.stringify([fact.kind, fact.operator, fact.left, fact.right, fact.result]);
    case 'mixedWidthIndexedWrite':
      return JSON.stringify([fact.kind, fact.receivers, fact.widths]);
    case 'numericArithmetic':
      switch (fact.operation) {
        case 'assignment':
        case 'binary':
          return JSON.stringify([
            fact.kind,
            fact.operation,
            fact.operator,
            fact.left.declared,
            fact.left.flow,
            fact.right.declared,
            fact.right.flow,
            fact.result,
          ]);
        case 'postfixUnary':
        case 'prefixUnary':
          return JSON.stringify([
            fact.kind,
            fact.operation,
            fact.operator,
            fact.operand.declared,
            fact.operand.flow,
            fact.result,
          ]);
      }
    case 'numericRelation':
      return JSON.stringify([fact.kind, fact.domain]);
    case 'truthiness':
      return JSON.stringify([fact.kind, fact.context, fact.domain]);
    case 'typedArraySet':
      return JSON.stringify([fact.kind, fact.receivers]);
  }
}

const typedArrayElementWidths: Readonly<Record<IrTypedArrayReceiver, IrTypedArrayElementWidth>> = {
  bigInt64Array: 64,
  bigUint64Array: 64,
  float32Array: 32,
  float64Array: 64,
  int16Array: 16,
  int32Array: 32,
  int8Array: 8,
  uint16Array: 16,
  uint32Array: 32,
  uint8Array: 8,
  uint8ClampedArray: 8,
};
