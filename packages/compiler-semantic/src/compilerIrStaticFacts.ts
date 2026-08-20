import type {
  CompilerStaticFactAudit,
  CompilerStaticFactCount,
  CompilerStaticIndexedAccessMode,
  CompilerStaticTruthinessContext,
  IrDeclaration,
  IrExpression,
  IrModule,
  IrOperatorValueDomain,
  IrStatement,
  IrVariable,
} from '../../compiler-types/src/index.js';

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
  | Readonly<{ access: CompilerStaticIndexedAccessMode; kind: 'indexedAccess' }>;

export function analyzeIrModulesStaticFacts(modules: readonly Readonly<IrModule>[]): CompilerStaticFactAudit {
  const analysis: StaticFactAnalysis = { counts: new Map() };
  for (const module of modules) {
    for (const declaration of module.declarations) analyzeDeclaration(declaration, analysis);
    for (const item of module.exports) {
      if (item.kind === 'default') analyzeExpression(item.expression, analysis, 'read');
    }
  }
  return {
    facts: [...analysis.counts.values()]
      .map(({ count, fact }): CompilerStaticFactCount => ({ ...fact, count }) as CompilerStaticFactCount)
      .sort(compareStaticFacts),
    modules: modules.length,
    schema: 'flight-compiler-static-facts/1',
  };
}

function addIndexedAccessFact(access: CompilerStaticIndexedAccessMode, analysis: StaticFactAnalysis): void {
  addStaticFact({ access, kind: 'indexedAccess' }, analysis);
}

function addNumericRelationFact(domain: 'bigint' | 'number', analysis: StaticFactAnalysis): void {
  addStaticFact({ domain, kind: 'numericRelation' }, analysis);
}

function addStaticFact(fact: StaticFact, analysis: StaticFactAnalysis): void {
  const identity = staticFactIdentity(fact);
  const existing = analysis.counts.get(identity);
  analysis.counts.set(identity, { count: (existing?.count ?? 0) + 1, fact });
}

function addTruthinessFact(
  context: CompilerStaticTruthinessContext,
  expression: Readonly<IrExpression>,
  analysis: StaticFactAnalysis,
  domain = getExpressionValueDomain(expression),
): void {
  addStaticFact({ context, domain, kind: 'truthiness' }, analysis);
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
  indexedAccess: CompilerStaticIndexedAccessMode,
): void {
  switch (expression.kind) {
    case 'array':
      expression.elements.forEach((element) => {
        if (element) analyzeExpression(element, analysis, 'read');
      });
      return;
    case 'assignment': {
      if (expression.operator === '&&=' || expression.operator === '||=') {
        addTruthinessFact('logical', expression.left, analysis, expression.semantics.left);
      }
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
        addTruthinessFact('logical', expression.left, analysis, expression.semantics.left);
      }
      if (
        (expression.operator === '<' ||
          expression.operator === '<=' ||
          expression.operator === '>' ||
          expression.operator === '>=') &&
        expression.semantics.left === expression.semantics.right &&
        (expression.semantics.left === 'bigint' || expression.semantics.left === 'number')
      ) {
        addNumericRelationFact(expression.semantics.left, analysis);
      }
      analyzeExpression(expression.left, analysis, 'read');
      analyzeExpression(expression.right, analysis, 'read');
      return;
    }
    case 'call':
      analyzeExpression(expression.callee, analysis, 'read');
      expression.arguments.forEach((argument) => analyzeExpression(argument, analysis, 'read'));
      return;
    case 'cast':
      analyzeExpression(expression.expression, analysis, indexedAccess);
      return;
    case 'conditional':
      addTruthinessFact('condition', expression.condition, analysis);
      analyzeExpression(expression.condition, analysis, 'read');
      analyzeExpression(expression.whenTrue, analysis, 'read');
      analyzeExpression(expression.whenFalse, analysis, 'read');
      return;
    case 'element':
      addIndexedAccessFact(indexedAccess, analysis);
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
    case 'property':
      analyzeExpression(expression.object, analysis, 'read');
      return;
    case 'template':
      expression.parts.forEach((part) => {
        if (typeof part !== 'string') analyzeExpression(part, analysis, 'read');
      });
      return;
    case 'unary':
      if (expression.operator === '!') {
        addTruthinessFact('negation', expression.operand, analysis, expression.semantics.operand);
      }
      analyzeExpression(
        expression.operand,
        analysis,
        expression.operator === '++' || expression.operator === '--'
          ? 'readWrite'
          : expression.operator === 'delete'
            ? 'write'
            : 'read',
      );
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
      addTruthinessFact('condition', statement.condition, analysis);
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
        addTruthinessFact('condition', statement.condition, analysis);
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
      addTruthinessFact('condition', statement.condition, analysis);
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
  analyzeInitializer(variable, analysis);
}

function compareStaticFacts(left: CompilerStaticFactCount, right: CompilerStaticFactCount): number {
  return staticFactIdentity(left).localeCompare(staticFactIdentity(right));
}

function getExpressionValueDomain(expression: Readonly<IrExpression>): IrOperatorValueDomain {
  switch (expression.kind) {
    case 'array':
    case 'function':
    case 'new':
    case 'object':
    case 'regexp':
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
    case 'unary':
      return expression.semantics.result;
    case 'await':
    case 'call':
    case 'element':
    case 'property':
    case 'spread':
      return 'unknown';
  }
}

function isVariableList(value: IrExpression | readonly IrVariable[] | undefined): value is readonly IrVariable[] {
  return Array.isArray(value);
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
      return `${fact.kind}\0${fact.access}`;
    case 'numericRelation':
      return `${fact.kind}\0${fact.domain}`;
    case 'truthiness':
      return `${fact.kind}\0${fact.context}\0${fact.domain}`;
  }
}
