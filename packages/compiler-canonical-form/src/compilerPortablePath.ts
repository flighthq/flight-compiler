export function normalizePathPortable(value: string): string {
  return value.replaceAll('\\', '/');
}
