import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { RuntimeAccount } from "~/lib/state"
import type { ModelsResponse } from "~/services/copilot/get-models"

import { clearCopilotChannel } from "~/lib/copilot-channel-router"
import { copilotTokenManager } from "~/lib/copilot-token-manager"
import { clearRequestLogs, getRequestLogs } from "~/lib/request-log"
import { state } from "~/lib/state"
import { shouldRefreshModels } from "~/routes/models/route"
import { server } from "~/server"

const nativeFetch = globalThis.fetch
const originalAccounts = state.accounts
const originalAccountType = state.accountType
const originalCopilotToken = state.copilotToken
const originalModels = state.models
const originalModelSupport = state.modelSupport
const originalVsCodeVersion = state.vsCodeVersion
const tokenManager = copilotTokenManager as unknown as {
  tokenExpiresAt: number
}

const cachedModels: ModelsResponse = {
  object: "list",
  data: [
    {
      capabilities: {
        family: "cached",
        limits: {},
        object: "model_capabilities",
        supports: {},
        tokenizer: "cached",
        type: "chat",
      },
      id: "cached-model",
      billing: {
        is_premium: true,
        multiplier: 7.5,
      },
      model_picker_category: "powerful",
      model_picker_enabled: true,
      name: "Cached Model",
      object: "model",
      preview: false,
      vendor: "cached-vendor",
      version: "1",
    },
  ],
}

const refreshedModels: ModelsResponse = {
  object: "list",
  data: [
    {
      capabilities: {
        family: "refreshed",
        limits: {},
        object: "model_capabilities",
        supports: {},
        tokenizer: "refreshed",
        type: "chat",
      },
      id: "refreshed-model",
      model_picker_enabled: true,
      name: "Refreshed Model",
      object: "model",
      preview: false,
      vendor: "refreshed-vendor",
      version: "1",
    },
  ],
}

beforeEach(() => {
  globalThis.fetch = nativeFetch
  state.accounts = undefined
  state.accountType = "individual"
  state.copilotToken = "valid-copilot-token"
  state.models = cachedModels
  state.modelSupport = undefined
  state.vsCodeVersion = "1.0.0"
  tokenManager.tokenExpiresAt = Math.floor(Date.now() / 1000) + 3600
  clearCopilotChannel()
  clearRequestLogs()
})

afterEach(() => {
  globalThis.fetch = nativeFetch
  state.accounts = originalAccounts
  state.accountType = originalAccountType
  state.copilotToken = originalCopilotToken
  state.models = originalModels
  state.modelSupport = originalModelSupport
  state.vsCodeVersion = originalVsCodeVersion
  tokenManager.tokenExpiresAt = 0
  clearCopilotChannel()
  clearRequestLogs()
})

describe("model routes", () => {
  test("recognizes explicit model refresh query values", () => {
    expect(shouldRefreshModels("true")).toBe(true)
    expect(shouldRefreshModels("1")).toBe(true)
    expect(shouldRefreshModels("false")).toBe(false)
    expect(shouldRefreshModels(undefined)).toBe(false)
  })

  test("uses cached models by default", async () => {
    const fetchMock = mock(() => {
      throw new Error("unexpected outbound model request")
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await server.request("http://localhost/v1/models")
    const body = (await response.json()) as {
      data: Array<{
        billing?: unknown
        id: string
        model_picker_category?: unknown
      }>
    }

    expect(response.status).toBe(200)
    expect(body.data.map((model) => model.id)).toEqual(["cached-model"])
    expect(body.data[0]).not.toHaveProperty("billing")
    expect(body.data[0]).not.toHaveProperty("model_picker_category")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("refresh=true reloads models even when cache exists", async () => {
    const fetchMock = mock((input: Parameters<typeof fetch>[0]) => {
      let url: string
      if (typeof input === "string") {
        url = input
      } else if (input instanceof URL) {
        url = input.toString()
      } else {
        url = input.url
      }

      expect(url).toBe("https://api.githubcopilot.com/models")
      return new Response(JSON.stringify(refreshedModels), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await server.request(
      "http://localhost/v1/models?refresh=true",
    )
    const body = (await response.json()) as { data: Array<{ id: string }> }

    expect(response.status).toBe(200)
    expect(body.data.map((model) => model.id)).toEqual(["refreshed-model"])
    expect(state.models).toEqual(refreshedModels)
    expect(state.modelSupport).toEqual({})
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("refresh=true reloads and merges models from all accounts", async () => {
    state.accounts = [account("a", "alice"), account("b", "bob")]

    const fetchMock = mock(
      (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        let url: string
        if (typeof input === "string") {
          url = input
        } else if (input instanceof URL) {
          url = input.toString()
        } else {
          url = input.url
        }
        const authorization = new Headers(init?.headers).get("authorization")

        if (url === "https://api.github.com/copilot_internal/v2/token") {
          if (authorization === "token github-a") {
            return tokenResponse("copilot-a")
          }
          if (authorization === "token github-b") {
            return tokenResponse("copilot-b")
          }
        }

        expect(url).toBe("https://api.githubcopilot.com/models")
        if (authorization === "Bearer copilot-a") {
          return modelsResponse([model("alice-model"), model("shared-model")])
        }
        if (authorization === "Bearer copilot-b") {
          return modelsResponse([model("bob-model"), model("shared-model")])
        }

        throw new Error(`unexpected request: ${url}`)
      },
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await server.request(
      "http://localhost/v1/models?refresh=true",
    )
    const body = (await response.json()) as {
      data: Array<{
        billing?: unknown
        id: string
        model_picker_category?: unknown
        supportedAccounts?: unknown
      }>
    }

    expect(response.status).toBe(200)
    expect(body.data.map((model) => model.id)).toEqual([
      "alice-model",
      "bob-model",
      "shared-model",
    ])
    expect(state.models?.data.map((model) => model.id)).toEqual([
      "alice-model",
      "bob-model",
      "shared-model",
    ])
    expect(state.modelSupport).toEqual({
      "alice-model": [
        {
          id: "a",
          login: "alice",
          accountType: "individual",
        },
      ],
      "bob-model": [
        {
          id: "b",
          login: "bob",
          accountType: "individual",
        },
      ],
      "shared-model": [
        {
          id: "a",
          login: "alice",
          accountType: "individual",
        },
        {
          id: "b",
          login: "bob",
          accountType: "individual",
        },
      ],
    })
    expect(body.data.every((model) => !("supportedAccounts" in model))).toBe(
      true,
    )
    expect(body.data.every((model) => !("billing" in model))).toBe(true)
    expect(
      body.data.every((model) => !("model_picker_category" in model)),
    ).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    const loggedChannels = getRequestLogs().map((log) => log.channel)
    expect(loggedChannels).toHaveLength(2)
    expect(loggedChannels).toContainEqual({
      mode: "account",
      accountId: "a",
      login: "alice",
      accountType: "individual",
      reason: "models",
    })
    expect(loggedChannels).toContainEqual({
      mode: "account",
      accountId: "b",
      login: "bob",
      accountType: "individual",
      reason: "models",
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

function model(id: string): ModelsResponse["data"][number] {
  return {
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
    vendor: "test-vendor",
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

function modelsResponse(models: ModelsResponse["data"]): Response {
  return new Response(JSON.stringify({ object: "list", data: models }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}
