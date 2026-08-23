package flighthq._internal;

// The `task` capability of `flight-runtime-contract/2`, in the smallest shape that lets a target
// compiler check emitted source and a harness run it. The maintained implementation lives
// downstream; this stands in for it so the gates check the compiler, not the runtime.
//
// It defers to the JavaScript promise because the compile and oracle lanes both target JavaScript,
// and because settlement order is exactly what an async lowering has to preserve — reimplementing it
// here would be testing this file rather than the compiler.
abstract _Promise<T>(js.lib.Promise<T>) {
  public inline function new(executor:(T -> Void) -> (Dynamic -> Void) -> Void) {
    this = new js.lib.Promise<T>((resolve, reject) -> executor(value -> resolve(value), error -> reject(error)));
  }

  public static inline function resolve<T>(value:Dynamic):_Promise<T> {
    return cast js.lib.Promise.resolve(value);
  }

  public static inline function reject<T>(error:Dynamic):_Promise<T> {
    return cast js.lib.Promise.reject(error);
  }

  public inline function then<U>(onValue:T -> Void, ?onError:Dynamic -> Void):_Promise<U> {
    return cast this.then((value) -> onValue(value), (error) -> if (onError != null) onError(error) else throw error);
  }
}
