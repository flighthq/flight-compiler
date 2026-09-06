export function timestamp(when: Date): number {
  return when.getTime();
}

export function year(when: Date): number {
  return when.getFullYear();
}

export function format(when: Date): string {
  return when.toISOString();
}
