/** The owner whose change can resolve a direct package-compilation refusal. */
export type CompilerRefusalClassification =
  | 'compiler-defect'
  | 'compiler-restriction'
  | 'source-portability'
  | 'target-runtime'
  | 'unclassified';
