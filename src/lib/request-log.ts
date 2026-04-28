import { randomUUID } from "node:crypto"

export const REQUEST_LOG_LIMIT = 100

export interface RequestLogChannel {
  mode: "account" | "legacy"
  accountId?: string
  login?: string
  accountType?: string
  reason: "session" | "random" | "legacy"
}

export interface RequestLogInput {
  method: string
  path: string
  model?: string
  sessionId?: string
  channel: RequestLogChannel
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
