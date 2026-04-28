import consola from "consola"

import { getCopilotToken } from "~/services/github/get-copilot-token"

import type { RuntimeAccount } from "./state"

import { state } from "./state"

export type CopilotChannelReason = "session" | "random" | "legacy"

export interface AccountChannelSelection {
  mode: "account"
  account: RuntimeAccount
  reason: Exclude<CopilotChannelReason, "legacy">
}

export interface LegacyChannelSelection {
  mode: "legacy"
  reason: "legacy"
}

export type CopilotChannelSelection =
  | AccountChannelSelection
  | LegacyChannelSelection

interface AccountTokenState {
  copilotToken?: string
  tokenExpiresAt: number
  refreshPromise: Promise<string> | null
  refreshTimer: ReturnType<typeof setTimeout> | null
}

const sessionAccountIds = new Map<string, string>()
const accountTokenStates = new Map<string, AccountTokenState>()

const getAccountTokenState = (accountId: string): AccountTokenState => {
  const existing = accountTokenStates.get(accountId)
  if (existing) return existing

  const created: AccountTokenState = {
    tokenExpiresAt: 0,
    refreshPromise: null,
    refreshTimer: null,
  }
  accountTokenStates.set(accountId, created)
  return created
}

const getConfiguredAccounts = (): Array<RuntimeAccount> => state.accounts ?? []

const pruneSessionAccounts = (accounts: Array<RuntimeAccount>): void => {
  const accountIds = new Set(accounts.map((account) => account.id))
  for (const [sessionId, accountId] of sessionAccountIds.entries()) {
    if (!accountIds.has(accountId)) {
      sessionAccountIds.delete(sessionId)
    }
  }
}

export function selectAccountForSession(
  accounts: Array<RuntimeAccount>,
  sessionId: string | undefined,
  random: () => number = Math.random,
): AccountChannelSelection | null {
  if (accounts.length === 0) return null

  pruneSessionAccounts(accounts)

  if (sessionId) {
    const existingAccountId = sessionAccountIds.get(sessionId)
    const existingAccount = accounts.find(
      (account) => account.id === existingAccountId,
    )
    if (existingAccount) {
      return {
        mode: "account",
        account: existingAccount,
        reason: "session",
      }
    }
  }

  const randomIndex = Math.min(
    Math.floor(random() * accounts.length),
    accounts.length - 1,
  )
  const account = accounts[randomIndex]
  if (sessionId) {
    sessionAccountIds.set(sessionId, account.id)
  }

  return {
    mode: "account",
    account,
    reason: "random",
  }
}

export function selectCopilotChannel(
  sessionId: string | undefined,
): CopilotChannelSelection {
  const accountSelection = selectAccountForSession(
    getConfiguredAccounts(),
    sessionId,
  )

  return accountSelection ?? { mode: "legacy", reason: "legacy" }
}

export async function getCopilotTokenForChannel(
  selection: CopilotChannelSelection,
): Promise<string | undefined> {
  if (selection.mode === "legacy") return state.copilotToken

  const tokenState = getAccountTokenState(selection.account.id)
  const now = Date.now() / 1000
  if (!tokenState.copilotToken || tokenState.tokenExpiresAt - now < 60) {
    tokenState.refreshPromise ??= refreshAccountToken(
      selection.account,
      tokenState,
    ).finally(() => {
      tokenState.refreshPromise = null
    })
    return await tokenState.refreshPromise
  }

  return tokenState.copilotToken
}

export async function refreshCopilotTokenForChannel(
  selection: CopilotChannelSelection,
): Promise<string | undefined> {
  if (selection.mode === "legacy") return state.copilotToken

  const tokenState = getAccountTokenState(selection.account.id)
  tokenState.copilotToken = undefined
  tokenState.tokenExpiresAt = 0
  tokenState.refreshPromise = refreshAccountToken(
    selection.account,
    tokenState,
  ).finally(() => {
    tokenState.refreshPromise = null
  })
  return await tokenState.refreshPromise
}

async function refreshAccountToken(
  account: RuntimeAccount,
  tokenState: AccountTokenState,
): Promise<string> {
  consola.debug(`[CopilotChannel] Refreshing token for ${account.login}`)
  const { token, expires_at, refresh_in } = await getCopilotToken({
    githubToken: account.token,
    vsCodeVersion: state.vsCodeVersion,
  })

  tokenState.copilotToken = token
  tokenState.tokenExpiresAt = expires_at

  scheduleAccountRefresh(account, tokenState, refresh_in)

  return token
}

function scheduleAccountRefresh(
  account: RuntimeAccount,
  tokenState: AccountTokenState,
  refreshIn: number,
): void {
  if (tokenState.refreshTimer) {
    clearTimeout(tokenState.refreshTimer)
    tokenState.refreshTimer = null
  }

  const refreshMs = Math.max((refreshIn - 60) * 1000, 60000)
  tokenState.refreshTimer = setTimeout(async () => {
    try {
      await refreshAccountToken(account, tokenState)
    } catch (error) {
      consola.error(
        `[CopilotChannel] Auto-refresh failed for ${account.login}:`,
        error,
      )
      clearTokenState(tokenState)
    }
  }, refreshMs)
}

function clearTokenState(tokenState: AccountTokenState): void {
  tokenState.copilotToken = undefined
  tokenState.tokenExpiresAt = 0
}

export function clearCopilotChannel(accountId?: string): void {
  const ids =
    accountId === undefined ? [...accountTokenStates.keys()] : [accountId]

  for (const id of ids) {
    const tokenState = accountTokenStates.get(id)
    if (tokenState?.refreshTimer) {
      clearTimeout(tokenState.refreshTimer)
    }
    accountTokenStates.delete(id)
  }

  if (accountId === undefined) {
    sessionAccountIds.clear()
    return
  }

  for (const [sessionId, mappedAccountId] of sessionAccountIds.entries()) {
    if (mappedAccountId === accountId) {
      sessionAccountIds.delete(sessionId)
    }
  }
}
