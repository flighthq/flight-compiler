import { analyzeIrModuleTraversal, getIrModuleTraversalPathValue } from '../../compiler-ir-traversal/src/index.js';
import type {
  CompilerIrTraversalPath,
  CompilerStaticFactAudit,
  CompilerStaticFactCount,
  CompilerStaticIndexedAccessMode,
  CompilerStaticNumericArithmeticFact,
  CompilerStaticTruthinessContext,
  IrBinaryOperator,
  IrBinaryOperatorSemantics,
  IrExpression,
  IrIndexedReceiver,
  IrModule,
  IrOperatorOperandDomains,
  IrOperatorValueDomain,
  IrStatement,
  IrTypedArrayElementWidth,
  IrTypedArrayReceiver,
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
    analyzeIrModuleTraversal(module, {
      expression(expression, path) {
        analyzeIrExpressionStaticFacts(expression, analysis, getIrExpressionIndexedAccessModeStaticFacts(module, path));
      },
      statement(statement) {
        analyzeIrStatementStaticFacts(statement, analysis);
      },
    });
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

function analyzeIrExpressionStaticFacts(
  expression: Readonly<IrExpression>,
  analysis: StaticFactAnalysis,
  indexedAccess: CompilerStaticIndexedAccessMode | undefined,
): void {
  switch (expression.kind) {
    case 'assignment': {
      if (expression.operator === '&&=' || expression.operator === '||=') {
        addTruthinessFact('logicalOperand', expression.left, analysis, expression.semantics.left.flow);
      }
      addNumericArithmeticFact(expression, analysis);
      return;
    }
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
      return;
    }
    case 'call':
      if (expression.semantics.typedArraySet) {
        addTypedArraySetFact(expression.semantics.typedArraySet.receivers, analysis);
      }
      return;
    case 'conditional':
      addTruthinessFact('conditionalExpression', expression.condition, analysis);
      return;
    case 'element':
      if (indexedAccess) {
        addIndexedAccessFact(indexedAccess, expression.semantics.receivers, analysis);
        addMixedWidthIndexedWriteFact(indexedAccess, expression.semantics.receivers, analysis);
      }
      return;
    case 'unary':
      if (expression.operator === '!') {
        addTruthinessFact('negationOperand', expression.operand, analysis, expression.semantics.operand.flow);
      }
      addNumericArithmeticFact(expression, analysis);
      return;
    case 'array':
    case 'await':
    case 'cast':
    case 'function':
    case 'identifier':
    case 'literal':
    case 'new':
    case 'object':
    case 'objectRest':
    case 'property':
    case 'regexp':
    case 'spread':
    case 'template':
    case 'tuple':
    case 'tupleRest':
    case 'tupleSpread':
    case 'tupleSuffix':
    case 'undefinedDefault':
    case 'undefinedValue':
      return;
    default:
      assertNeverIrStaticFacts(expression);
  }
}

function analyzeIrStatementStaticFacts(statement: Readonly<IrStatement>, analysis: StaticFactAnalysis): void {
  switch (statement.kind) {
    case 'do':
    case 'while':
      addTruthinessFact('controlFlowCondition', statement.condition, analysis);
      return;
    case 'for':
      if (statement.condition) {
        addTruthinessFact('controlFlowCondition', statement.condition, analysis);
      }
      return;
    case 'if':
      addTruthinessFact('controlFlowCondition', statement.condition, analysis);
      return;
    case 'block':
    case 'break':
    case 'continue':
    case 'expression':
    case 'forIn':
    case 'forOf':
    case 'return':
    case 'switch':
    case 'throw':
    case 'try':
    case 'variable':
      return;
    default:
      assertNeverIrStaticFacts(statement);
  }
}

function getIrExpressionIndexedAccessModeStaticFacts(
  module: Readonly<IrModule>,
  path: CompilerIrTraversalPath,
): CompilerStaticIndexedAccessMode | undefined {
  let currentPath = path;
  while (currentPath.length > 0) {
    const relation = currentPath.at(-1);
    const parentPath = currentPath.slice(0, -1);
    const parent = getIrModuleTraversalPathValue(module, parentPath);
    if (!isIrExpressionStaticFactParent(parent)) return 'read';
    if (parent.kind === 'cast' && relation === 'expression') {
      currentPath = parentPath;
      continue;
    }
    if (parent.kind === 'assignment' && relation === 'left') {
      return parent.operator === '=' ? 'write' : 'readWrite';
    }
    if (parent.kind === 'unary' && relation === 'operand') {
      if (parent.operator === '++' || parent.operator === '--') return 'readWrite';
      return parent.operator === 'delete' ? undefined : 'read';
    }
    return 'read';
  }
  return 'read';
}

function isIrExpressionStaticFactParent(value: unknown): value is Readonly<IrExpression> {
  return typeof value === 'object' && value !== null && 'kind' in value && typeof value.kind === 'string';
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
        : expression.reference.kind === 'super' || expression.reference.kind === 'this'
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
    case 'undefinedValue':
      return 'undefined';
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

function isIrTypedArrayReceiver(value: IrIndexedReceiver): value is IrTypedArrayReceiver {
  return value !== 'array' && value !== 'object' && value !== 'string' && value !== 'tuple' && value !== 'unknown';
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

function assertNeverIrStaticFacts(value: never): never {
  const kind = (value as { readonly kind?: unknown }).kind;
  throw new TypeError(`Unknown neutral IR kind ${String(kind)}`);
}
