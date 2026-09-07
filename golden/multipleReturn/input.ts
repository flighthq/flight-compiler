export function absoluteValue(value: number): number {
  if (value < 0) return -value;
  return value;
}

export function fizzbuzz(n: number): string {
  if (n % 15 === 0) return 'fizzbuzz';
  if (n % 3 === 0) return 'fizz';
  if (n % 5 === 0) return 'buzz';
  return `${n}`;
}

export function boundedIncrement(value: number, max: number): number {
  if (value >= max) return max;
  return value + 1;
}

export function triangleType(a: number, b: number, c: number): string {
  if (a === b && b === c) return 'equilateral';
  if (a === b || b === c || a === c) return 'isosceles';
  return 'scalene';
}
