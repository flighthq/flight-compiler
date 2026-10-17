export async function attempt(task: Promise<number>, fallback: number, log: number[]): Promise<number> {
  try {
    return await task;
  } catch {
    return fallback;
  } finally {
    log.push(1);
  }
}
