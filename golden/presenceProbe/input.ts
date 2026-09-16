export function hasSharedMemory(): boolean {
  return typeof SharedArrayBuffer !== 'undefined';
}

export function lacksSharedMemory(): boolean {
  return typeof SharedArrayBuffer === 'undefined';
}

export function sharedMemoryKind(): string {
  return typeof SharedArrayBuffer;
}
