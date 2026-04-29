export const GITHUB_FETCH_TIMEOUT_MS = 15_000

export class FetchTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`)
    this.name = "FetchTimeoutError"
    this.timeoutMs = timeoutMs
  }
}

export async function fetchWithTimeout(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1] = {},
  timeoutMs: number = GITHUB_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  const externalSignal = init.signal

  const abortFromExternalSignal = () => {
    controller.abort(externalSignal?.reason)
  }

  if (externalSignal?.aborted) {
    abortFromExternalSignal()
  } else {
    externalSignal?.addEventListener("abort", abortFromExternalSignal, {
      once: true,
    })
  }

  const timeout = setTimeout(() => {
    controller.abort(new FetchTimeoutError(timeoutMs))
  }, timeoutMs)

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    })
  } catch (error) {
    if (controller.signal.reason instanceof FetchTimeoutError) {
      throw controller.signal.reason
    }
    throw error
  } finally {
    clearTimeout(timeout)
    externalSignal?.removeEventListener("abort", abortFromExternalSignal)
  }
}

export function isFetchTimeoutError(
  error: unknown,
): error is FetchTimeoutError {
  return error instanceof FetchTimeoutError
}
