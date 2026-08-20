import type { IrOperatorValueDomain } from './compilerOperatorSemanticIntermediateRepresentation.js';

export type CompilerStaticTruthinessContext = 'condition' | 'logical' | 'negation';

export type CompilerStaticIndexedAccessMode = 'read' | 'readWrite' | 'write';

export type CompilerStaticFactCount =
  | Readonly<{
      count: number;
      domain: IrOperatorValueDomain;
      kind: 'truthiness';
      context: CompilerStaticTruthinessContext;
    }>
  | Readonly<{
      count: number;
      domain: 'bigint' | 'number';
      kind: 'numericRelation';
    }>
  | Readonly<{
      access: CompilerStaticIndexedAccessMode;
      count: number;
      kind: 'indexedAccess';
    }>;

export interface CompilerStaticFactAudit {
  readonly facts: readonly CompilerStaticFactCount[];
  readonly modules: number;
  readonly schema: 'flight-compiler-static-facts/1';
}
