// Pointing the compiler at a directory, as data rather than as process state.
//
// The filesystem and the output stream arrive as capabilities so that the decision layer — which
// modules to compile, what to report, what to exit with — can be exercised without a disk.
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
  readonly module: string;
  readonly reason: string;
}

export interface CompilerCommandLineResult {
  readonly emitted: number;
  readonly exitCode: number;
  readonly refusals: readonly CompilerCommandLineRefusal[];
}
