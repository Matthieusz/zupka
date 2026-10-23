import { Effect, Result } from "effect";

/**
 * Runs a service-free program on Effect's existing default runtime.
 * Expected failures reject with E (not FiberFailure); defects and interruption
 * retain Effect's runtime rejection. The caller owns cancellation via signal.
 */
export async function runEffect<A, E>(
  program: Effect.Effect<A, E>,
  signal?: AbortSignal,
): Promise<A> {
  signal?.throwIfAborted();

  const result = await Effect.runPromise(Effect.result(program), { signal });

  if (Result.isFailure(result)) {
    throw result.failure;
  }

  return result.success;
}
