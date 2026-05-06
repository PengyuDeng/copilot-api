import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { RuntimeAccount } from "~/lib/state"
import type { ModelsResponse } from "~/services/copilot/get-models"

import { clearCopilotChannel } from "~/lib/copilot-channel-router"
import { copilotTokenManager } from "~/lib/copilot-token-manager"
import { clearRequestLogs } from "~/lib/request-log"
import { state } from "~/lib/state"
import { adminRoutes } from "~/routes/admin/route"

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
    model("cached-model", {
      is_premium: true,
      multiplier: 2,
      restricted_to: ["copilot_pro"],
    }),
    model("gpt-4o-mini"),
  ],
}

interface AdminModelSupportAccount {
  id: string
  login: string
  accountType: RuntimeAccount["accountType"]
}

interface AdminModelsBody {
  data: Array<{
    billing?: {
      is_premium: boolean
      multiplier: number
      restricted_to?: Array<unknown>
    }
    freeLimitedChat: boolean
    id: string
    model_picker_category?: string
    supportedAccounts: Array<AdminModelSupportAccount>
  }>
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

describe("admin models API", () => {
  test("returns model support account metadata from cache", async () => {
    state.modelSupport = {
      "cached-model": [
        {
          id: "a",
          login: "alice",
          accountType: "individual",
        },
      ],
    }

    const response = await adminRoutes.fetch(createLocalAdminRequest())
    const body = (await response.json()) as AdminModelsBody

    expect(response.status).toBe(200)
    expect(body.data.map((model) => model.id)).toEqual([
      "cached-model",
      "gpt-4o-mini",
    ])
    expect(body.data[0]?.billing).toEqual({
      is_premium: true,
      multiplier: 2,
      restricted_to: ["copilot_pro"],
    })
    expect(body.data[0]?.freeLimitedChat).toBe(false)
    expect(body.data[1]?.freeLimitedChat).toBe(true)
    expect(body.data[0]?.model_picker_category).toBe("test-category")
    expect(getSupportByModel(body)).toEqual({
      "cached-model": [
        {
          id: "a",
          login: "alice",
          accountType: "individual",
        },
      ],
      "gpt-4o-mini": [],
    })
  })

  test("refresh=true reloads support metadata from all accounts", async () => {
    state.accounts = [account("a", "alice"), account("b", "bob")]

    const fetchMock = mock(
      (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const url = getFetchUrl(input)
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
          return modelsResponse([
            model("alice-model", {
              is_premium: true,
              multiplier: 3,
            }),
            model("shared-model"),
          ])
        }
        if (authorization === "Bearer copilot-b") {
          return modelsResponse([model("bob-model"), model("shared-model")])
        }

        throw new Error(`unexpected request: ${url}`)
      },
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await adminRoutes.fetch(
      createLocalAdminRequest("/api/models?refresh=true"),
    )
    const body = (await response.json()) as AdminModelsBody

    expect(response.status).toBe(200)
    expect(body.data.map((model) => model.id)).toEqual([
      "alice-model",
      "bob-model",
      "shared-model",
    ])
    expect(
      body.data.find((model) => model.id === "alice-model")?.billing,
    ).toEqual({
      is_premium: true,
      multiplier: 3,
    })
    expect(getSupportByModel(body)).toEqual({
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
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
})

function getSupportByModel(
  body: AdminModelsBody,
): Record<string, Array<AdminModelSupportAccount>> {
  const supportByModel: Record<string, Array<AdminModelSupportAccount>> = {}

  for (const model of body.data) {
    supportByModel[model.id] = model.supportedAccounts
  }

  return supportByModel
}

function createLocalAdminRequest(path = "/api/models"): Request {
  return new Request(`http://localhost${path}`, {
    headers: {
      host: "localhost:4141",
    },
  })
}

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

function model(
  id: string,
  billing?: ModelsResponse["data"][number]["billing"],
): ModelsResponse["data"][number] {
  return {
    billing,
    capabilities: {
      family: id,
      limits: {},
      object: "model_capabilities",
      supports: {},
      tokenizer: id,
      type: "chat",
    },
    id,
    model_picker_category: "test-category",
    model_picker_enabled: true,
    name: id,
    object: "model",
    preview: false,
    vendor: "test-vendor",
    version: "1",
  }
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
