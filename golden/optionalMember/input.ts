export interface Options {
  readonly retries?: number;
  readonly label: string;
}

export function summarize(options: Options): string {
  const retries = options.retries ?? 0;
  return `${options.label}:${retries}`;
}

export function pick(flag: boolean, first: string, second: string): string {
  return flag ? first : second;
}

export function classify(value: number): string {
  switch (value) {
    case 0:
      return 'zero';
    case 1:
      return 'one';
    default:
      return 'many';
  }
}
