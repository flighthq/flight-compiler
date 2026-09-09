// Pointing the compiler at a directory, as data rather than as process state.
//
// The filesystem and the output stream arrive as capabilities so that the decision layer — which
// modules to compile, what to report, what to exit with — can be exercised without a disk.
import type { CompilerPackageCompilationRefusalCode } from './compilerPackageCompilationContract.js';

export interface CompilerCommandLineRequest {
  readonly argv: readonly string[];
}

export interface CompilerCommandLineSource {
  readonly contents: string;
  /** How the module is named in a report; the source path relative to the directory compiled. */
  readonly moduleName: string;
  readonly sourcePath: string;
}

export interface CompilerCommandLineCapabilities {
  readonly listSourceFiles: (directory: string) => readonly CompilerCommandLineSource[];
  readonly write: (text: string) => void;
  readonly writeError: (text: string) => void;
  readonly writeOutputFile: (directory: string, relativePath: string, contents: string) => void;
}

export interface CompilerCommandLineRefusal {
  readonly code: CompilerPackageCompilationRefusalCode;
  readonly column?: number | undefined;
  readonly line?: number | undefined;
  readonly module: string;
  readonly reason: string;
  readonly stage: 'dependency' | 'emission' | 'initialization' | 'lowering';
}

export interface CompilerCommandLineResult {
  readonly emitted: number;
  readonly exitCode: number;
  readonly refusals: readonly CompilerCommandLineRefusal[];
}
