import { afterEach, describe, expect, mock, test } from "bun:test"

import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"
import type { ModelsResponse } from "~/services/copilot/get-models"

import {
  clearAccountUsageCache,
  getCachedAccountUsage,
  setCachedAccountUsage,
} from "~/lib/account-usage"
import {
  clearCopilotChannel,
  markCopilotChannelRequestFinished,
  markCopilotChannelRequestStarted,
  selectAccountForSession,
  selectCopilotChannelForRequest,
} from "~/lib/copilot-channel-router"
import { RouteUnavailableError } from "~/lib/error"
import {
  addRequestLog,
  clearRequestLogs,
  getRequestLogs,
  REQUEST_LOG_LIMIT,
} from "~/lib/request-log"
import { state, type RuntimeAccount } from "~/lib/state"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"

const nativeFetch = globalThis.fetch
const originalAccounts = state.accounts
const originalAccountType = state.accountType
const originalCopilotToken = state.copilotToken
const originalGithubToken = state.githubToken
const originalModels = state.models
const originalModelSupport = state.modelSupport
const originalVsCodeVersion = state.vsCodeVersion

const account = (id: string, login: string): RuntimeAccount => ({
  id,
  login,
  avatarUrl: "",
  token: `github-${id}`,
  accountType: "individual",
  createdAt: "2026-04-28T00:00:00.000Z",
})

afterEach(() => {
  globalThis.fetch = nativeFetch
  state.accounts = originalAccounts
  state.accountType = originalAccountType
  state.copilotToken = originalCopilotToken
  state.githubToken = originalGithubToken
  state.models = originalModels
  state.modelSupport = originalModelSupport
  state.vsCodeVersion = originalVsCodeVersion
  clearCopilotChannel()
  clearAccountUsageCache()
  clearRequestLogs()
})

describe("Copilot channel routing", () => {
  test("reuses the previous account channel for the same session", () => {
    const accounts = [account("a", "alice"), account("b", "bob")]

    const first = selectAccountForSession(accounts, "session-1", () => 0.99)
    const second = selectAccountForSession(accounts, "session-1", () => 0)

    expect(first?.account.id).toBe("b")
    expect(first?.reason).toBe("random")
    expect(second?.account.id).toBe("b")
    expect(second?.reason).toBe("session")
  })

  test("chooses a random account when there is no prior session route", () => {
    const accounts = [account("a", "alice"), account("b", "bob")]

    const selected = selectAccountForSession(accounts, undefined, () => 0.75)

    expect(selected?.account.id).toBe("b")
    expect(selected?.reason).toBe("random")
  })

  test("uses the selected account token instead of the legacy active token", async () => {
    state.accounts = [account("a", "alice")]
    state.accountType = "business"
    state.githubToken = "legacy-github-token"
    state.copilotToken = "legacy-copilot-token"
    state.vsCodeVersion = "1.0.0"
    setCachedAccountUsage(
      accountUsage({ id: "a", login: "alice", chatRemaining: 10 }),
    )

    const fetchMock = mock(
      (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const url = getFetchUrl(input)
        const headers = init?.headers as Record<string, string>

        if (url === "https://api.github.com/copilot_internal/v2/token") {
          expect(headers.authorization).toBe("token github-a")
          return new Response(
            JSON.stringify({
              token: "copilot-a",
              expires_at: Math.floor(Date.now() / 1000) + 3600,
              refresh_in: 3600,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        }

        expect(url).toBe("https://api.githubcopilot.com/chat/completions")
        expect(headers.Authorization).toBe("Bearer copilot-a")
        return new Response(
          JSON.stringify({ id: "1", object: "chat.completion", choices: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      },
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await createChatCompletions(chatPayload(), { sessionId: "session-a" })

    const logs = getRequestLogs()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(logs).toHaveLength(1)
    expect(logs[0].path).toBe("/chat/completions")
    expect(logs[0].model).toBe("gpt-test")
    expect(logs[0].channel).toMatchObject({
      mode: "account",
      accountId: "a",
      login: "alice",
    })
  })

  test("refreshes a retryable failure on the same account channel", async () => {
    state.accounts = [account("a", "alice")]
    state.vsCodeVersion = "1.0.0"
    setCachedAccountUsage(
      accountUsage({ id: "a", login: "alice", chatRemaining: 10 }),
    )
    let tokenRequestCount = 0
    let copilotRequestCount = 0

    const fetchMock = mock(
      (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const url = getFetchUrl(input)
        const headers = init?.headers as Record<string, string>

        if (url === "https://api.github.com/copilot_internal/v2/token") {
          tokenRequestCount += 1
          expect(headers.authorization).toBe("token github-a")
          return new Response(
            JSON.stringify({
              token: `copilot-a-${tokenRequestCount}`,
              expires_at: Math.floor(Date.now() / 1000) + 3600,
              refresh_in: 3600,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        }

        copilotRequestCount += 1
        expect(url).toBe("https://api.githubcopilot.com/chat/completions")
        if (copilotRequestCount === 1) {
          expect(headers.Authorization).toBe("Bearer copilot-a-1")
          return new Response("expired", { status: 401 })
        }

        expect(headers.Authorization).toBe("Bearer copilot-a-2")
        return new Response(
          JSON.stringify({ id: "1", object: "chat.completion", choices: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      },
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await createChatCompletions(chatPayload(), { sessionId: "session-a" })

    expect(tokenRequestCount).toBe(2)
    expect(copilotRequestCount).toBe(2)
    expect(getRequestLogs()[0].ok).toBe(true)
    expect(getRequestLogs()[0].status).toBe(200)
  })
})

describe("Copilot channel routing eligibility", () => {
  test("filters exhausted chat quota before selecting a channel", async () => {
    state.accounts = [account("a", "alice"), account("b", "bob")]
    setCachedAccountUsage(
      accountUsage({ id: "a", login: "alice", chatRemaining: 0 }),
    )
    setCachedAccountUsage(
      accountUsage({ id: "b", login: "bob", chatRemaining: 5 }),
    )

    const selected = await selectCopilotChannelForRequest({
      path: "/chat/completions",
      model: "gpt-test",
      sessionId: "session-quota",
      random: () => 0,
    })

    expect(selected.mode).toBe("account")
    if (selected.mode === "account") {
      expect(selected.account.id).toBe("b")
      expect(selected.filteredAccounts).toContainEqual({
        accountId: "a",
        login: "alice",
        reason: "quota_exhausted",
      })
    }
  })

  test("treats v1 chat-compatible paths as chat quota usage", async () => {
    for (const path of [
      "/v1/chat/completions",
      "/v1/messages",
      "/v1/responses",
    ]) {
      clearCopilotChannel()
      state.accounts = [account("a", "alice"), account("b", "bob")]
      setCachedAccountUsage(
        accountUsage({ id: "a", login: "alice", chatRemaining: 0 }),
      )
      setCachedAccountUsage(
        accountUsage({ id: "b", login: "bob", chatRemaining: 5 }),
      )

      const selected = await selectCopilotChannelForRequest({
        path,
        model: "gpt-test",
        random: () => 0,
      })

      expect(
        selected.mode === "account" ? selected.account.id : undefined,
      ).toBe("b")
      expect(
        selected.mode === "account" ? selected.quotaBucket : undefined,
      ).toBe("chat")
    }
  })

  test("fails fast with filter details when every account is out of quota", async () => {
    state.accounts = [account("a", "alice"), account("b", "bob")]
    setCachedAccountUsage(
      accountUsage({ id: "a", login: "alice", chatRemaining: 0 }),
    )
    setCachedAccountUsage(
      accountUsage({ id: "b", login: "bob", chatRemaining: 0 }),
    )

    let routeError: unknown
    try {
      await selectCopilotChannelForRequest({
        path: "/v1/chat/completions",
        model: "gpt-test",
      })
    } catch (error) {
      routeError = error
    }

    expect(routeError).toBeInstanceOf(RouteUnavailableError)
    expect((routeError as RouteUnavailableError).type).toBe("quota_exhausted")
    expect((routeError as RouteUnavailableError).details).toEqual([
      {
        accountId: "a",
        login: "alice",
        reason: "quota_exhausted",
      },
      {
        accountId: "b",
        login: "bob",
        reason: "quota_exhausted",
      },
    ])
  })

  test("reports unsupported model when every account is filtered by model support", async () => {
    state.accounts = [account("a", "alice"), account("b", "bob")]
    state.modelSupport = {
      "gpt-test": [],
    }

    let routeError: unknown
    try {
      await selectCopilotChannelForRequest({
        path: "/chat/completions",
        model: "gpt-test",
      })
    } catch (error) {
      routeError = error
    }

    expect(routeError).toBeInstanceOf(RouteUnavailableError)
    expect((routeError as RouteUnavailableError).type).toBe("model_unsupported")
    expect((routeError as RouteUnavailableError).details).toEqual([
      {
        accountId: "a",
        login: "alice",
        reason: "model_unsupported",
      },
      {
        accountId: "b",
        login: "bob",
        reason: "model_unsupported",
      },
    ])
  })
})

describe("Copilot channel routing eligibility filters", () => {
  test("rebinds a session when its previous account has no quota", async () => {
    const accounts = [account("a", "alice"), account("b", "bob")]
    state.accounts = accounts
    setCachedAccountUsage(
      accountUsage({ id: "a", login: "alice", chatRemaining: 1 }),
    )
    setCachedAccountUsage(
      accountUsage({ id: "b", login: "bob", chatRemaining: 5 }),
    )

    const first = await selectCopilotChannelForRequest({
      path: "/chat/completions",
      sessionId: "session-rebind",
      random: () => 0,
    })
    expect(first.mode === "account" ? first.account.id : undefined).toBe("a")

    setCachedAccountUsage(
      accountUsage({ id: "a", login: "alice", chatRemaining: 0 }),
    )
    const second = await selectCopilotChannelForRequest({
      path: "/chat/completions",
      sessionId: "session-rebind",
      random: () => 0,
    })

    expect(second.mode === "account" ? second.account.id : undefined).toBe("b")
    expect(second.mode === "account" ? second.reason : undefined).toBe("random")
  })

  test("filters accounts that do not support the requested model", async () => {
    state.accounts = [account("a", "alice"), account("b", "bob")]
    state.modelSupport = {
      "gpt-test": [
        {
          id: "b",
          login: "bob",
          accountType: "individual",
        },
      ],
    }
    setCachedAccountUsage(
      accountUsage({ id: "a", login: "alice", chatRemaining: 10 }),
    )
    setCachedAccountUsage(
      accountUsage({ id: "b", login: "bob", chatRemaining: 10 }),
    )

    const selected = await selectCopilotChannelForRequest({
      path: "/chat/completions",
      model: "gpt-test",
      random: () => 0,
    })

    expect(selected.mode === "account" ? selected.account.id : undefined).toBe(
      "b",
    )
    expect(
      selected.mode === "account" ? selected.filteredAccounts : [],
    ).toEqual([
      {
        accountId: "a",
        login: "alice",
        reason: "model_unsupported",
      },
    ])
  })

  test("filters premium models by premium interaction quota", async () => {
    state.accounts = [account("a", "alice"), account("b", "bob")]
    state.models = modelsResponse([premiumModel("gpt-test", 2)])
    setCachedAccountUsage(
      accountUsage({
        id: "a",
        login: "alice",
        chatRemaining: 10,
        premiumRemaining: 1,
      }),
    )
    setCachedAccountUsage(
      accountUsage({
        id: "b",
        login: "bob",
        chatRemaining: 10,
        premiumRemaining: 5,
      }),
    )

    const selected = await selectCopilotChannelForRequest({
      path: "/chat/completions",
      model: "gpt-test",
      random: () => 0,
    })

    expect(selected.mode === "account" ? selected.account.id : undefined).toBe(
      "b",
    )
    expect(selected.mode === "account" ? selected.premiumMultiplier : 0).toBe(2)
    expect(
      selected.mode === "account" ? selected.filteredAccounts : [],
    ).toEqual([
      {
        accountId: "a",
        login: "alice",
        reason: "premium_quota_exhausted",
      },
    ])
  })
})

describe("Copilot channel load balancing", () => {
  test("prefers the less busy account when candidates have similar quota", async () => {
    state.accounts = [account("a", "alice"), account("b", "bob")]
    setCachedAccountUsage(
      accountUsage({ id: "a", login: "alice", chatRemaining: 10 }),
    )
    setCachedAccountUsage(
      accountUsage({ id: "b", login: "bob", chatRemaining: 10 }),
    )

    const busySelection = await selectCopilotChannelForRequest({
      path: "/chat/completions",
      random: () => 0,
    })
    expect(
      busySelection.mode === "account" ? busySelection.account.id : "",
    ).toBe("a")

    markCopilotChannelRequestStarted(busySelection)
    try {
      const randomValues = [0, 0.99]
      const selected = await selectCopilotChannelForRequest({
        path: "/chat/completions",
        random: () => randomValues.shift() ?? 0,
      })

      expect(selected.mode === "account" ? selected.account.id : "").toBe("b")
    } finally {
      markCopilotChannelRequestFinished(busySelection)
    }
  })
})

describe("Copilot channel request execution", () => {
  test("reroutes to another account after an upstream rate limit", async () => {
    state.accounts = [account("a", "alice"), account("b", "bob")]
    state.vsCodeVersion = "1.0.0"
    setCachedAccountUsage(
      accountUsage({ id: "a", login: "alice", chatRemaining: 10 }),
    )
    setCachedAccountUsage(
      accountUsage({ id: "b", login: "bob", chatRemaining: 10 }),
    )

    selectAccountForSession(state.accounts, "session-reroute", () => 0)

    const fetchMock = mock(
      (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const url = getFetchUrl(input)
        const headers = init?.headers as Record<string, string>

        if (url === "https://api.github.com/copilot_internal/v2/token") {
          if (headers.authorization === "token github-a") {
            return tokenResponse("copilot-a")
          }
          if (headers.authorization === "token github-b") {
            return tokenResponse("copilot-b")
          }
        }

        expect(url).toBe("https://api.githubcopilot.com/chat/completions")
        if (headers.Authorization === "Bearer copilot-a") {
          return new Response("rate limited", { status: 429 })
        }

        expect(headers.Authorization).toBe("Bearer copilot-b")
        return new Response(
          JSON.stringify({ id: "1", object: "chat.completion", choices: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      },
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await createChatCompletions(chatPayload(), { sessionId: "session-reroute" })

    const logs = getRequestLogs()
    expect(logs[0].channel).toMatchObject({
      mode: "account",
      accountId: "b",
      reason: "reroute_error",
    })
    expect(logs[0].retryCount).toBe(1)
    expect(logs[0].routeAttempts).toEqual([
      expect.objectContaining({ accountId: "a", result: "selected" }),
      expect.objectContaining({ accountId: "a", result: "error", status: 429 }),
      expect.objectContaining({ accountId: "b", result: "selected" }),
      expect.objectContaining({
        accountId: "b",
        result: "success",
        status: 200,
      }),
    ])
  })
})

describe("Copilot channel network retry execution", () => {
  test("reroutes to another account after a network error", async () => {
    state.accounts = [account("a", "alice"), account("b", "bob")]
    state.vsCodeVersion = "1.0.0"
    setCachedAccountUsage(
      accountUsage({ id: "a", login: "alice", chatRemaining: 10 }),
    )
    setCachedAccountUsage(
      accountUsage({ id: "b", login: "bob", chatRemaining: 10 }),
    )

    selectAccountForSession(state.accounts, "session-network-reroute", () => 0)

    const fetchMock = mock(
      (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const url = getFetchUrl(input)
        const headers = init?.headers as Record<string, string>

        if (url === "https://api.github.com/copilot_internal/v2/token") {
          if (headers.authorization === "token github-a") {
            return tokenResponse("copilot-a")
          }
          if (headers.authorization === "token github-b") {
            return tokenResponse("copilot-b")
          }
        }

        expect(url).toBe("https://api.githubcopilot.com/chat/completions")
        if (headers.Authorization === "Bearer copilot-a") {
          throw new Error("network down")
        }

        expect(headers.Authorization).toBe("Bearer copilot-b")
        return new Response(
          JSON.stringify({ id: "1", object: "chat.completion", choices: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      },
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await createChatCompletions(chatPayload(), {
      sessionId: "session-network-reroute",
    })

    const logs = getRequestLogs()
    expect(logs[0].channel).toMatchObject({
      mode: "account",
      accountId: "b",
      reason: "reroute_error",
    })
    expect(logs[0].routeAttempts).toEqual([
      expect.objectContaining({ accountId: "a", result: "selected" }),
      expect.objectContaining({ accountId: "a", result: "error" }),
      expect.objectContaining({ accountId: "b", result: "selected" }),
      expect.objectContaining({
        accountId: "b",
        result: "success",
        status: 200,
      }),
    ])
  })
})

describe("Copilot channel quota retry execution", () => {
  test("reroutes quota failures without refreshing the exhausted account token", async () => {
    state.accounts = [account("a", "alice"), account("b", "bob")]
    state.vsCodeVersion = "1.0.0"
    setCachedAccountUsage(
      accountUsage({ id: "a", login: "alice", chatRemaining: 10 }),
    )
    setCachedAccountUsage(
      accountUsage({ id: "b", login: "bob", chatRemaining: 10 }),
    )

    selectAccountForSession(state.accounts, "session-quota-reroute", () => 0)

    const tokenRequests: Array<string> = []
    const fetchMock = mock(
      (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const url = getFetchUrl(input)
        const headers = init?.headers as Record<string, string>

        if (url === "https://api.github.com/copilot_internal/v2/token") {
          tokenRequests.push(headers.authorization)
          if (headers.authorization === "token github-a") {
            return tokenResponse("copilot-a")
          }
          if (headers.authorization === "token github-b") {
            return tokenResponse("copilot-b")
          }
        }

        expect(url).toBe("https://api.githubcopilot.com/chat/completions")
        if (headers.Authorization === "Bearer copilot-a") {
          return new Response("quota exhausted", { status: 403 })
        }

        expect(headers.Authorization).toBe("Bearer copilot-b")
        return new Response(
          JSON.stringify({ id: "1", object: "chat.completion", choices: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      },
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await createChatCompletions(chatPayload(), {
      sessionId: "session-quota-reroute",
    })

    const logs = getRequestLogs()
    expect(tokenRequests).toEqual(["token github-a", "token github-b"])
    expect(logs[0].channel).toMatchObject({
      mode: "account",
      accountId: "b",
      reason: "reroute_quota",
    })
    expect(logs[0].retryCount).toBe(1)
    expect(logs[0].routeAttempts).toEqual([
      expect.objectContaining({ accountId: "a", result: "selected" }),
      expect.objectContaining({ accountId: "a", result: "error", status: 403 }),
      expect.objectContaining({ accountId: "b", result: "selected" }),
      expect.objectContaining({
        accountId: "b",
        result: "success",
        status: 200,
      }),
    ])
  })

  test("marks quota exhausted when no reroute target remains", async () => {
    state.accounts = [account("a", "alice")]
    state.vsCodeVersion = "1.0.0"
    setCachedAccountUsage(
      accountUsage({ id: "a", login: "alice", chatRemaining: 10 }),
    )

    const fetchMock = mock(
      (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const url = getFetchUrl(input)
        const headers = init?.headers as Record<string, string>

        if (url === "https://api.github.com/copilot_internal/v2/token") {
          expect(headers.authorization).toBe("token github-a")
          return tokenResponse("copilot-a")
        }

        expect(url).toBe("https://api.githubcopilot.com/chat/completions")
        expect(headers.Authorization).toBe("Bearer copilot-a")
        return new Response("quota exhausted", { status: 403 })
      },
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    let requestError: unknown
    try {
      await createChatCompletions(chatPayload(), {
        sessionId: "session-final-quota",
      })
    } catch (error) {
      requestError = error
    }

    const logs = getRequestLogs()
    expect(requestError).toBeInstanceOf(Error)
    expect(getCachedAccountUsage("a")?.quotas.chat?.remaining).toBe(0)
    expect(logs[0].ok).toBe(false)
    expect(logs[0].routeAttempts).toEqual([
      expect.objectContaining({ accountId: "a", result: "selected" }),
      expect.objectContaining({ accountId: "a", result: "error", status: 403 }),
    ])
  })

  test("marks premium quota exhausted without clearing chat quota", async () => {
    state.accounts = [account("a", "alice")]
    state.models = modelsResponse([premiumModel("gpt-test", 2)])
    state.vsCodeVersion = "1.0.0"
    setCachedAccountUsage(
      accountUsage({
        id: "a",
        login: "alice",
        chatRemaining: 10,
        premiumRemaining: 2,
      }),
    )

    const fetchMock = mock(
      (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const url = getFetchUrl(input)
        const headers = init?.headers as Record<string, string>

        if (url === "https://api.github.com/copilot_internal/v2/token") {
          expect(headers.authorization).toBe("token github-a")
          return tokenResponse("copilot-a")
        }

        expect(url).toBe("https://api.githubcopilot.com/chat/completions")
        expect(headers.Authorization).toBe("Bearer copilot-a")
        return new Response("premium quota exhausted", { status: 403 })
      },
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    try {
      await createChatCompletions(chatPayload(), {
        sessionId: "session-premium-quota",
      })
    } catch {
      // Expected: no alternate account remains.
    }

    const cachedUsage = getCachedAccountUsage("a")
    expect(cachedUsage?.quotas.chat?.remaining).toBe(10)
    expect(cachedUsage?.quotas.premium_interactions?.remaining).toBe(0)
  })
})

describe("request logs", () => {
  test("keeps only the latest 100 request records", () => {
    for (let i = 0; i < REQUEST_LOG_LIMIT + 5; i += 1) {
      addRequestLog({
        method: "POST",
        path: `/requests/${i}`,
        channel: { mode: "legacy", reason: "legacy" },
        ok: true,
        durationMs: i,
      })
    }

    const logs = getRequestLogs()

    expect(logs).toHaveLength(REQUEST_LOG_LIMIT)
    expect(logs[0].path).toBe("/requests/104")
    expect(logs.at(-1)?.path).toBe("/requests/5")
  })
})

function chatPayload(): ChatCompletionsPayload {
  return {
    messages: [{ role: "user", content: "hello" }],
    model: "gpt-test",
  }
}

function accountUsage({
  id,
  login,
  chatRemaining,
  premiumRemaining,
}: {
  chatRemaining: number
  id: string
  login: string
  premiumRemaining?: number
}) {
  return {
    id,
    login,
    accountType: "individual" as const,
    status: "ok" as const,
    isFreeLimited: true,
    plan: "individual",
    quotaSource: "limited_user_quotas" as const,
    quotas: {
      chat: {
        id: "chat" as const,
        label: "Chat",
        remaining: chatRemaining,
        entitlement: 10,
        percentRemaining: chatRemaining * 10,
        unlimited: false,
      },
      ...(premiumRemaining !== undefined && {
        premium_interactions: {
          id: "premium_interactions" as const,
          label: "Premium",
          remaining: premiumRemaining,
          entitlement: 10,
          percentRemaining: premiumRemaining * 10,
          unlimited: false,
        },
      }),
    },
  }
}

function modelsResponse(models: ModelsResponse["data"]): ModelsResponse {
  return {
    object: "list",
    data: models,
  }
}

function premiumModel(
  id: string,
  multiplier: number,
): ModelsResponse["data"][number] {
  return {
    billing: {
      is_premium: true,
      multiplier,
    },
    capabilities: {
      family: id,
      limits: {},
      object: "model_capabilities",
      supports: {},
      tokenizer: id,
      type: "chat",
    },
    id,
    model_picker_enabled: true,
    name: id,
    object: "model",
    preview: false,
    vendor: "test",
    version: "1",
  }
}

function tokenResponse(token: string): Response {
  return new Response(
    JSON.stringify({
      token,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_in: 3600,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

function getFetchUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.toString()
  return input.url
}
