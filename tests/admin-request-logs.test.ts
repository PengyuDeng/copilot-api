import { afterEach, describe, expect, test } from "bun:test"

import {
  addRequestLog,
  clearRequestLogs,
  REQUEST_LOG_LIMIT,
} from "~/lib/request-log"
import { adminRoutes } from "~/routes/admin/route"

afterEach(() => {
  clearRequestLogs()
})

describe("admin request logs API", () => {
  test("returns recent request logs without token fields", async () => {
    addRequestLog({
      method: "POST",
      path: "/chat/completions",
      model: "gpt-test",
      sessionId: "session-1",
      channel: {
        mode: "account",
        accountId: "account-1",
        login: "alice",
        accountType: "individual",
        reason: "session",
      },
      status: 200,
      ok: true,
      durationMs: 12,
    })

    const response = await adminRoutes.fetch(createLocalAdminRequest())
    const bodyText = await response.text()
    const body = JSON.parse(bodyText) as {
      limit: number
      logs: Array<{
        channel: {
          accountId?: string
          login?: string
          mode: string
          reason: string
        }
        path: string
      }>
    }

    expect(response.status).toBe(200)
    expect(body.limit).toBe(REQUEST_LOG_LIMIT)
    expect(body.logs).toHaveLength(1)
    expect(body.logs[0]).toMatchObject({
      path: "/chat/completions",
      channel: {
        mode: "account",
        accountId: "account-1",
        login: "alice",
        reason: "session",
      },
    })
    expect(bodyText).not.toContain("token")
  })
})

function createLocalAdminRequest(): Request {
  const request = new Request("http://localhost/api/request-logs", {
    headers: {
      host: "localhost:4141",
    },
  })

  Object.defineProperty(request, "ip", {
    configurable: true,
    value: "127.0.0.1",
  })

  return request
}
