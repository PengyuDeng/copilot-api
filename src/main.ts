#!/usr/bin/env node

import consola from "consola"
import { serve, type ServerHandler } from "srvx"

import { getAccounts, getActiveAccount, type Account } from "./lib/accounts"
import { mergeConfigWithDefaults } from "./lib/config"
import { copilotTokenManager } from "./lib/copilot-token-manager"
import {
  getLocalAccessPassword,
  getLocalAccessUsername,
  getServerHost,
  LOCAL_ACCESS_MODE,
} from "./lib/local-security"
import { ensurePaths } from "./lib/paths"
import { applyHttpProxyConfig, initProxyFromEnv } from "./lib/proxy"
import { state } from "./lib/state"
import { cacheModels, cacheVSCodeVersion } from "./lib/utils"

// Configuration from environment variables
const PORT = Number.parseInt(process.env.PORT || "4141", 10)
const VERBOSE = process.env.VERBOSE === "true" || process.env.DEBUG === "true"
const RATE_LIMIT =
  process.env.RATE_LIMIT ?
    Number.parseInt(process.env.RATE_LIMIT, 10)
  : undefined
const RATE_LIMIT_WAIT = process.env.RATE_LIMIT_WAIT === "true"
const SHOW_TOKEN = process.env.SHOW_TOKEN === "true"
const PROXY_ENV = process.env.PROXY_ENV === "true"

async function main(): Promise<void> {
  // Ensure config is merged with defaults at startup
  const config = mergeConfigWithDefaults()

  try {
    applyHttpProxyConfig(config.httpProxy, {
      useEnvironmentProxy: PROXY_ENV,
    })
  } catch (error) {
    consola.warn(
      "Configured HTTP proxy ignored:",
      error instanceof Error ? error.message : String(error),
    )
    if (PROXY_ENV) {
      initProxyFromEnv()
    }
  }

  state.verbose = VERBOSE
  if (VERBOSE) {
    consola.level = 5
    consola.info("Verbose logging enabled")
  }

  state.rateLimitSeconds = RATE_LIMIT ?? config.rateLimitSeconds
  state.rateLimitWait =
    process.env.RATE_LIMIT_WAIT === undefined ?
      (config.rateLimitWait ?? false)
    : RATE_LIMIT_WAIT
  state.showToken = SHOW_TOKEN

  await ensurePaths()
  await cacheVSCodeVersion()

  const accountsData = await getAccounts()
  state.accounts = accountsData.accounts

  // Try to load active account from config
  const activeAccount = await getActiveAccount()

  if (activeAccount) {
    setActiveAccountState(activeAccount)
  } else {
    consola.warn("No account configured. Visit /admin to add an account.")
  }

  const serverUrl = `http://localhost:${PORT}`
  const serverHost = getServerHost()

  if (process.env.LOCAL_ACCESS_MODE === LOCAL_ACCESS_MODE.CONTAINER_BRIDGE) {
    if (!getLocalAccessPassword()) {
      throw new Error(
        "LOCAL_ACCESS_PASSWORD is required when LOCAL_ACCESS_MODE=container-bridge",
      )
    }

    consola.warn(
      `LOCAL_ACCESS_MODE=container-bridge is only safe when the host port is published to 127.0.0.1 and protected with Basic auth username "${getLocalAccessUsername()}".`,
    )
  }

  consola.box(`copilot-api server\n\n📋 Account Manager: ${serverUrl}/admin`)

  const { server } = await import("./server")

  serve({
    fetch: server.fetch as ServerHandler,
    port: PORT,
    hostname: serverHost,
    bun: {
      idleTimeout: 0,
    },
  })

  startBackgroundAccountWarmup(activeAccount)
}

main().catch((error: unknown) => {
  consola.error("Failed to start server:", error)
  process.exit(1)
})

function setActiveAccountState(account: Account): void {
  state.githubToken = account.token
  state.accountType = account.accountType

  if (state.showToken) {
    consola.info("GitHub token:", account.token)
  }
}

function startBackgroundAccountWarmup(activeAccount: Account | null): void {
  if (!activeAccount) {
    return
  }

  void warmupAccountsInBackground(activeAccount).catch((error: unknown) => {
    consola.error("Background account warmup failed:", error)
  })
}

async function warmupAccountsInBackground(
  activeAccount: Account,
): Promise<void> {
  const accountCount = state.accounts?.length ?? 0
  consola.info(
    `Loaded ${accountCount} account(s). Warming Copilot tokens and models in background...`,
  )

  const [tokenResult, modelsResult] = await Promise.allSettled([
    copilotTokenManager.getToken(),
    cacheModels(),
  ])

  if (tokenResult.status === "rejected") {
    consola.warn(
      `Failed to warm active account token for ${activeAccount.login}:`,
      tokenResult.reason,
    )
  }

  if (modelsResult.status === "rejected") {
    throw modelsResult.reason
  }

  consola.info(
    `Copilot warmup ready for ${activeAccount.login}: ${state.models?.data.length ?? 0} model(s) cached.`,
  )
}
