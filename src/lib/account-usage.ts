import {
  getCopilotUsage,
  type CopilotQuotaId,
  type CopilotUsageResponse,
  type QuotaDetail,
} from "~/services/github/get-copilot-usage"

import { state, type RuntimeAccount } from "./state"

export const ACCOUNT_USAGE_CACHE_TTL_MS = 5 * 60 * 1000

const QUOTA_IDS = [
  "chat",
  "completions",
  "premium_interactions",
] as const satisfies ReadonlyArray<CopilotQuotaId>

const QUOTA_LABELS: Record<CopilotQuotaId, string> = {
  chat: "Chat",
  completions: "Completions",
  premium_interactions: "Premium",
}

export type AccountUsageStatus = "ok" | "error"
export type AccountUsageQuotaSource =
  | "limited_user_quotas"
  | "quota_snapshots"
  | "unknown"

export interface AdminAccountQuota {
  entitlement?: number
  id: CopilotQuotaId
  label: string
  overagePermitted?: boolean
  percentRemaining?: number
  quotaRemaining?: number
  remaining?: number
  unlimited: boolean
}

export interface AdminAccountUsage {
  accessTypeSku?: string
  accountType: RuntimeAccount["accountType"]
  chatEnabled?: boolean
  error?: string
  id: string
  isFreeLimited: boolean
  login: string
  plan?: string
  quotaSource: AccountUsageQuotaSource
  quotas: Partial<Record<CopilotQuotaId, AdminAccountQuota>>
  resetDate?: string
  status: AccountUsageStatus
}

interface AccountUsageCacheEntry {
  fetchedAtMs: number
  refreshPromise: Promise<AdminAccountUsage> | null
  usage: AdminAccountUsage
}

const accountUsageCache = new Map<string, AccountUsageCacheEntry>()

export async function getAccountUsageSummaries(
  accounts: Array<RuntimeAccount>,
): Promise<Array<AdminAccountUsage>> {
  return await Promise.all(
    accounts.map((account) => refreshAccountUsage(account)),
  )
}

export function getCachedAccountUsage(
  accountId: string,
): AdminAccountUsage | undefined {
  return accountUsageCache.get(accountId)?.usage
}

export function setCachedAccountUsage(
  usage: AdminAccountUsage,
  fetchedAtMs: number = Date.now(),
): void {
  accountUsageCache.set(usage.id, {
    fetchedAtMs,
    refreshPromise: null,
    usage,
  })
}

export function clearAccountUsageCache(accountId?: string): void {
  if (accountId === undefined) {
    accountUsageCache.clear()
    return
  }

  accountUsageCache.delete(accountId)
}

export async function getAccountUsageCached(
  account: RuntimeAccount,
  nowMs: number = Date.now(),
): Promise<AdminAccountUsage> {
  const existing = accountUsageCache.get(account.id)
  if (
    existing
    && existing.usage.status === "ok"
    && nowMs - existing.fetchedAtMs < ACCOUNT_USAGE_CACHE_TTL_MS
  ) {
    return existing.usage
  }

  if (existing?.refreshPromise) {
    return await existing.refreshPromise
  }

  const refreshPromise = refreshAccountUsage(account, nowMs)
  if (existing) {
    existing.refreshPromise = refreshPromise
  }

  return await refreshPromise
}

export async function refreshAccountUsage(
  account: RuntimeAccount,
  fetchedAtMs: number = Date.now(),
): Promise<AdminAccountUsage> {
  const usage = await getAccountUsage(account)
  setCachedAccountUsage(usage, fetchedAtMs)
  return usage
}

export async function getAccountUsage(
  account: RuntimeAccount,
): Promise<AdminAccountUsage> {
  try {
    const usage = await getCopilotUsage({
      githubToken: account.token,
      vsCodeVersion: state.vsCodeVersion,
    })

    return normalizeAccountUsage(account, usage)
  } catch (error) {
    return {
      id: account.id,
      login: account.login,
      accountType: account.accountType,
      status: "error",
      isFreeLimited: false,
      quotaSource: "unknown",
      quotas: {},
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function hasRemainingQuota(
  usage: AdminAccountUsage | undefined,
  quotaId: CopilotQuotaId,
  options: { allowOverage?: boolean; amount?: number } = {},
): boolean | undefined {
  if (!usage || usage.status !== "ok") {
    return undefined
  }

  const quota = usage.quotas[quotaId]
  if (!quota) {
    return false
  }

  if (quota.unlimited) {
    return true
  }

  if (typeof quota.remaining === "number") {
    const requiredAmount = options.amount ?? 1
    if (quota.remaining >= requiredAmount) {
      return true
    }

    return Boolean(options.allowOverage && quota.overagePermitted)
  }

  return undefined
}

export function getQuotaPercentRemaining(
  usage: AdminAccountUsage | undefined,
  quotaId: CopilotQuotaId,
): number | undefined {
  if (!usage || usage.status !== "ok") {
    return undefined
  }

  const quota = usage.quotas[quotaId]
  if (!quota) {
    return undefined
  }

  if (quota.unlimited) {
    return 100
  }

  return quota.percentRemaining
}

export function estimateAccountQuotaUse(
  accountId: string,
  quotaId: CopilotQuotaId,
  amount: number,
): void {
  if (amount <= 0) {
    return
  }

  const existing = accountUsageCache.get(accountId)
  if (!existing || existing.usage.status !== "ok") {
    return
  }

  const quota = existing.usage.quotas[quotaId]
  if (!quota || quota.unlimited || typeof quota.remaining !== "number") {
    return
  }

  existing.usage = {
    ...existing.usage,
    quotas: {
      ...existing.usage.quotas,
      [quotaId]: {
        ...quota,
        remaining: quota.remaining - amount,
        percentRemaining: getPercentRemaining(
          quota.remaining - amount,
          quota.entitlement,
        ),
      },
    },
  }
}

export function markAccountQuotaExhausted(
  accountId: string,
  quotaId: CopilotQuotaId,
): void {
  const existing = accountUsageCache.get(accountId)
  if (!existing || existing.usage.status !== "ok") {
    return
  }

  const quota = existing.usage.quotas[quotaId]
  if (!quota || quota.unlimited) {
    return
  }

  existing.usage = {
    ...existing.usage,
    quotas: {
      ...existing.usage.quotas,
      [quotaId]: {
        ...quota,
        percentRemaining: 0,
        remaining: 0,
      },
    },
  }
}

export function normalizeAccountUsage(
  account: Pick<RuntimeAccount, "accountType" | "id" | "login">,
  usage: CopilotUsageResponse,
): AdminAccountUsage {
  const isFreeLimited = isFreeLimitedUsage(usage)
  const hasLimitedQuotas =
    usage.limited_user_quotas !== undefined
    || usage.monthly_quotas !== undefined
  const quotaSource = getQuotaSource(usage, isFreeLimited, hasLimitedQuotas)

  return {
    id: account.id,
    login: account.login,
    accountType: account.accountType,
    status: "ok",
    accessTypeSku: usage.access_type_sku,
    chatEnabled: usage.chat_enabled,
    isFreeLimited,
    plan: usage.copilot_plan,
    quotaSource,
    quotas:
      quotaSource === "limited_user_quotas" ?
        normalizeLimitedUserQuotas(usage)
      : normalizeQuotaSnapshots(usage),
    resetDate: getResetDate(usage, quotaSource),
  }
}

function getQuotaSource(
  usage: CopilotUsageResponse,
  isFreeLimited: boolean,
  hasLimitedQuotas: boolean,
): AccountUsageQuotaSource {
  if (isFreeLimited && hasLimitedQuotas) {
    return "limited_user_quotas"
  }

  if (usage.quota_snapshots) {
    return "quota_snapshots"
  }

  return "unknown"
}

function getResetDate(
  usage: CopilotUsageResponse,
  quotaSource: AccountUsageQuotaSource,
): string | undefined {
  if (quotaSource === "limited_user_quotas") {
    return (
      usage.limited_user_reset_date
      ?? usage.quota_reset_date
      ?? usage.quota_reset_date_utc
    )
  }

  return usage.quota_reset_date ?? usage.quota_reset_date_utc
}

function normalizeQuotaSnapshots(
  usage: CopilotUsageResponse,
): AdminAccountUsage["quotas"] {
  const quotas: AdminAccountUsage["quotas"] = {}

  for (const quotaId of QUOTA_IDS) {
    const detail = usage.quota_snapshots?.[quotaId]
    if (!detail) {
      continue
    }

    quotas[quotaId] = normalizeQuotaDetail(quotaId, detail)
  }

  return quotas
}

function normalizeQuotaDetail(
  quotaId: CopilotQuotaId,
  detail: QuotaDetail,
): AdminAccountQuota {
  return {
    id: quotaId,
    label: QUOTA_LABELS[quotaId],
    entitlement: readNumber(detail.entitlement),
    overagePermitted: detail.overage_permitted,
    percentRemaining: readNumber(detail.percent_remaining),
    quotaRemaining: readNumber(detail.quota_remaining),
    remaining:
      readNumber(detail.remaining) ?? readNumber(detail.quota_remaining),
    unlimited: detail.unlimited,
  }
}

function normalizeLimitedUserQuotas(
  usage: CopilotUsageResponse,
): AdminAccountUsage["quotas"] {
  const quotas: AdminAccountUsage["quotas"] = {}

  for (const quotaId of QUOTA_IDS) {
    const remaining = readNumber(usage.limited_user_quotas?.[quotaId])
    const entitlement = readNumber(usage.monthly_quotas?.[quotaId])

    if (remaining === undefined && entitlement === undefined) {
      continue
    }

    quotas[quotaId] = {
      id: quotaId,
      label: QUOTA_LABELS[quotaId],
      entitlement,
      remaining,
      percentRemaining: getPercentRemaining(remaining, entitlement),
      unlimited: false,
    }
  }

  return quotas
}

function isFreeLimitedUsage(usage: CopilotUsageResponse): boolean {
  return (
    usage.access_type_sku === "free_limited_copilot"
    || usage.limited_user_quotas !== undefined
    || usage.monthly_quotas !== undefined
  )
}

function getPercentRemaining(
  remaining: number | undefined,
  entitlement: number | undefined,
): number | undefined {
  if (
    remaining === undefined
    || entitlement === undefined
    || entitlement <= 0
  ) {
    return undefined
  }

  return Math.round((remaining / entitlement) * 1000) / 10
}

function readNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}
