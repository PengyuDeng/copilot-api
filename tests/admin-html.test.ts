import { describe, expect, test } from "bun:test"

import { adminHtml } from "~/routes/admin/html"

describe("adminHtml hardening", () => {
  test("escapes user-controlled fields before innerHTML insertion", () => {
    expect(adminHtml).toContain("function escHtml(s)")
    expect(adminHtml).toContain("escHtml(acc.avatarUrl || '')")
    expect(adminHtml).toContain("escHtml(acc.login)")
    expect(adminHtml).toContain("escHtml(acc.accountType)")
    expect(adminHtml).toContain("escHtml(model.id)")
    expect(adminHtml).toContain("escHtml(model.object || 'model')")
    expect(adminHtml).toContain("escHtml(from)")
    expect(adminHtml).toContain("escHtml(to)")
    expect(adminHtml).toContain("escHtml(m.id)")
  })

  test("uses delegated data-action handlers instead of onclick strings", () => {
    expect(adminHtml).toContain("document.addEventListener('click'")
    expect(adminHtml).toContain("closest('[data-action]')")
    expect(adminHtml).toContain('data-action="switch"')
    expect(adminHtml).toContain('data-action="delete-account"')
    expect(adminHtml).toContain('data-action="delete-mapping"')
    expect(adminHtml).not.toContain('onclick="switchAccount')
    expect(adminHtml).not.toContain('onclick="deleteAccount')
    expect(adminHtml).not.toContain('onclick="deleteMapping')
  })

  test("avoids unauthenticated resource fetch noise and keeps manual mapping entry available", () => {
    expect(adminHtml).toContain('rel="icon"')
    expect(adminHtml).toContain("let authStatus =")
    expect(adminHtml).toContain("const status = await fetchStatus();")
    expect(adminHtml).toContain("Add a GitHub account to load models.")
    expect(adminHtml).toContain("Add a GitHub account to load usage data.")
    expect(adminHtml).toContain(
      'id="mappingTo" list="mappingToOptions" placeholder="Target model"',
    )
    expect(adminHtml).toContain('<datalist id="mappingToOptions"></datalist>')
    expect(adminHtml).toContain(
      "Target model (add account to load suggestions)",
    )
  })

  test("exposes HTTP proxy settings in the admin UI", () => {
    expect(adminHtml).toContain('for="httpProxy"')
    expect(adminHtml).toContain('id="httpProxy"')
    expect(adminHtml).toContain('id="proxyNotice"')
    expect(adminHtml).toContain("all outbound GitHub and Copilot requests")
    expect(adminHtml).toContain("data.httpProxy ?? ''")
    expect(adminHtml).toContain("/v1/models?refresh=true")
    expect(adminHtml).toContain(
      "JSON.stringify({ rateLimitSeconds, rateLimitWait, httpProxy })",
    )
    expect(adminHtml).toContain("HTTP proxy must be a valid http://")
  })

  test("keeps rate limit and proxy notices next to their own settings", () => {
    const rateLimitNoticeIndex = adminHtml.indexOf('id="settingsNotice"')
    const proxyInputIndex = adminHtml.indexOf('id="httpProxy"')

    expect(rateLimitNoticeIndex).toBeGreaterThan(-1)
    expect(proxyInputIndex).toBeGreaterThan(-1)
    expect(rateLimitNoticeIndex).toBeLessThan(proxyInputIndex)
    expect(adminHtml).toContain("Saved rate limit values apply immediately")
    expect(adminHtml).toContain("Saved proxy changes apply immediately")
    expect(adminHtml).toContain(
      "document.getElementById('proxyNotice').textContent",
    )
  })
})
