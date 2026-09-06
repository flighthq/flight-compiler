export function throwMessage(message: string): never {
  throw new Error(message);
}

export function tryCatch(action: () => void): string {
  try {
    action();
    return 'ok';
  } catch {
    return 'caught';
  }
}
