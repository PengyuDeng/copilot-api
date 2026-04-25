import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  configureHttpProxy,
  getActiveHttpProxy,
  normalizeHttpProxyUrl,
  resetHttpProxyForTests,
} from "~/lib/proxy"

const nativeFetch = Bun.fetch

beforeEach(() => {
  resetHttpProxyForTests()
  globalThis.fetch = nativeFetch
})

afterEach(() => {
  resetHttpProxyForTests()
  globalThis.fetch = nativeFetch
})

describe("HTTP proxy configuration", () => {
  test("normalizes valid HTTP proxy URLs", () => {
    expect(normalizeHttpProxyUrl(" http://127.0.0.1:7890 ")).toBe(
      "http://127.0.0.1:7890/",
    )
    expect(normalizeHttpProxyUrl("https://user:pass@proxy.local:8443")).toBe(
      "https://user:pass@proxy.local:8443/",
    )
    expect(normalizeHttpProxyUrl("")).toBeUndefined()
    expect(normalizeHttpProxyUrl(null)).toBeUndefined()
  })

  test("rejects invalid or ambiguous proxy URLs", () => {
    expect(() => normalizeHttpProxyUrl(123)).toThrow(
      '"httpProxy" must be a string or null',
    )
    expect(() => normalizeHttpProxyUrl("proxy.local:7890")).toThrow(
      '"httpProxy" must use http:// or https://',
    )
    expect(() => normalizeHttpProxyUrl("socks5://proxy.local:1080")).toThrow(
      '"httpProxy" must use http:// or https://',
    )
    expect(() => normalizeHttpProxyUrl("http://proxy.local:7890/path")).toThrow(
      '"httpProxy" must not include a path, query, or fragment',
    )
  })

  test("routes all Bun fetch requests through the configured proxy", async () => {
    let targetHits = 0
    let proxyHits = 0
    let proxiedUrl = ""

    const target = Bun.serve({
      port: 0,
      fetch() {
        targetHits += 1
        return new Response("direct")
      },
    })
    const proxy = Bun.serve({
      port: 0,
      fetch(request) {
        proxyHits += 1
        proxiedUrl = request.url
        return new Response("proxied")
      },
    })

    try {
      configureHttpProxy(`http://127.0.0.1:${proxy.port}`)

      const response = await fetch(
        `http://127.0.0.1:${target.port}/copilot?x=1`,
      )

      expect(await response.text()).toBe("proxied")
      expect(getActiveHttpProxy()).toBe(`http://127.0.0.1:${proxy.port}/`)
      expect(proxyHits).toBe(1)
      expect(targetHits).toBe(0)
      expect(proxiedUrl).toBe(`http://127.0.0.1:${target.port}/copilot?x=1`)
    } finally {
      await proxy.stop(true)
      await target.stop(true)
    }
  })

  test("clears the configured proxy and resumes direct fetches", async () => {
    let targetHits = 0
    let proxyHits = 0

    const target = Bun.serve({
      port: 0,
      fetch() {
        targetHits += 1
        return new Response("direct")
      },
    })
    const proxy = Bun.serve({
      port: 0,
      fetch() {
        proxyHits += 1
        return new Response("proxied")
      },
    })

    try {
      configureHttpProxy(`http://127.0.0.1:${proxy.port}`)
      configureHttpProxy(null)

      const response = await fetch(`http://127.0.0.1:${target.port}/direct`)

      expect(await response.text()).toBe("direct")
      expect(getActiveHttpProxy()).toBeUndefined()
      expect(proxyHits).toBe(0)
      expect(targetHits).toBe(1)
    } finally {
      await proxy.stop(true)
      await target.stop(true)
    }
  })
})
