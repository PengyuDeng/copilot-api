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
    expect(adminHtml).toContain('data-action="confirm-switch"')
    expect(adminHtml).toContain('data-action="cancel-switch"')
    expect(adminHtml).toContain('data-action="delete-account"')
    expect(adminHtml).toContain('data-action="delete-mapping"')
    expect(adminHtml).toContain('data-action="refresh-usage"')
    expect(adminHtml).not.toContain('onclick="switchAccount')
    expect(adminHtml).not.toContain('onclick="deleteAccount')
    expect(adminHtml).not.toContain('onclick="deleteMapping')
  })

  test("uses popover confirmation when switching accounts", () => {
    expect(adminHtml).toContain("let pendingSwitchAccountId = null")
    expect(adminHtml).toContain("function requestSwitchAccount(id)")
    expect(adminHtml).toContain("function cancelSwitchAccount()")
    expect(adminHtml).toContain("confirm-popover")
    expect(adminHtml).toContain("background: #161b22")
    expect(adminHtml).toContain("color: #c9d1d9")
    expect(adminHtml).toContain("border: 1px solid #30363d")
    expect(adminHtml).toContain('role="dialog"')
    expect(adminHtml).toContain("确定切换账户？")
    expect(adminHtml).toContain("btn-confirm-primary")
    expect(adminHtml).toContain("currentUsageContent")
    expect(adminHtml).toContain("requestSwitchAccount(id);")
    expect(adminHtml).toContain("switchAccount(id);")
    expect(adminHtml).toContain("cancelSwitchAccount();")
    expect(adminHtml).not.toContain("Switch to this account?")
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

  test("renders usage under the active account instead of a separate tab", () => {
    expect(adminHtml).not.toContain('data-tab="usage"')
    expect(adminHtml).not.toContain('id="tab-usage"')
    expect(adminHtml).toContain("const usageSectionHtml =")
    expect(adminHtml).toContain("account-usage-item")
    expect(adminHtml).toContain("acc.isActive ? usageSectionHtml : ''")
    expect(adminHtml).toContain(
      "if (refreshUsage && hasActiveAccount) void fetchUsage();",
    )
  })

  test("sorts available models by name before rendering", () => {
    expect(adminHtml).toContain("const sortedModels = [...data.data].sort")
    expect(adminHtml).toContain("a.id.localeCompare(b.id")
    expect(adminHtml).toContain("numeric: true")
    expect(adminHtml).toContain("container.innerHTML = sortedModels.map")
    expect(adminHtml).not.toContain("container.innerHTML = data.data.map")
  })

  test("renders usage summary inside the active account row", () => {
    expect(adminHtml).toContain('id="activeUsageSummary"')
    expect(adminHtml).toContain("function renderUsageSummary(data)")
    expect(adminHtml).toContain("renderUsageSummary(data);")
    expect(adminHtml).toContain("account-summary-label")
    expect(adminHtml).toContain("Quota Reset Date")
    expect(adminHtml).not.toContain("usage-info-row")
  })

  test("renders quota cards as one-line text items", () => {
    expect(adminHtml).toContain(".container { max-width: 1200px;")
    expect(adminHtml).toContain(
      "grid-template-columns: repeat(3, minmax(0, 1fr))",
    )
    expect(adminHtml).toContain("usage-detail")
    expect(adminHtml).toContain("usage-status")
    expect(adminHtml).toContain("const usageLoadingHtml =")
    expect(adminHtml).toContain("usage-grid usage-grid-loading")
    expect(adminHtml).not.toContain("Loading usage data...")
    expect(adminHtml).toContain(" · <span")
    expect(adminHtml).toContain(" left")
    expect(adminHtml).not.toContain("usage-header")
    expect(adminHtml).not.toContain("usage-stats")
    expect(adminHtml).not.toContain("usage-bar")
    expect(adminHtml).not.toContain("usage-count")
    expect(adminHtml).not.toContain("usage-remaining")
  })
})
