import consola from "consola"

import type { CopilotQuotaId } from "~/services/github/get-copilot-usage"

import { getCopilotToken } from "~/services/github/get-copilot-token"

import type { RuntimeAccount } from "./state"

import {
  clearAccountUsageCache,
  estimateAccountQuotaUse,
  getAccountUsageCached,
  getCachedAccountUsage,
  getQuotaPercentRemaining,
  hasRemainingQuota,
  markAccountQuotaExhausted,
} from "./account-usage"
import { RouteUnavailableError } from "./error"
import { state } from "./state"

export type CopilotChannelReason =
  | "legacy"
  | "models"
  | "random"
  | "reroute_error"
  | "reroute_quota"
  | "session"

export type RouteFilterReason =
  | "cooldown"
  | "model_unsupported"
  | "premium_quota_exhausted"
  | "quota_exhausted"
  | "usage_unavailable"

export interface RouteFilteredAccount {
  accountId: string
  login: string
  reason: RouteFilterReason
}

export interface AccountChannelSelection {
  mode: "account"
  account: RuntimeAccount
  reason: Exclude<CopilotChannelReason, "legacy">
  filteredAccounts?: Array<RouteFilteredAccount>
  premiumMultiplier?: number
  quotaBucket?: CopilotQuotaId
  routeReason?: CopilotChannelReason
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

interface AccountRouteState {
  cooldownReason?: string
  cooldownUntilMs: number
  inFlight: number
  recentFailures: number
}

interface RouteRequestContext {
  excludedAccountIds?: ReadonlySet<string>
  model?: string
  nowMs?: number
  path?: string
  random?: () => number
  rerouteReason?: Extract<
    CopilotChannelReason,
    "reroute_error" | "reroute_quota"
  >
  sessionId?: string
}

interface RouteCandidate {
  account: RuntimeAccount
  usageKnown: boolean
}

interface RouteCandidates {
  candidates: Array<RouteCandidate>
  filteredAccounts: Array<RouteFilteredAccount>
  premiumMultiplier: number
  quotaBucket?: CopilotQuotaId
}

const sessionAccountIds = new Map<string, string>()
const accountTokenStates = new Map<string, AccountTokenState>()
const accountRouteStates = new Map<string, AccountRouteState>()

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

const getAccountRouteState = (accountId: string): AccountRouteState => {
  const existing = accountRouteStates.get(accountId)
  if (existing) return existing

  const created: AccountRouteState = {
    cooldownUntilMs: 0,
    inFlight: 0,
    recentFailures: 0,
  }
  accountRouteStates.set(accountId, created)
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

export async function selectCopilotChannelForRequest(
  context: RouteRequestContext = {},
): Promise<CopilotChannelSelection> {
  const accounts = getConfiguredAccounts()

  if (accounts.length === 0) {
    return { mode: "legacy", reason: "legacy" }
  }

  pruneSessionAccounts(accounts)

  const routeCandidates = await getRouteCandidates(accounts, context)

  if (routeCandidates.candidates.length === 0) {
    throw new RouteUnavailableError(
      "No account is available for this Copilot request",
      getRouteUnavailableType(routeCandidates.filteredAccounts),
      routeCandidates.filteredAccounts.map((account) => ({
        accountId: account.accountId,
        login: account.login,
        reason: account.reason,
      })),
    )
  }

  const existingSelection = getReusableSessionSelection(
    routeCandidates,
    context.sessionId,
  )
  if (existingSelection) {
    return existingSelection
  }

  const reason = context.rerouteReason ?? "random"
  const selected = selectWeightedRandomCandidate(
    routeCandidates.candidates,
    routeCandidates.quotaBucket,
    context.random ?? Math.random,
  )

  if (context.sessionId) {
    sessionAccountIds.set(context.sessionId, selected.account.id)
  }

  return {
    mode: "account",
    account: selected.account,
    reason,
    routeReason: reason,
    filteredAccounts: routeCandidates.filteredAccounts,
    premiumMultiplier: routeCandidates.premiumMultiplier,
    quotaBucket: routeCandidates.quotaBucket,
  }
}

export async function selectCopilotChannel(
  sessionId: string | undefined,
): Promise<CopilotChannelSelection> {
  const accountSelection = await selectCopilotChannelForRequest({ sessionId })

  return accountSelection
}

function getRouteUnavailableType(
  filteredAccounts: Array<RouteFilteredAccount>,
): string {
  const reasons = new Set(filteredAccounts.map((account) => account.reason))

  if (
    reasons.has("quota_exhausted")
    || reasons.has("premium_quota_exhausted")
  ) {
    return "quota_exhausted"
  }

  if (reasons.has("cooldown")) {
    return "cooldown"
  }

  if (reasons.has("model_unsupported")) {
    return "model_unsupported"
  }

  if (reasons.has("usage_unavailable")) {
    return "usage_unavailable"
  }

  return "unavailable"
}

async function getRouteCandidates(
  accounts: Array<RuntimeAccount>,
  context: RouteRequestContext,
): Promise<RouteCandidates> {
  const nowMs = context.nowMs ?? Date.now()
  const quotaBucket = getQuotaBucketForPath(context.path)
  const premiumMultiplier = getPremiumMultiplier(context.model)
  const knownCandidates: Array<RouteCandidate> = []
  const unknownCandidates: Array<RouteCandidate> = []
  const filteredAccounts: Array<RouteFilteredAccount> = []

  for (const account of accounts) {
    if (context.excludedAccountIds?.has(account.id)) {
      filteredAccounts.push(toFilteredAccount(account, "cooldown"))
      continue
    }

    if (isAccountCoolingDown(account.id, nowMs)) {
      filteredAccounts.push(toFilteredAccount(account, "cooldown"))
      continue
    }

    if (!isModelSupportedByAccount(context.model, account)) {
      filteredAccounts.push(toFilteredAccount(account, "model_unsupported"))
      continue
    }

    if (!quotaBucket) {
      knownCandidates.push({ account, usageKnown: false })
      continue
    }

    const usage = await getAccountUsageCached(account, nowMs)
    const chatStatus = hasRemainingQuota(usage, quotaBucket)
    const premiumStatus =
      premiumMultiplier > 0 ?
        hasRemainingQuota(usage, "premium_interactions", {
          allowOverage: true,
          amount: premiumMultiplier,
        })
      : true

    if (chatStatus === false) {
      filteredAccounts.push(toFilteredAccount(account, "quota_exhausted"))
      continue
    }

    if (premiumStatus === false) {
      filteredAccounts.push(
        toFilteredAccount(account, "premium_quota_exhausted"),
      )
      continue
    }

    if (chatStatus === undefined || premiumStatus === undefined) {
      unknownCandidates.push({ account, usageKnown: false })
      continue
    }

    knownCandidates.push({ account, usageKnown: true })
  }

  return {
    candidates:
      knownCandidates.length > 0 ? knownCandidates : unknownCandidates,
    filteredAccounts,
    premiumMultiplier,
    quotaBucket,
  }
}

function getReusableSessionSelection(
  routeCandidates: RouteCandidates,
  sessionId: string | undefined,
): AccountChannelSelection | null {
  if (!sessionId) {
    return null
  }

  const existingAccountId = sessionAccountIds.get(sessionId)
  const existing = routeCandidates.candidates.find(
    (candidate) => candidate.account.id === existingAccountId,
  )

  if (!existing) {
    sessionAccountIds.delete(sessionId)
    return null
  }

  return {
    mode: "account",
    account: existing.account,
    reason: "session",
    routeReason: "session",
    filteredAccounts: routeCandidates.filteredAccounts,
    premiumMultiplier: routeCandidates.premiumMultiplier,
    quotaBucket: routeCandidates.quotaBucket,
  }
}

function selectWeightedRandomCandidate(
  candidates: Array<RouteCandidate>,
  quotaBucket: CopilotQuotaId | undefined,
  random: () => number,
): RouteCandidate {
  if (candidates.length === 1) {
    return candidates[0]
  }

  const first = candidates[getRandomIndex(candidates.length, random)]
  const second = candidates[getRandomIndex(candidates.length, random)]

  return (
      getCandidateScore(first, quotaBucket)
        >= getCandidateScore(second, quotaBucket)
    ) ?
      first
    : second
}

function getRandomIndex(length: number, random: () => number): number {
  return Math.min(Math.floor(random() * length), length - 1)
}

function getCandidateScore(
  candidate: RouteCandidate,
  quotaBucket: CopilotQuotaId | undefined,
): number {
  const routeState = getAccountRouteState(candidate.account.id)
  const quotaScore =
    quotaBucket ?
      (getQuotaPercentRemaining(
        getCachedAccountUsage(candidate.account.id),
        quotaBucket,
      ) ?? (candidate.usageKnown ? 0 : 50))
    : 50

  return quotaScore - routeState.inFlight * 5 - routeState.recentFailures * 20
}

function isAccountCoolingDown(accountId: string, nowMs: number): boolean {
  return getAccountRouteState(accountId).cooldownUntilMs > nowMs
}

function toFilteredAccount(
  account: RuntimeAccount,
  reason: RouteFilterReason,
): RouteFilteredAccount {
  return {
    accountId: account.id,
    login: account.login,
    reason,
  }
}

function getQuotaBucketForPath(
  path: string | undefined,
): CopilotQuotaId | undefined {
  if (!path) {
    return undefined
  }

  const normalizedPath = path.split("?", 1)[0]
  return CHAT_QUOTA_PATHS.has(normalizedPath) ? "chat" : undefined
}

const CHAT_QUOTA_PATHS = new Set([
  "/chat/completions",
  "/responses",
  "/v1/chat/completions",
  "/v1/messages",
  "/v1/responses",
])

function getPremiumMultiplier(model: string | undefined): number {
  if (!model) {
    return 0
  }

  const billing = state.models?.data.find((item) => item.id === model)?.billing

  return (
      billing?.is_premium === true && typeof billing.multiplier === "number"
    ) ?
      billing.multiplier
    : 0
}

function isModelSupportedByAccount(
  model: string | undefined,
  account: RuntimeAccount,
): boolean {
  if (
    !model
    || !state.modelSupport
    || !Object.hasOwn(state.modelSupport, model)
  ) {
    return true
  }

  const supportedAccounts = state.modelSupport[model] ?? []
  return supportedAccounts.some((support) => support.id === account.id)
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

export function markCopilotChannelRequestStarted(
  selection: CopilotChannelSelection,
): void {
  if (selection.mode === "legacy") {
    return
  }

  getAccountRouteState(selection.account.id).inFlight += 1
}

export function markCopilotChannelRequestFinished(
  selection: CopilotChannelSelection,
): void {
  if (selection.mode === "legacy") {
    return
  }

  const routeState = getAccountRouteState(selection.account.id)
  routeState.inFlight = Math.max(routeState.inFlight - 1, 0)
}

export function markCopilotChannelRequestSucceeded(
  selection: CopilotChannelSelection,
): void {
  if (selection.mode === "legacy") {
    return
  }

  const routeState = getAccountRouteState(selection.account.id)
  routeState.recentFailures = Math.max(routeState.recentFailures - 1, 0)

  if (selection.quotaBucket) {
    estimateAccountQuotaUse(selection.account.id, selection.quotaBucket, 1)
  }

  if ((selection.premiumMultiplier ?? 0) > 0) {
    estimateAccountQuotaUse(
      selection.account.id,
      "premium_interactions",
      selection.premiumMultiplier ?? 0,
    )
  }
}

export function markCopilotChannelQuotaExhausted(
  selection: CopilotChannelSelection,
  quotaBucket: CopilotQuotaId | undefined = selection.mode === "account" ?
    selection.quotaBucket
  : undefined,
): void {
  if (selection.mode === "legacy" || !quotaBucket) {
    return
  }

  markAccountQuotaExhausted(selection.account.id, quotaBucket)
  clearSessionRoutesForAccount(selection.account.id)
}

export function markCopilotChannelCoolingDown(
  selection: CopilotChannelSelection,
  options: {
    durationMs: number
    nowMs?: number
    reason: string
  },
): void {
  if (selection.mode === "legacy") {
    return
  }

  const routeState = getAccountRouteState(selection.account.id)
  routeState.cooldownUntilMs =
    (options.nowMs ?? Date.now()) + options.durationMs
  routeState.cooldownReason = options.reason
  routeState.recentFailures += 1
  clearSessionRoutesForAccount(selection.account.id)
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
    accountRouteStates.delete(id)
    clearAccountUsageCache(id)
  }

  if (accountId === undefined) {
    sessionAccountIds.clear()
    accountRouteStates.clear()
    clearAccountUsageCache()
    return
  }

  clearSessionRoutesForAccount(accountId)
}

function clearSessionRoutesForAccount(accountId: string): void {
  for (const [sessionId, mappedAccountId] of sessionAccountIds.entries()) {
    if (mappedAccountId === accountId) {
      sessionAccountIds.delete(sessionId)
    }
  }
}
