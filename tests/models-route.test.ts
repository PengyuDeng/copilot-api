import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { ModelsResponse } from "~/services/copilot/get-models"

import { copilotTokenManager } from "~/lib/copilot-token-manager"
import { state } from "~/lib/state"
import { shouldRefreshModels } from "~/routes/models/route"
import { server } from "~/server"

const nativeFetch = globalThis.fetch
const originalAccountType = state.accountType
const originalCopilotToken = state.copilotToken
const originalModels = state.models
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
  state.accountType = "individual"
  state.copilotToken = "valid-copilot-token"
  state.models = cachedModels
  state.vsCodeVersion = "1.0.0"
  tokenManager.tokenExpiresAt = Math.floor(Date.now() / 1000) + 3600
})

afterEach(() => {
  globalThis.fetch = nativeFetch
  state.accountType = originalAccountType
  state.copilotToken = originalCopilotToken
  state.models = originalModels
  state.vsCodeVersion = originalVsCodeVersion
  tokenManager.tokenExpiresAt = 0
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
    const body = (await response.json()) as { data: Array<{ id: string }> }

    expect(response.status).toBe(200)
    expect(body.data.map((model) => model.id)).toEqual(["cached-model"])
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
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
