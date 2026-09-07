export function square(x: number): number {
  return x ** 2;
}

export function cube(x: number): number {
  return x ** 3;
}

export function nthPower(base: number, exp: number): number {
  return base ** exp;
}

export function squareRoot(x: number): number {
  return x ** 0.5;
}

export function accumPower(base: number, exp: number): number {
  let result: number = base;
  result **= exp;
  return result;
}
