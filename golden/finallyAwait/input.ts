export async function attempt(task: Promise<number>): Promise<number> {
  let result: number = 0;
  let done: boolean = false;
  try {
    result = await task;
  } finally {
    done = true;
  }
  return done ? result : result;
}
