import type { AppConfig } from "~/lib/config"

import { normalizeHttpProxyUrl } from "~/lib/proxy"

export interface AdminSettingsResponse {
  rateLimitSeconds: number | null
  rateLimitWait: boolean
  httpProxy: string | null
  envOverride: {
    rateLimitSeconds: boolean
    rateLimitWait: boolean
  }
}

export interface AdminSettingsUpdateBody {
  rateLimitSeconds?: number | null
  rateLimitWait?: boolean
  httpProxy?: string | null
}

export interface AdminSettingsUpdate {
  rateLimitSeconds?: number
  rateLimitWait: boolean
  httpProxy?: string
  response: Omit<AdminSettingsResponse, "envOverride">
}

export type AdminSettingsUpdateResult =
  | { success: true; update: AdminSettingsUpdate }
  | { success: false; message: string }

function normalizePersistedHttpProxy(value: unknown): string | undefined {
  try {
    return normalizeHttpProxyUrl(value)
  } catch {
    return undefined
  }
}

export function buildAdminSettingsResponse(
  config: AppConfig,
  env: NodeJS.ProcessEnv = process.env,
): AdminSettingsResponse {
  const httpProxy = normalizePersistedHttpProxy(config.httpProxy)

  return {
    rateLimitSeconds: config.rateLimitSeconds ?? null,
    rateLimitWait: config.rateLimitWait ?? false,
    httpProxy: httpProxy ?? null,
    envOverride: {
      rateLimitSeconds: env.RATE_LIMIT !== undefined,
      rateLimitWait: env.RATE_LIMIT_WAIT !== undefined,
    },
  }
}

export function didHttpProxyChange(
  config: AppConfig,
  nextHttpProxy: string | undefined,
): boolean {
  return (
    (normalizePersistedHttpProxy(config.httpProxy) ?? null)
    !== (nextHttpProxy ?? null)
  )
}

export function parseAdminSettingsUpdate(
  body: AdminSettingsUpdateBody,
  config: AppConfig,
): AdminSettingsUpdateResult {
  const rateLimitSeconds =
    body.rateLimitSeconds === null || body.rateLimitSeconds === undefined ?
      undefined
    : body.rateLimitSeconds

  if (
    rateLimitSeconds !== undefined
    && (!Number.isFinite(rateLimitSeconds) || rateLimitSeconds <= 0)
  ) {
    return {
      success: false,
      message: '"rateLimitSeconds" must be a number greater than 0',
    }
  }

  let httpProxy = config.httpProxy
  if (Object.hasOwn(body, "httpProxy")) {
    try {
      httpProxy = normalizeHttpProxyUrl(body.httpProxy)
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const rateLimitWait = Boolean(body.rateLimitWait)

  return {
    success: true,
    update: {
      rateLimitSeconds,
      rateLimitWait,
      httpProxy,
      response: {
        rateLimitSeconds: rateLimitSeconds ?? null,
        rateLimitWait,
        httpProxy: httpProxy ?? null,
      },
    },
  }
}
