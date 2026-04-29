import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { RuntimeAccount } from "~/lib/state"

import {
  getAccountUsageSummaries,
  normalizeAccountUsage,
} from "~/lib/account-usage"
import { state } from "~/lib/state"

const nativeFetch = globalThis.fetch
const originalGithubToken = state.githubToken
const originalVsCodeVersion = state.vsCodeVersion

beforeEach(() => {
  globalThis.fetch = nativeFetch
  state.githubToken = "legacy-github-token"
  state.vsCodeVersion = "1.0.0"
})

afterEach(() => {
  globalThis.fetch = nativeFetch
  state.githubToken = originalGithubToken
  state.vsCodeVersion = originalVsCodeVersion
})

describe("account usage normalization", () => {
  test("normalizes business quota snapshots", () => {
    const usage = normalizeAccountUsage(account("a", "alice"), {
      access_type_sku: "copilot_for_business_seat_quota",
      analytics_tracking_id: "tracking",
      assigned_date: "2026-04-01T00:00:00Z",
      can_signup_for_limited: false,
      chat_enabled: true,
      copilot_plan: "business",
      organization_login_list: [],
      organization_list: [],
      quota_reset_date: "2026-05-01",
      quota_snapshots: {
        chat: quotaDetail("chat", {
          entitlement: 0,
          percent_remaining: 100,
          quota_remaining: 0,
          remaining: 0,
          unlimited: true,
        }),
        premium_interactions: quotaDetail("premium_interactions", {
          entitlement: 300,
          percent_remaining: -2.9,
          quota_remaining: -8.5,
          remaining: -9,
          unlimited: false,
        }),
      },
    })

    expect(usage).toMatchObject({
      id: "a",
      login: "alice",
      status: "ok",
      isFreeLimited: false,
      quotaSource: "quota_snapshots",
      resetDate: "2026-05-01",
      plan: "business",
      chatEnabled: true,
    })
    expect(usage.quotas.chat).toMatchObject({
      id: "chat",
      remaining: 0,
      entitlement: 0,
      percentRemaining: 100,
      unlimited: true,
    })
    expect(usage.quotas.premium_interactions).toMatchObject({
      id: "premium_interactions",
      remaining: -9,
      entitlement: 300,
      quotaRemaining: -8.5,
      percentRemaining: -2.9,
      unlimited: false,
    })
  })

  test("normalizes free limited account quotas", () => {
    const usage = normalizeAccountUsage(account("b", "bob"), {
      access_type_sku: "free_limited_copilot",
      analytics_tracking_id: "tracking",
      assigned_date: "2026-04-01T00:00:00Z",
      can_signup_for_limited: false,
      chat_enabled: true,
      copilot_plan: "individual",
      limited_user_quotas: {
        chat: 480,
        completions: 4000,
      },
      limited_user_reset_date: "2026-05-28",
      monthly_quotas: {
        chat: 500,
        completions: 4000,
      },
      organization_login_list: [],
      organization_list: [],
    })

    expect(usage).toMatchObject({
      id: "b",
      login: "bob",
      status: "ok",
      isFreeLimited: true,
      quotaSource: "limited_user_quotas",
      resetDate: "2026-05-28",
      plan: "individual",
    })
    expect(usage.quotas.chat).toMatchObject({
      id: "chat",
      remaining: 480,
      entitlement: 500,
      percentRemaining: 96,
      unlimited: false,
    })
    expect(usage.quotas.completions).toMatchObject({
      id: "completions",
      remaining: 4000,
      entitlement: 4000,
      percentRemaining: 100,
      unlimited: false,
    })
    expect(usage.quotas.premium_interactions).toBeUndefined()
  })
})

describe("account usage fetching", () => {
  test("queries every account with its own token without mutating global state", async () => {
    const fetchMock = mock(
      (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        expect(getFetchUrl(input)).toBe(
          "https://api.github.com/copilot_internal/user",
        )

        const authorization = new Headers(init?.headers).get("authorization")
        if (authorization === "token github-a") {
          return usageResponse({
            access_type_sku: "copilot_for_business_seat_quota",
            analytics_tracking_id: "tracking",
            assigned_date: "2026-04-01T00:00:00Z",
            can_signup_for_limited: false,
            chat_enabled: true,
            copilot_plan: "business",
            organization_login_list: [],
            organization_list: [],
            quota_reset_date: "2026-05-01",
            quota_snapshots: {
              chat: quotaDetail("chat", {
                entitlement: 0,
                percent_remaining: 100,
                quota_remaining: 0,
                remaining: 0,
                unlimited: true,
              }),
            },
          })
        }
        if (authorization === "token github-b") {
          return usageResponse({
            access_type_sku: "free_limited_copilot",
            analytics_tracking_id: "tracking",
            assigned_date: "2026-04-01T00:00:00Z",
            can_signup_for_limited: false,
            chat_enabled: true,
            copilot_plan: "individual",
            limited_user_quotas: {
              chat: 480,
            },
            limited_user_reset_date: "2026-05-28",
            monthly_quotas: {
              chat: 500,
            },
            organization_login_list: [],
            organization_list: [],
          })
        }

        throw new Error(`unexpected authorization: ${authorization}`)
      },
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const usages = await getAccountUsageSummaries([
      account("a", "alice"),
      account("b", "bob"),
    ])

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(state.githubToken).toBe("legacy-github-token")
    expect(usages.map((usage) => usage.login)).toEqual(["alice", "bob"])
    expect(usages[0]?.quotaSource).toBe("quota_snapshots")
    expect(usages[1]?.quotaSource).toBe("limited_user_quotas")
    expect(usages[1]?.quotas.chat?.remaining).toBe(480)
  })

  test("keeps per-account errors isolated", async () => {
    const fetchMock = mock(
      (
        _input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const authorization = new Headers(init?.headers).get("authorization")
        if (authorization === "token github-a") {
          return usageResponse({
            access_type_sku: "free_limited_copilot",
            analytics_tracking_id: "tracking",
            assigned_date: "2026-04-01T00:00:00Z",
            can_signup_for_limited: false,
            chat_enabled: true,
            copilot_plan: "individual",
            limited_user_quotas: {
              chat: 1,
            },
            monthly_quotas: {
              chat: 10,
            },
            organization_login_list: [],
            organization_list: [],
          })
        }

        return new Response("bad token", { status: 401 })
      },
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const usages = await getAccountUsageSummaries([
      account("a", "alice"),
      account("b", "bob"),
    ])

    expect(usages[0]?.status).toBe("ok")
    expect(usages[1]).toMatchObject({
      id: "b",
      login: "bob",
      status: "error",
      quotaSource: "unknown",
      quotas: {},
      error: "Failed to get Copilot usage",
    })
  })
})

function account(id: string, login: string): RuntimeAccount {
  return {
    id,
    login,
    avatarUrl: "",
    token: `github-${id}`,
    accountType: "individual",
    createdAt: "2026-04-29T00:00:00.000Z",
  }
}

function quotaDetail(
  quotaId: "chat" | "completions" | "premium_interactions",
  overrides: Partial<{
    entitlement: number
    percent_remaining: number
    quota_remaining: number
    remaining: number
    unlimited: boolean
  }>,
) {
  return {
    entitlement: 0,
    overage_count: 0,
    overage_permitted: false,
    percent_remaining: 0,
    quota_id: quotaId,
    quota_remaining: 0,
    remaining: 0,
    unlimited: false,
    ...overrides,
  }
}

function usageResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function getFetchUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input
  }
  if (input instanceof URL) {
    return input.toString()
  }
  return input.url
}
