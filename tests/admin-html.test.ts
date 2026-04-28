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
    expect(adminHtml).toContain("escHtml(log.method + ' ' + log.path)")
    expect(adminHtml).toContain("escHtml(channel)")
  })

  test("uses delegated data-action handlers instead of onclick strings", () => {
    expect(adminHtml).toContain("document.addEventListener('click'")
    expect(adminHtml).toContain("closest('[data-action]')")
    expect(adminHtml).toContain('data-action="delete-account"')
    expect(adminHtml).toContain('data-action="delete-mapping"')
    expect(adminHtml).not.toContain('onclick="switchAccount')
    expect(adminHtml).not.toContain('onclick="deleteAccount')
    expect(adminHtml).not.toContain('onclick="deleteMapping')
  })

  test("shows account activity status instead of binary account switching", () => {
    const actionsIndex = adminHtml.indexOf(
      "'<div class=\"account-actions\">' +",
    )
    const badgeIndex = adminHtml.indexOf(
      "'<span class=\"account-badge\">Active</span>' +",
    )
    const deleteIndex = adminHtml.indexOf(
      '\'<button class="btn btn-sm btn-danger"',
    )

    expect(actionsIndex).toBeGreaterThan(-1)
    expect(badgeIndex).toBeGreaterThan(actionsIndex)
    expect(deleteIndex).toBeGreaterThan(badgeIndex)
    expect(adminHtml).toContain("account-badge")
    expect(adminHtml).not.toContain("Switch account?")
    expect(adminHtml).not.toContain('data-action="switch"')
    expect(adminHtml).not.toContain('data-action="confirm-switch"')
    expect(adminHtml).not.toContain('data-action="cancel-switch"')
    expect(adminHtml).not.toContain("function requestSwitchAccount")
    expect(adminHtml).not.toContain("function switchAccount")
  })

  test("avoids unauthenticated resource fetch noise and keeps manual mapping entry available", () => {
    expect(adminHtml).toContain('rel="icon"')
    expect(adminHtml).toContain("let authStatus =")
    expect(adminHtml).toContain("const status = await fetchStatus();")
    expect(adminHtml).toContain("Add a GitHub account to load models.")
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

  test("does not render account quota usage in the admin UI", () => {
    expect(adminHtml).not.toContain('data-tab="usage"')
    expect(adminHtml).not.toContain('id="tab-usage"')
    expect(adminHtml).not.toContain("Usage Statistics")
    expect(adminHtml).not.toContain("Quota Reset Date")
    expect(adminHtml).not.toContain("Chat Enabled")
    expect(adminHtml).not.toContain("activeUsageSummary")
    expect(adminHtml).not.toContain("usageContent")
    expect(adminHtml).not.toContain("fetchUsage")
    expect(adminHtml).not.toContain("renderUsage")
    expect(adminHtml).not.toContain('data-action="refresh-usage"')
    expect(adminHtml).not.toContain("fetch('/usage')")
  })

  test("sorts available models by name before rendering", () => {
    expect(adminHtml).toContain("const sortedModels = [...data.data].sort")
    expect(adminHtml).toContain("a.id.localeCompare(b.id")
    expect(adminHtml).toContain("numeric: true")
    expect(adminHtml).toContain("container.innerHTML = sortedModels.map")
    expect(adminHtml).not.toContain("container.innerHTML = data.data.map")
  })

  test("renders request logs as a separate tab next to models", () => {
    const modelsTabIndex = adminHtml.indexOf('data-tab="models"')
    const requestLogsTabIndex = adminHtml.indexOf('data-tab="request-logs"')
    const mappingsTabIndex = adminHtml.indexOf('data-tab="model-mappings"')
    const accountsPanelStart = adminHtml.indexOf('id="tab-accounts"')
    const modelsPanelStart = adminHtml.indexOf('id="tab-models"')
    const accountsPanelHtml = adminHtml.slice(
      accountsPanelStart,
      modelsPanelStart,
    )

    expect(modelsTabIndex).toBeGreaterThan(-1)
    expect(requestLogsTabIndex).toBeGreaterThan(modelsTabIndex)
    expect(mappingsTabIndex).toBeGreaterThan(requestLogsTabIndex)
    expect(accountsPanelHtml).not.toContain('id="requestLogs"')
    expect(adminHtml).toContain('id="tab-request-logs"')
    expect(adminHtml).toContain("Request Logs")
    expect(adminHtml).toContain('id="requestLogs"')
    expect(adminHtml).toContain('id="refreshRequestLogs"')
    expect(adminHtml).toContain("function fetchRequestLogs()")
    expect(adminHtml).toContain("API_BASE + '/request-logs'")
    expect(adminHtml).toContain("function renderRequestLogs(logs)")
    expect(adminHtml).toContain("tab.dataset.tab === 'request-logs'")
    expect(adminHtml).not.toContain("Recent Requests")
    expect(adminHtml).not.toContain("fetchAccounts(); fetchRequestLogs();")
    expect(adminHtml).toContain("Legacy active account")
    expect(adminHtml).toContain("request-log-channel")
  })
})
