import { afterEach, describe, expect, mock, test } from "bun:test"

import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"

import {
  clearCopilotChannel,
  selectAccountForSession,
} from "~/lib/copilot-channel-router"
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
  state.vsCodeVersion = originalVsCodeVersion
  clearCopilotChannel()
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

function getFetchUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.toString()
  return input.url
}
