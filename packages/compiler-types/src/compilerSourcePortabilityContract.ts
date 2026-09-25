import type { CompilerSourceFingerprint } from './compilerSourceFingerprint.js';
import type { CompilerModuleIdentity } from './compilerSourceIdentity.js';

export interface CompilerSourcePortabilityFinding {
  readonly column: number;
  readonly fingerprint: CompilerSourceFingerprint;
  readonly identity: string;
  readonly line: number;
  readonly message: string;
  readonly module: CompilerModuleIdentity;
  readonly rule: CompilerSourcePortabilityRule;
  /** Stable declaration/member path, or the nearest named declaration for an expression finding. */
  readonly subject: string;
}

export interface CompilerSourcePortabilityAcceptedException {
  readonly finding: CompilerSourcePortabilityFinding;
  readonly reason: string;
}

export interface CompilerSourcePortabilityAnalysisOptions {
  readonly exceptionPolicy?: Readonly<CompilerSourcePortabilityExceptionPolicy> | undefined;
}

export interface CompilerSourcePortabilityExceptionPolicy {
  readonly exceptions: readonly CompilerSourcePortabilityExceptionRecord[];
  readonly schema: 'flight-compiler-source-portability-exceptions/1';
}

export interface CompilerSourcePortabilityExceptionRecord {
  readonly findingIdentity: string;
  readonly reason: string;
  readonly rule: CompilerSourcePortabilityRule;
}

export interface CompilerSourcePortabilityReport {
  readonly acceptedExceptions: readonly CompilerSourcePortabilityAcceptedException[];
  readonly findings: readonly CompilerSourcePortabilityFinding[];
  readonly schema: 'flight-compiler-source-portability/1';
}

export type CompilerSourcePortabilityRule = 'mixed-absence' | 'opaque-value-domain' | 'unchecked-double-assertion';
