import { describe, expect, test } from "bun:test"

import {
  buildAdminSettingsResponse,
  didHttpProxyChange,
  parseAdminSettingsUpdate,
} from "~/routes/admin/settings"

describe("admin settings parsing", () => {
  test("returns persisted proxy settings to the admin UI", () => {
    expect(
      buildAdminSettingsResponse(
        {
          rateLimitSeconds: 5,
          rateLimitWait: true,
          httpProxy: "http://127.0.0.1:7890",
        },
        {},
      ),
    ).toEqual({
      rateLimitSeconds: 5,
      rateLimitWait: true,
      httpProxy: "http://127.0.0.1:7890/",
      envOverride: {
        rateLimitSeconds: false,
        rateLimitWait: false,
      },
    })
  })

  test("ignores invalid persisted proxy values when rendering settings", () => {
    expect(
      buildAdminSettingsResponse(
        {
          httpProxy: "socks5://proxy.local:1080",
        },
        {},
      ).httpProxy,
    ).toBeNull()
  })

  test("normalizes and persists proxy settings on update", () => {
    const result = parseAdminSettingsUpdate(
      {
        rateLimitSeconds: 3,
        rateLimitWait: true,
        httpProxy: " http://proxy.local:8080 ",
      },
      {},
    )

    expect(result).toEqual({
      success: true,
      update: {
        rateLimitSeconds: 3,
        rateLimitWait: true,
        httpProxy: "http://proxy.local:8080/",
        response: {
          rateLimitSeconds: 3,
          rateLimitWait: true,
          httpProxy: "http://proxy.local:8080/",
        },
      },
    })
  })

  test("clears proxy settings with null or an empty string", () => {
    expect(
      parseAdminSettingsUpdate(
        { rateLimitSeconds: null, rateLimitWait: false, httpProxy: null },
        { httpProxy: "http://proxy.local:8080/" },
      ),
    ).toEqual({
      success: true,
      update: {
        rateLimitSeconds: undefined,
        rateLimitWait: false,
        httpProxy: undefined,
        response: {
          rateLimitSeconds: null,
          rateLimitWait: false,
          httpProxy: null,
        },
      },
    })

    expect(
      parseAdminSettingsUpdate(
        { rateLimitSeconds: null, rateLimitWait: false, httpProxy: "" },
        { httpProxy: "http://proxy.local:8080/" },
      ),
    ).toEqual({
      success: true,
      update: {
        rateLimitSeconds: undefined,
        rateLimitWait: false,
        httpProxy: undefined,
        response: {
          rateLimitSeconds: null,
          rateLimitWait: false,
          httpProxy: null,
        },
      },
    })
  })

  test("preserves an existing proxy when old clients omit httpProxy", () => {
    const result = parseAdminSettingsUpdate(
      { rateLimitSeconds: 8, rateLimitWait: false },
      { httpProxy: "http://proxy.local:8080/" },
    )

    expect(result).toEqual({
      success: true,
      update: {
        rateLimitSeconds: 8,
        rateLimitWait: false,
        httpProxy: "http://proxy.local:8080/",
        response: {
          rateLimitSeconds: 8,
          rateLimitWait: false,
          httpProxy: "http://proxy.local:8080/",
        },
      },
    })
  })

  test("rejects invalid rate limit and proxy values", () => {
    expect(
      parseAdminSettingsUpdate(
        { rateLimitSeconds: 0, rateLimitWait: false, httpProxy: null },
        {},
      ),
    ).toEqual({
      success: false,
      message: '"rateLimitSeconds" must be a number greater than 0',
    })

    expect(
      parseAdminSettingsUpdate(
        {
          rateLimitSeconds: null,
          rateLimitWait: false,
          httpProxy: "socks5://proxy.local:1080",
        },
        {},
      ),
    ).toEqual({
      success: false,
      message: '"httpProxy" must use http:// or https://',
    })
  })

  test("detects proxy changes after normalization", () => {
    expect(
      didHttpProxyChange(
        { httpProxy: "http://proxy.local:8080" },
        "http://proxy.local:8080/",
      ),
    ).toBe(false)
    expect(
      didHttpProxyChange(
        { httpProxy: "http://old-proxy.local:8080/" },
        "http://new-proxy.local:8080/",
      ),
    ).toBe(true)
    expect(didHttpProxyChange({ httpProxy: "bad-value" }, undefined)).toBe(
      false,
    )
  })
})
