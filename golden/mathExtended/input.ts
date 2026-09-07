export function circleArea(radius: number): number {
  return Math.PI * radius * radius;
}

export function hypotenuse(a: number, b: number): number {
  return Math.sqrt(a * a + b * b);
}

export function ceilDivide(numerator: number, denominator: number): number {
  return Math.ceil(numerator / denominator);
}

export function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function signOf(value: number): number {
  return Math.sign(value);
}
