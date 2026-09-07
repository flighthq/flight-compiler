export function circleArea(radius: number): number {
  const pi: number = 3.141592653589793;
  return pi * radius * radius;
}

export function celsiusToFahrenheit(celsius: number): number {
  const factor: number = 9 / 5;
  const offset: number = 32;
  return celsius * factor + offset;
}

export function hypotenuse(a: number, b: number): number {
  const sumSquares: number = a * a + b * b;
  return Math.sqrt(sumSquares);
}

export function formatPair(first: string, second: string): string {
  const separator: string = ' - ';
  return first + separator + second;
}
