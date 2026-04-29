/* eslint-disable require-atomic-updates */
import consola from "consola"

import type { SubagentMarker } from "~/routes/messages/subagent-marker"
import type { CopilotQuotaId } from "~/services/github/get-copilot-usage"

import {
  copilotBaseUrl,
  copilotHeaders,
  prepareSubagentHeaders,
} from "~/lib/api-config"
import {
  type AccountChannelSelection,
  getCopilotTokenForChannel,
  markCopilotChannelCoolingDown,
  markCopilotChannelQuotaExhausted,
  markCopilotChannelRequestFinished,
  markCopilotChannelRequestStarted,
  markCopilotChannelRequestSucceeded,
  refreshCopilotTokenForChannel,
  selectCopilotChannelForRequest,
  type CopilotChannelSelection,
} from "~/lib/copilot-channel-router"
import { ContextOverflowError, isContextOverflow } from "~/lib/copilot-error"
import { copilotTokenManager } from "~/lib/copilot-token-manager"
import { HTTPError, RouteUnavailableError } from "~/lib/error"
import {
  addRequestLog,
  type RequestLogChannel,
  type RequestLogFilteredAccount,
  type RequestLogRouteAttempt,
} from "~/lib/request-log"
import { state } from "~/lib/state"

const RETRYABLE_STATUSES = new Set([401, 403])
const REROUTE_COOLDOWN_MS = 120_000

interface CopilotRequestRun {
  errorMessage?: string
  excludedAccountIds: Set<string>
  filteredAccounts: Array<RequestLogFilteredAccount>
  maxRouteAttempts: number
  method: "GET" | "POST"
  model?: string
  nextRerouteReason?: "reroute_error" | "reroute_quota"
  ok: boolean
  responseStatus?: number
  routeAttempts: Array<RequestLogRouteAttempt>
  selection?: CopilotChannelSelection
  startedAt: number
}

// ─── Low-level request function ──────────────────────────────────────────────

export interface CopilotRequestOptions {
  /** API path, e.g. "/chat/completions", "/responses", "/v1/messages" */
  path: string
  /** Request body (will be JSON.stringify'd). Omit for GET requests. */
  body?: unknown
  /** HTTP method, defaults to "POST" */
  method?: "GET" | "POST"
  /** Enable vision headers */
  vision?: boolean
  /** Request initiator: "agent" or "user" */
  initiator?: "agent" | "user"
  /** Subagent marker for conversation-subagent headers */
  subagentMarker?: SubagentMarker | null
  /** Session ID for x-interaction-id header */
  sessionId?: string
  /** Additional headers to merge (e.g. anthropic-beta) */
  extraHeaders?: Record<string, string>
  /** Explicit account channel. Omit to route by session/random selection. */
  channelSelection?: CopilotChannelSelection
}

/**
 * Low-level Copilot API request function.
 *
 * Combines the provider's auth/retry infrastructure with the project's
 * existing header construction. Returns a raw Response object that can
 * be consumed directly via `events(response)` for SSE or `.json()` for
 * non-streaming.
 *
 * This replaces `fetchCopilotWithRetry()` as the single entry point
 * for all Copilot API calls.
 */
export async function copilotRequest(
  options: CopilotRequestOptions,
): Promise<Response> {
  const run = createCopilotRequestRun(options)

  try {
    return await runCopilotRouteAttempts(options, run)
  } catch (error) {
    run.errorMessage ??= error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    logCopilotRequest(options, run)
  }
}

function createCopilotRequestRun(
  options: CopilotRequestOptions,
): CopilotRequestRun {
  return {
    excludedAccountIds: new Set<string>(),
    filteredAccounts: [],
    maxRouteAttempts:
      options.channelSelection ? 1 : Math.max(1, state.accounts?.length ?? 1),
    method: options.method ?? "POST",
    model: getRequestModel(options.body),
    ok: false,
    routeAttempts: [],
    startedAt: Date.now(),
  }
}

async function runCopilotRouteAttempts(
  options: CopilotRequestOptions,
  run: CopilotRequestRun,
): Promise<Response> {
  let lastError: unknown

  for (let attempt = 0; attempt < run.maxRouteAttempts; attempt += 1) {
    try {
      run.selection = await selectRouteAttempt(options, run, attempt)
    } catch (error) {
      if (error instanceof RouteUnavailableError) {
        run.filteredAccounts = getUnavailableFilteredAccounts(error)
      }
      throw error
    }
    run.filteredAccounts = getRequestLogFilteredAccounts(run.selection)
    lastError = await tryCopilotRouteAttempt(options, run, attempt)

    if (lastError instanceof Response) {
      return lastError
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function selectRouteAttempt(
  options: CopilotRequestOptions,
  run: CopilotRequestRun,
  attempt: number,
): Promise<CopilotChannelSelection> {
  return (
    options.channelSelection
    ?? (await selectCopilotChannelForRequest({
      excludedAccountIds: run.excludedAccountIds,
      model: run.model,
      path: options.path,
      rerouteReason: attempt > 0 ? run.nextRerouteReason : undefined,
      sessionId: options.sessionId,
    }))
  )
}

async function tryCopilotRouteAttempt(
  options: CopilotRequestOptions,
  run: CopilotRequestRun,
  attempt: number,
): Promise<unknown> {
  const selection = run.selection
  if (!selection) {
    return new Error("No Copilot channel selected")
  }

  try {
    markCopilotChannelRequestStarted(selection)
    run.routeAttempts.push(toRouteAttempt(selection, "selected"))
    return await handleAttemptResponse({
      options,
      run,
      attempt,
      selection,
    })
  } catch (error) {
    return handleAttemptError({
      run,
      attempt,
      selection,
      error,
    })
  } finally {
    markCopilotChannelRequestFinished(selection)
  }
}

interface AttemptResponseContext {
  attempt: number
  options: CopilotRequestOptions
  run: CopilotRequestRun
  selection: CopilotChannelSelection
}

async function handleAttemptResponse({
  options,
  run,
  attempt,
  selection,
}: AttemptResponseContext): Promise<unknown> {
  const response = await requestWithTokenRefresh(selection, options, run.method)
  run.responseStatus = response.status

  if (response.ok) {
    markCopilotChannelRequestSucceeded(selection)
    run.routeAttempts.push(
      toRouteAttempt(selection, "success", response.status),
    )
    run.ok = true
    return response
  }

  const errorText = await readResponseText(response)
  if (isContextOverflow(errorText)) {
    run.errorMessage = "Context overflow"
    throw new ContextOverflowError(errorText, response.status, errorText)
  }

  const rerouteSelection = getReroutableAttemptSelection({
    selection,
    status: response.status,
    errorText,
  })
  if (rerouteSelection) {
    run.nextRerouteReason = getRerouteReason(response.status, errorText)
    handleReroutableFailure(rerouteSelection, response.status, errorText)
    run.excludedAccountIds.add(rerouteSelection.account.id)
    run.routeAttempts.push(
      toRouteAttempt(rerouteSelection, "error", response.status),
    )
    if (hasRemainingRouteAttempt(run, attempt)) {
      return new HTTPError(`Failed to request ${options.path}`, response)
    }
  }

  run.errorMessage = `Failed to request ${options.path}`
  consola.error(`Failed to request ${options.path}`, response)
  throw new HTTPError(`Failed to request ${options.path}`, response)
}

interface AttemptErrorContext {
  attempt: number
  error: unknown
  run: CopilotRequestRun
  selection: CopilotChannelSelection
}

function handleAttemptError({
  run,
  attempt,
  selection,
  error,
}: AttemptErrorContext): unknown {
  if (error instanceof HTTPError) {
    throw error
  }

  const rerouteSelection = getReroutableErrorSelection({
    selection,
    error,
  })
  if (!rerouteSelection) {
    throw error
  }

  markCopilotChannelCoolingDown(rerouteSelection, {
    durationMs: REROUTE_COOLDOWN_MS,
    reason: "request_error",
  })
  run.nextRerouteReason = "reroute_error"
  run.excludedAccountIds.add(rerouteSelection.account.id)
  run.routeAttempts.push(toRouteAttempt(rerouteSelection, "error"))
  if (!hasRemainingRouteAttempt(run, attempt)) {
    throw error
  }

  return error
}

interface RerouteAttemptContext {
  errorText: string
  selection: CopilotChannelSelection
  status: number
}

function getReroutableAttemptSelection({
  selection,
  status,
  errorText,
}: RerouteAttemptContext): AccountChannelSelection | null {
  if (shouldTryAnotherAccount(selection, status, errorText)) {
    return selection
  }

  return null
}

interface RerouteErrorContext {
  error: unknown
  selection: CopilotChannelSelection | undefined
}

function getReroutableErrorSelection({
  selection,
  error,
}: RerouteErrorContext): AccountChannelSelection | null {
  if (shouldTryAnotherAccountAfterError(selection, error)) {
    return selection
  }

  return null
}

function hasRemainingRouteAttempt(
  run: CopilotRequestRun,
  attempt: number,
): boolean {
  return attempt < run.maxRouteAttempts - 1
}

async function requestWithTokenRefresh(
  selection: CopilotChannelSelection,
  options: CopilotRequestOptions,
  method: "GET" | "POST",
): Promise<Response> {
  const token = await getRequestToken(selection)
  const headers = buildRequestHeaders(selection, token, options)
  const url = `${copilotBaseUrl(getChannelState(selection, token))}${options.path}`

  let response = await globalThis.fetch(url, {
    method,
    headers,
    ...(options.body !== undefined && {
      body: JSON.stringify(options.body),
    }),
  })

  if (await shouldRefreshTokenAfterResponse(response)) {
    const refreshedToken = await refreshRequestToken(selection)
    const retryHeaders = buildRequestHeaders(selection, refreshedToken, options)
    response = await globalThis.fetch(url, {
      method,
      headers: retryHeaders,
      ...(options.body !== undefined && {
        body: JSON.stringify(options.body),
      }),
    })
  }

  return response
}

async function shouldRefreshTokenAfterResponse(
  response: Response,
): Promise<boolean> {
  if (!RETRYABLE_STATUSES.has(response.status)) {
    return false
  }

  if (response.status !== 403) {
    return true
  }

  const errorText = await readResponseText(response)
  return (
    !isContextOverflow(errorText) && !isQuotaFailure(response.status, errorText)
  )
}

async function readResponseText(response: Response): Promise<string> {
  return await response
    .clone()
    .text()
    .catch(() => "")
}

function shouldTryAnotherAccount(
  selection: CopilotChannelSelection,
  status: number,
  errorText: string,
): selection is Extract<CopilotChannelSelection, { mode: "account" }> {
  if (selection.mode !== "account") {
    return false
  }

  return (
    status === 429
    || status >= 500
    || (status === 403 && !isContextOverflow(errorText))
  )
}

function shouldTryAnotherAccountAfterError(
  selection: CopilotChannelSelection | undefined,
  error: unknown,
): selection is Extract<CopilotChannelSelection, { mode: "account" }> {
  return (
    selection?.mode === "account" && !(error instanceof ContextOverflowError)
  )
}

function handleReroutableFailure(
  selection: Extract<CopilotChannelSelection, { mode: "account" }>,
  status: number,
  errorText: string,
): void {
  if (isQuotaFailure(status, errorText)) {
    markCopilotChannelQuotaExhausted(
      selection,
      getQuotaFailureBucket(selection, errorText),
    )
    return
  }

  markCopilotChannelCoolingDown(selection, {
    durationMs: REROUTE_COOLDOWN_MS,
    reason: `http_${status}`,
  })
}

function getRerouteReason(
  status: number,
  errorText: string,
): "reroute_error" | "reroute_quota" {
  return isQuotaFailure(status, errorText) ? "reroute_quota" : "reroute_error"
}

function getQuotaFailureBucket(
  selection: AccountChannelSelection,
  errorText: string,
): CopilotQuotaId | undefined {
  return /premium/i.test(errorText) ?
      "premium_interactions"
    : selection.quotaBucket
}

function isQuotaFailure(status: number, errorText: string): boolean {
  return (
    status === 403
    && /quota|exhaust|remaining|premium|limit|usage/i.test(errorText)
  )
}

async function getRequestToken(
  selection: CopilotChannelSelection,
): Promise<string> {
  if (selection.mode === "legacy") {
    return await copilotTokenManager.getToken()
  }

  const token = await getCopilotTokenForChannel(selection)
  if (!token) {
    throw new Error(
      `Failed to obtain Copilot token for ${selection.account.login}`,
    )
  }
  return token
}

async function refreshRequestToken(
  selection: CopilotChannelSelection,
): Promise<string> {
  if (selection.mode === "legacy") {
    copilotTokenManager.clear()
    return await copilotTokenManager.getToken()
  }

  const token = await refreshCopilotTokenForChannel(selection)
  if (!token) {
    throw new Error(
      `Failed to refresh Copilot token for ${selection.account.login}`,
    )
  }
  return token
}

function getChannelState(selection: CopilotChannelSelection, token: string) {
  if (selection.mode === "account") {
    return {
      accountType: selection.account.accountType,
      copilotToken: token,
      vsCodeVersion: state.vsCodeVersion,
    }
  }

  return {
    accountType: state.accountType,
    copilotToken: token,
    vsCodeVersion: state.vsCodeVersion,
  }
}

function buildRequestHeaders(
  selection: CopilotChannelSelection,
  token: string,
  options: CopilotRequestOptions,
): Record<string, string> {
  const headers: Record<string, string> = {
    ...copilotHeaders(getChannelState(selection, token), options.vision),
  }

  if (options.initiator) {
    headers["X-Initiator"] = options.initiator
  }

  prepareSubagentHeaders(
    options.sessionId,
    Boolean(options.subagentMarker),
    headers,
  )

  if (options.extraHeaders) {
    Object.assign(headers, options.extraHeaders)
  }

  return headers
}

function getRequestModel(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined
  const model = (body as { model?: unknown }).model
  return typeof model === "string" ? model : undefined
}

function getRequestLogChannel(
  selection: CopilotChannelSelection | undefined,
): RequestLogChannel {
  if (selection?.mode === "account") {
    return {
      mode: "account",
      accountId: selection.account.id,
      login: selection.account.login,
      accountType: selection.account.accountType,
      reason: selection.reason,
    }
  }

  if (!selection) {
    return {
      mode: "none",
      reason: "unavailable",
    }
  }

  return {
    mode: "legacy",
    reason: selection.reason,
  }
}

function logCopilotRequest(
  options: CopilotRequestOptions,
  run: CopilotRequestRun,
): void {
  addRequestLog({
    method: run.method,
    path: options.path,
    model: run.model,
    sessionId: options.sessionId,
    channel: getRequestLogChannel(run.selection),
    filteredAccounts: run.filteredAccounts,
    quotaBucket: getRequestLogQuotaBucket(run.selection),
    retryCount: run.routeAttempts.filter(
      (attempt) => attempt.result === "error",
    ).length,
    routeAttempts: run.routeAttempts,
    routeReason: getRequestLogRouteReason(run.selection),
    status: run.responseStatus,
    ok: run.ok,
    durationMs: Date.now() - run.startedAt,
    error: run.errorMessage,
  })
}

function getUnavailableFilteredAccounts(
  error: RouteUnavailableError,
): Array<RequestLogFilteredAccount> {
  return error.details.flatMap((detail) => {
    const accountId = detail.accountId
    const login = detail.login
    const reason = detail.reason
    if (
      typeof accountId !== "string"
      || typeof login !== "string"
      || typeof reason !== "string"
    ) {
      return []
    }

    return [{ accountId, login, reason }]
  })
}

function getRequestLogFilteredAccounts(
  selection: CopilotChannelSelection,
): Array<RequestLogFilteredAccount> {
  if (selection.mode === "legacy") {
    return []
  }

  return (
    selection.filteredAccounts?.map((account) => ({
      accountId: account.accountId,
      login: account.login,
      reason: account.reason,
    })) ?? []
  )
}

function getRequestLogQuotaBucket(
  selection: CopilotChannelSelection | undefined,
): string | undefined {
  return selection?.mode === "account" ? selection.quotaBucket : undefined
}

function getRequestLogRouteReason(
  selection: CopilotChannelSelection | undefined,
): string | undefined {
  return selection?.mode === "account" ? selection.routeReason : undefined
}

function toRouteAttempt(
  selection: CopilotChannelSelection,
  result: RequestLogRouteAttempt["result"],
  status?: number,
): RequestLogRouteAttempt {
  if (selection.mode === "legacy") {
    return {
      reason: selection.reason,
      result,
      status,
    }
  }

  return {
    accountId: selection.account.id,
    login: selection.account.login,
    reason: selection.reason,
    result,
    status,
  }
}
