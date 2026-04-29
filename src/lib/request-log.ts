import { randomUUID } from "node:crypto"

export const REQUEST_LOG_LIMIT = 100

export interface RequestLogChannel {
  mode: "account" | "legacy" | "none"
  accountId?: string
  login?: string
  accountType?: string
  reason:
    | "legacy"
    | "models"
    | "random"
    | "reroute_error"
    | "reroute_quota"
    | "session"
    | "unavailable"
}

export interface RequestLogRouteAttempt {
  accountId?: string
  login?: string
  reason: string
  status?: number
  result: "error" | "filtered" | "selected" | "success"
}

export interface RequestLogFilteredAccount {
  accountId: string
  login: string
  reason: string
}

export interface RequestLogInput {
  method: string
  path: string
  model?: string
  sessionId?: string
  channel: RequestLogChannel
  filteredAccounts?: Array<RequestLogFilteredAccount>
  quotaBucket?: string
  retryCount?: number
  routeAttempts?: Array<RequestLogRouteAttempt>
  routeReason?: string
  status?: number
  ok: boolean
  durationMs: number
  error?: string
}

export interface RequestLogEntry extends RequestLogInput {
  id: string
  timestamp: string
}

const requestLogs: Array<RequestLogEntry> = []

export function addRequestLog(input: RequestLogInput): RequestLogEntry {
  const entry: RequestLogEntry = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    ...input,
  }

  requestLogs.unshift(entry)
  if (requestLogs.length > REQUEST_LOG_LIMIT) {
    requestLogs.length = REQUEST_LOG_LIMIT
  }

  return entry
}

export function getRequestLogs(): Array<RequestLogEntry> {
  return [...requestLogs]
}

export function clearRequestLogs(): void {
  requestLogs.length = 0
}
