import { afterEach, describe, expect, test } from "bun:test"

import { FetchTimeoutError, fetchWithTimeout } from "~/lib/fetch-timeout"

const nativeFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = nativeFetch
})

describe("fetchWithTimeout", () => {
  test("aborts stalled fetches with a timeout error", async () => {
    globalThis.fetch = ((
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("Aborted"))
        })
      })) as unknown as typeof fetch

    let caughtError: unknown
    try {
      await fetchWithTimeout("https://github.com", {}, 5)
    } catch (error) {
      caughtError = error
    }

    expect(caughtError).toBeInstanceOf(FetchTimeoutError)
  })

  test("passes through successful fetch responses", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response("ok"))) as unknown as typeof fetch

    const response = await fetchWithTimeout("https://github.com", {}, 100)

    expect(await response.text()).toBe("ok")
  })
})
