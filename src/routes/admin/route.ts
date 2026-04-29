import { Hono } from "hono"

import {
  addAccount,
  getAccounts,
  getActiveAccount,
  removeAccount,
  setActiveAccount,
  type Account,
} from "~/lib/accounts"
import { getConfig, saveConfig } from "~/lib/config"
import { clearCopilotChannel } from "~/lib/copilot-channel-router"
import { copilotTokenManager } from "~/lib/copilot-token-manager"
import { forwardError } from "~/lib/error"
import { isFetchTimeoutError } from "~/lib/fetch-timeout"
import { applyHttpProxyConfig } from "~/lib/proxy"
import { getRequestLogs, REQUEST_LOG_LIMIT } from "~/lib/request-log"
import { state } from "~/lib/state"
import { cacheModels } from "~/lib/utils"
import { getDeviceCode } from "~/services/github/get-device-code"
import { getGitHubUser } from "~/services/github/get-user"
import { pollAccessTokenOnce } from "~/services/github/poll-access-token"

import { adminHtml } from "./html"
import { localOnlyMiddleware } from "./middleware"
import {
  buildAdminSettingsResponse,
  didHttpProxyChange,
  parseAdminSettingsUpdate,
  type AdminSettingsUpdateBody,
} from "./settings"

export const adminRoutes = new Hono()

function shouldRefreshAdminModels(value: string | undefined): boolean {
  return value === "true" || value === "1"
}

function authRequestErrorMessage(fallback: string, error: unknown): string {
  if (isFetchTimeoutError(error)) {
    return `${fallback}: GitHub request timed out. Check the configured HTTP proxy.`
  }

  return fallback
}

// Apply management-route safety middleware to all admin routes
adminRoutes.use("*", localOnlyMiddleware)

// Get all accounts
adminRoutes.get("/api/accounts", async (c) => {
  const data = await getAccounts()

  // Return accounts without tokens for security
  const safeAccounts = data.accounts.map((account) => ({
    id: account.id,
    login: account.login,
    avatarUrl: account.avatarUrl,
    accountType: account.accountType,
    createdAt: account.createdAt,
    isActive: account.id === data.activeAccountId,
  }))

  return c.json({
    activeAccountId: data.activeAccountId,
    accounts: safeAccounts,
  })
})

// Get current active account
adminRoutes.get("/api/accounts/active", async (c) => {
  const account = await getActiveAccount()

  if (!account) {
    return c.json({ account: null })
  }

  return c.json({
    account: {
      id: account.id,
      login: account.login,
      avatarUrl: account.avatarUrl,
      accountType: account.accountType,
      createdAt: account.createdAt,
    },
  })
})

// Switch to a different account
adminRoutes.post("/api/accounts/:id/activate", async (c) => {
  const accountId = c.req.param("id")

  const account = await setActiveAccount(accountId)

  if (!account) {
    return c.json(
      {
        error: {
          message: "Account not found",
          type: "not_found",
        },
      },
      404,
    )
  }

  // Update state with new token
  state.githubToken = account.token
  state.accountType = account.accountType

  // Refresh Copilot token with new account
  try {
    copilotTokenManager.clear()
    await copilotTokenManager.getToken()
  } catch {
    return c.json(
      {
        error: {
          message: "Failed to refresh Copilot token after account switch",
          type: "token_error",
        },
      },
      500,
    )
  }

  return c.json({
    success: true,
    account: {
      id: account.id,
      login: account.login,
      avatarUrl: account.avatarUrl,
      accountType: account.accountType,
    },
  })
})

// Delete an account
adminRoutes.delete("/api/accounts/:id", async (c) => {
  const accountId = c.req.param("id")

  const removed = await removeAccount(accountId)

  if (!removed) {
    return c.json(
      {
        error: {
          message: "Account not found",
          type: "not_found",
        },
      },
      404,
    )
  }

  clearCopilotChannel(accountId)
  state.models = undefined
  state.modelSupport = undefined

  // If we removed the current account, update state
  const activeAccount = await getActiveAccount()
  if (activeAccount) {
    state.githubToken = activeAccount.token
    state.accountType = activeAccount.accountType

    // Refresh Copilot token
    try {
      copilotTokenManager.clear()
      await copilotTokenManager.getToken()
    } catch {
      // Ignore refresh errors on delete
    }
  } else {
    state.githubToken = undefined
    copilotTokenManager.clear()
  }

  return c.json({ success: true })
})

// Initiate device code flow for adding new account
adminRoutes.post("/api/auth/device-code", async (c) => {
  try {
    const response = await getDeviceCode()

    return c.json({
      deviceCode: response.device_code,
      userCode: response.user_code,
      verificationUri: response.verification_uri,
      expiresIn: response.expires_in,
      interval: response.interval,
    })
  } catch (error) {
    return c.json(
      {
        error: {
          message: authRequestErrorMessage("Failed to get device code", error),
          type: "auth_error",
        },
      },
      500,
    )
  }
})

interface PollRequestBody {
  deviceCode: string
  interval: number
  accountType?: string
}

type CreateAccountResult =
  | { success: true; account: Account }
  | { success: false; error: string }

/**
 * Create and save account after successful authorization
 */
/* eslint-disable require-atomic-updates */
async function createAccountFromToken(
  token: string,
  accountType: string,
): Promise<CreateAccountResult> {
  const previousToken = state.githubToken
  state.githubToken = token

  let user
  try {
    user = await getGitHubUser()
  } catch (error) {
    state.githubToken = previousToken
    return {
      success: false,
      error: authRequestErrorMessage("Failed to get user info", error),
    }
  }

  const resolvedAccountType =
    accountType === "business" || accountType === "enterprise" ?
      accountType
    : "individual"

  const account: Account = {
    id: user.id.toString(),
    login: user.login,
    avatarUrl: user.avatar_url,
    token,
    accountType: resolvedAccountType,
    createdAt: new Date().toISOString(),
  }

  await addAccount(account)
  clearCopilotChannel(account.id)
  state.models = undefined
  state.modelSupport = undefined

  state.githubToken = token
  state.accountType = account.accountType

  try {
    copilotTokenManager.clear()
    await copilotTokenManager.getToken()
  } catch {
    // Continue even if Copilot token fails
  }

  return { success: true, account }
}
/* eslint-enable require-atomic-updates */

// Poll for access token after user authorizes

adminRoutes.post("/api/auth/poll", async (c) => {
  const body = await c.req.json<PollRequestBody>()

  if (!body.deviceCode) {
    return c.json(
      {
        error: { message: "deviceCode is required", type: "validation_error" },
      },
      400,
    )
  }

  const result = await pollAccessTokenOnce(body.deviceCode)

  if (result.status === "pending") {
    return c.json({ pending: true, message: "Waiting for user authorization" })
  }

  if (result.status === "slow_down") {
    return c.json({
      pending: true,
      slowDown: true,
      interval: result.interval,
      message: "Rate limited, please slow down",
    })
  }

  if (result.status === "expired") {
    return c.json(
      {
        error: {
          message: "Device code expired. Please start over.",
          type: "expired",
        },
      },
      400,
    )
  }

  if (result.status === "denied") {
    return c.json(
      {
        error: { message: "Authorization was denied by user.", type: "denied" },
      },
      400,
    )
  }

  if (result.status === "error") {
    return c.json({ error: { message: result.error, type: "auth_error" } }, 500)
  }

  const accountResult = await createAccountFromToken(
    result.token,
    body.accountType ?? "individual",
  )

  if (!accountResult.success) {
    return c.json(
      { error: { message: accountResult.error, type: "auth_error" } },
      500,
    )
  }

  return c.json({
    success: true,
    account: {
      id: accountResult.account.id,
      login: accountResult.account.login,
      avatarUrl: accountResult.account.avatarUrl,
      accountType: accountResult.account.accountType,
    },
  })
})

// Get current auth status
adminRoutes.get("/api/auth/status", async (c) => {
  const data = await getAccounts()
  let activeAccount: Account | null = null
  if (data.activeAccountId) {
    activeAccount =
      data.accounts.find((account) => account.id === data.activeAccountId)
      ?? null
  }
  if (!activeAccount && data.accounts.length > 0) {
    activeAccount = data.accounts[0]
  }

  return c.json({
    authenticated:
      Boolean(state.githubToken) && copilotTokenManager.hasValidToken(),
    hasAccounts: data.accounts.length > 0,
    accountCount: data.accounts.length,
    activeAccount:
      activeAccount ?
        {
          id: activeAccount.id,
          login: activeAccount.login,
          avatarUrl: activeAccount.avatarUrl,
          accountType: activeAccount.accountType,
        }
      : null,
  })
})

// Model Mapping API
adminRoutes.get("/api/model-mappings", (c) => {
  const config = getConfig()
  return c.json({ modelMapping: config.modelMapping ?? {} })
})

adminRoutes.get("/api/settings", (c) => {
  const config = getConfig()
  return c.json(buildAdminSettingsResponse(config))
})

adminRoutes.get("/api/request-logs", (c) => {
  return c.json({
    limit: REQUEST_LOG_LIMIT,
    logs: getRequestLogs(),
  })
})

adminRoutes.get("/api/models", async (c) => {
  try {
    if (shouldRefreshAdminModels(c.req.query("refresh")) || !state.models) {
      await cacheModels()
    }

    const models =
      state.models?.data.map((model) => ({
        id: model.id,
        object: "model",
        type: "model",
        created: 0,
        created_at: new Date(0).toISOString(),
        owned_by: model.vendor,
        display_name: model.name,
        model_picker_category: model.model_picker_category,
        billing: model.billing,
        supportedAccounts: state.modelSupport?.[model.id] ?? [],
      })) ?? []

    return c.json({
      object: "list",
      data: models,
      has_more: false,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})

adminRoutes.put("/api/settings", async (c) => {
  const body = await c.req.json<AdminSettingsUpdateBody>()
  const config = getConfig()
  const result = parseAdminSettingsUpdate(body, config)

  if (!result.success) {
    return c.json(
      {
        error: {
          message: result.message,
          type: "validation_error",
        },
      },
      400,
    )
  }

  const { update } = result
  const proxyChanged = didHttpProxyChange(config, update.httpProxy)

  await saveConfig({
    ...config,
    rateLimitSeconds: update.rateLimitSeconds,
    rateLimitWait: update.rateLimitWait,
    httpProxy: update.httpProxy,
  })
  applyHttpProxyConfig(update.httpProxy, {
    useEnvironmentProxy: process.env.PROXY_ENV === "true",
  })
  if (proxyChanged) {
    state.models = undefined
    state.modelSupport = undefined
  }

  state.rateLimitSeconds =
    process.env.RATE_LIMIT === undefined ?
      update.rateLimitSeconds
    : state.rateLimitSeconds
  state.rateLimitWait =
    process.env.RATE_LIMIT_WAIT === undefined ?
      update.rateLimitWait
    : state.rateLimitWait

  return c.json({
    success: true,
    settings: update.response,
  })
})

adminRoutes.put("/api/model-mappings/:from", async (c) => {
  const from = c.req.param("from")
  const body = await c.req.json<{ to: string }>()

  if (!body.to || typeof body.to !== "string") {
    return c.json(
      {
        error: { message: '"to" field is required', type: "validation_error" },
      },
      400,
    )
  }

  const config = getConfig()
  const modelMapping = { ...config.modelMapping, [from]: body.to }
  await saveConfig({ ...config, modelMapping })
  return c.json({ success: true, from, to: body.to })
})

adminRoutes.delete("/api/model-mappings/:from", async (c) => {
  const from = c.req.param("from")
  const config = getConfig()

  if (!config.modelMapping || !(from in config.modelMapping)) {
    return c.json(
      { error: { message: "Mapping not found", type: "not_found" } },
      404,
    )
  }

  const { [from]: _removed, ...rest } = config.modelMapping
  await saveConfig({ ...config, modelMapping: rest })
  return c.json({ success: true })
})

// Serve static HTML for admin UI
adminRoutes.get("/", (c) => {
  return c.html(adminHtml)
})
