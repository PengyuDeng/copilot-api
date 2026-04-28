import type { Context, Next } from "hono"

import {
  getLocalAccessUsername,
  hasValidLocalAccessAuth,
  isTrustedBrowserRequest,
  requiresLocalAccessAuth,
} from "~/lib/local-security"

/**
 * Middleware for local management routes.
 * Remote peer addresses are allowed; unsafe browser requests remain blocked.
 */
export async function localOnlyMiddleware(
  c: Context,
  next: Next,
): Promise<Response | undefined> {
  const hostHeader = c.req.header("host") ?? new URL(c.req.raw.url).host

  if (
    !isTrustedBrowserRequest({
      hostHeader,
      method: c.req.method,
      originHeader: c.req.header("origin"),
      refererHeader: c.req.header("referer"),
      requestUrl: c.req.raw.url,
      secFetchSiteHeader: c.req.header("sec-fetch-site"),
    })
  ) {
    return c.json(
      {
        error: {
          message:
            "Forbidden: Cross-site browser requests are blocked for local admin routes",
          type: "forbidden",
        },
      },
      403,
    )
  }

  if (
    requiresLocalAccessAuth()
    && !hasValidLocalAccessAuth(c.req.header("authorization"))
  ) {
    c.header(
      "WWW-Authenticate",
      `Basic realm="Copilot API Local Management", charset="UTF-8"`,
    )

    return c.json(
      {
        error: {
          message: `Unauthorized: Use Basic auth with username "${getLocalAccessUsername()}"`,
          type: "unauthorized",
        },
      },
      401,
    )
  }

  await next()
  return undefined
}
