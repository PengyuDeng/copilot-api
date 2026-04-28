import consola from "consola"

import type { SubagentMarker } from "~/routes/messages/subagent-marker"

import {
  copilotBaseUrl,
  copilotHeaders,
  prepareSubagentHeaders,
} from "~/lib/api-config"
import {
  getCopilotTokenForChannel,
  refreshCopilotTokenForChannel,
  selectCopilotChannel,
  type CopilotChannelSelection,
} from "~/lib/copilot-channel-router"
import { ContextOverflowError, isContextOverflow } from "~/lib/copilot-error"
import { copilotTokenManager } from "~/lib/copilot-token-manager"
import { HTTPError } from "~/lib/error"
import { addRequestLog, type RequestLogChannel } from "~/lib/request-log"
import { state } from "~/lib/state"

const RETRYABLE_STATUSES = new Set([401, 403])

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
  const method = options.method ?? "POST"
  const selection = selectCopilotChannel(options.sessionId)
  const startedAt = Date.now()
  let responseStatus: number | undefined
  let ok = false
  let errorMessage: string | undefined

  try {
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

    responseStatus = response.status

    if (RETRYABLE_STATUSES.has(response.status)) {
      const refreshedToken = await refreshRequestToken(selection)
      const retryHeaders = buildRequestHeaders(
        selection,
        refreshedToken,
        options,
      )
      response = await globalThis.fetch(url, {
        method,
        headers: retryHeaders,
        ...(options.body !== undefined && {
          body: JSON.stringify(options.body),
        }),
      })
      responseStatus = response.status
    }

    if (!response.ok) {
      const errorText = await response
        .clone()
        .text()
        .catch(() => "")
      if (isContextOverflow(errorText)) {
        errorMessage = "Context overflow"
        throw new ContextOverflowError(errorText, response.status, errorText)
      }
      errorMessage = `Failed to request ${options.path}`
      consola.error(`Failed to request ${options.path}`, response)
      throw new HTTPError(`Failed to request ${options.path}`, response)
    }

    ok = true
    return response
  } catch (error) {
    errorMessage ??= error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    addRequestLog({
      method,
      path: options.path,
      model: getRequestModel(options.body),
      sessionId: options.sessionId,
      channel: getRequestLogChannel(selection),
      status: responseStatus,
      ok,
      durationMs: Date.now() - startedAt,
      error: errorMessage,
    })
  }
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
  selection: CopilotChannelSelection,
): RequestLogChannel {
  if (selection.mode === "account") {
    return {
      mode: "account",
      accountId: selection.account.id,
      login: selection.account.login,
      accountType: selection.account.accountType,
      reason: selection.reason,
    }
  }

  return {
    mode: "legacy",
    reason: selection.reason,
  }
}
