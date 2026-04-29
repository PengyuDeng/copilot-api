import consola from "consola"

import { getModels, type ModelsResponse } from "~/services/copilot/get-models"
import { getVSCodeVersion } from "~/services/get-vscode-version"

import { state, type ModelSupportAccount, type RuntimeAccount } from "./state"

export const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export const isNullish = (value: unknown): value is null | undefined =>
  value === null || value === undefined

export async function cacheModels(): Promise<void> {
  const accounts = state.accounts ?? []

  if (accounts.length === 0) {
    const models = await getModels()
    setCachedModels(models, {})
    return
  }

  const result = await getModelsForAccounts(accounts)
  setCachedModels(result.models, result.modelSupport)
}

function setCachedModels(
  models: ModelsResponse,
  modelSupport: Record<string, Array<ModelSupportAccount>>,
): void {
  state.models = models
  state.modelSupport = modelSupport
}

async function getModelsForAccounts(accounts: Array<RuntimeAccount>): Promise<{
  models: ModelsResponse
  modelSupport: Record<string, Array<ModelSupportAccount>>
}> {
  const results = await Promise.allSettled(
    accounts.map((account) =>
      getModels({
        mode: "account",
        account,
        reason: "models",
      }),
    ),
  )
  const fulfilled = results.flatMap((result, index) => {
    const account = accounts[index]

    if (result.status !== "fulfilled") {
      return []
    }

    return [{ account, models: result.value }]
  })

  if (fulfilled.length === 0) {
    const errors: Array<unknown> = results
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      .map((result): unknown => result.reason)

    throw new AggregateError(errors, "Failed to load models from all accounts")
  }

  for (const result of results) {
    if (result.status === "rejected") {
      consola.warn("Failed to load models from one account:", result.reason)
    }
  }

  return mergeModelResponses(fulfilled)
}

function mergeModelResponses(
  responses: Array<{
    account: RuntimeAccount
    models: ModelsResponse
  }>,
): {
  models: ModelsResponse
  modelSupport: Record<string, Array<ModelSupportAccount>>
} {
  const modelsById = new Map<string, ModelsResponse["data"][number]>()
  const modelSupport = new Map<string, Array<ModelSupportAccount>>()

  for (const response of responses) {
    const supportAccount = toModelSupportAccount(response.account)

    for (const model of response.models.data) {
      if (!modelsById.has(model.id)) {
        modelsById.set(model.id, model)
      }

      const accounts = modelSupport.get(model.id) ?? []
      if (!accounts.some((account) => account.id === supportAccount.id)) {
        accounts.push(supportAccount)
      }
      modelSupport.set(model.id, accounts)
    }
  }

  return {
    models: {
      object: responses[0]?.models.object ?? "list",
      data: sortModelsById([...modelsById.values()]),
    },
    modelSupport: Object.fromEntries(
      [...modelSupport.entries()].map(([modelId, accounts]) => [
        modelId,
        sortModelSupportAccounts(accounts),
      ]),
    ),
  }
}

function toModelSupportAccount(account: RuntimeAccount): ModelSupportAccount {
  return {
    id: account.id,
    login: account.login,
    accountType: account.accountType,
  }
}

function sortModelsById(
  models: Array<ModelsResponse["data"][number]>,
): Array<ModelsResponse["data"][number]> {
  return models.sort((a, b) =>
    a.id.localeCompare(b.id, undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  )
}

function sortModelSupportAccounts(
  accounts: Array<ModelSupportAccount>,
): Array<ModelSupportAccount> {
  return accounts.sort((a, b) =>
    a.login.localeCompare(b.login, undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  )
}

export const cacheVSCodeVersion = async () => {
  const response = await getVSCodeVersion()
  state.vsCodeVersion = response

  consola.info(`Using VSCode version: ${response}`)
}
