export type RuntimeTypes = {
  values: Map<string, number>;
  task: Promise<number>;
  bytes: Uint8Array;
};
