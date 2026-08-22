export interface Holder {
  value: number;
}

export function read(holder: Holder | undefined): number {
  return holder?.value ?? 0;
}
