import { describe, expect, test } from "bun:test"

import { adminHtml } from "~/routes/admin/html"

describe("adminHtml hardening", () => {
  test("escapes user-controlled fields before innerHTML insertion", () => {
    expect(adminHtml).toContain("function escHtml(s)")
    expect(adminHtml).toContain("escHtml(acc.avatarUrl || '')")
    expect(adminHtml).toContain("escHtml(acc.login)")
    expect(adminHtml).toContain("escHtml(acc.accountType)")
    expect(adminHtml).toContain("escHtml(model.id)")
    expect(adminHtml).toContain("escHtml(model.display_name || model.id)")
    expect(adminHtml).toContain("escHtml(model.owned_by || '-')")
    expect(adminHtml).toContain("escHtml(model.model_picker_category || '-')")
    expect(adminHtml).toContain("escHtml(account.login || account.id")
    expect(adminHtml).toContain("escHtml(account.accountType || '')")
    expect(adminHtml).toContain("escHtml(usage.error || 'Failed')")
    expect(adminHtml).toContain("escHtml(value)")
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
    expect(adminHtml).toContain("accountCount: 0")
    expect(adminHtml).toContain("const status = await fetchStatus();")
    expect(adminHtml).toContain("if (!status.hasAccounts)")
    expect(adminHtml).not.toContain("if (!status.authenticated)")
    expect(adminHtml).toContain("formatAccountCount(authStatus.accountCount)")
    expect(adminHtml).toContain("'Connected: ' +")
    expect(adminHtml).not.toContain("'Connected as '")
    expect(adminHtml).toContain("Add a GitHub account to load models.")
    expect(adminHtml).toContain(
      'id="mappingTo" list="mappingToOptions" placeholder="Target model"',
    )
    expect(adminHtml).toContain('<datalist id="mappingToOptions"></datalist>')
    expect(adminHtml).toContain(
      "Target model (add account to load suggestions)",
    )
  })

  test("polls authorization without overlapping interval requests", () => {
    expect(adminHtml).toContain("function scheduleAuthPoll")
    expect(adminHtml).toContain("clearTimeout(pollInterval)")
    expect(adminHtml).toContain("pollInterval = setTimeout")
    expect(adminHtml).toContain("scheduleAuthPoll(deviceCode, accountType")
    expect(adminHtml).not.toContain("setInterval(() => pollAuth")
    expect(adminHtml).not.toContain("clearInterval(pollInterval)")
  })

  test("exposes HTTP proxy settings in the admin UI", () => {
    expect(adminHtml).toContain('for="httpProxy"')
    expect(adminHtml).toContain('id="httpProxy"')
    expect(adminHtml).toContain('id="proxyNotice"')
    expect(adminHtml).toContain("all outbound GitHub and Copilot requests")
    expect(adminHtml).toContain("data.httpProxy ?? ''")
    expect(adminHtml).toContain("API_BASE + '/models?refresh=true'")
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

  test("renders multi-account quota usage in the accounts UI", () => {
    expect(adminHtml).not.toContain('data-tab="usage"')
    expect(adminHtml).not.toContain('id="tab-usage"')
    expect(adminHtml).not.toContain("Usage Statistics")
    expect(adminHtml).not.toContain("Quota Reset Date")
    expect(adminHtml).not.toContain("Chat Enabled")
    expect(adminHtml).not.toContain("activeUsageSummary")
    expect(adminHtml).not.toContain("usageContent")
    expect(adminHtml).not.toContain('data-action="refresh-usage"')
    expect(adminHtml).not.toContain("fetch('/usage')")
    expect(adminHtml).toContain("let accountUsageById = {}")
    expect(adminHtml).toContain("function fetchAccountUsage()")
    expect(adminHtml).toContain("API_BASE + '/accounts/usage'")
    expect(adminHtml).toContain("function renderAccountUsage(acc)")
    expect(adminHtml).toContain("accountUsageById[acc.id]")
    expect(adminHtml).toContain("formatQuotaValue(quotas.chat)")
    expect(adminHtml).toContain("formatQuotaValue(quotas.completions)")
    expect(adminHtml).toContain("formatQuotaValue(quotas.premium_interactions)")
    expect(adminHtml).toContain("function formatQuotaValue(quota)")
    expect(adminHtml).toContain("return remaining + ' / ' + entitlement")
  })

  test("sorts available models by name before rendering", () => {
    expect(adminHtml).toContain("const sortedModels = [...data.data].sort")
    expect(adminHtml).toContain("a.id.localeCompare(b.id")
    expect(adminHtml).toContain("numeric: true")
    expect(adminHtml).toContain("const rows = sortedModels.map")
    expect(adminHtml).toContain(
      'container.innerHTML = \'<div class="models-table-wrap"',
    )
    expect(adminHtml).not.toContain("const rows = data.data.map")
  })

  test("renders model billing and support accounts in a table", () => {
    expect(adminHtml).toContain("API_BASE + '/models'")
    expect(adminHtml).toContain("models-table")
    expect(adminHtml).toContain("<th>Billing</th>")
    expect(adminHtml).toContain("model.supportedAccounts")
    expect(adminHtml).toContain("model.billing || {}")
    expect(adminHtml).toContain("billing.multiplier")
    expect(adminHtml).toContain("typeof billing.is_premium === 'boolean'")
    expect(adminHtml).toContain("billingKnown ?")
    expect(adminHtml).toContain("Unknown")
    expect(adminHtml).toContain("model-billing-ratio")
    expect(adminHtml).toContain("model-account-chip")
    expect(adminHtml).toContain("No account details")
    expect(adminHtml).not.toContain("models-grid")
    expect(adminHtml).not.toContain("model-card")
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
    expect(adminHtml).toContain("formatRequestLogChannel")
    expect(adminHtml).toContain("Legacy active account")
    expect(adminHtml).toContain("Route unavailable")
    expect(adminHtml).toContain("request-log-channel")
  })
})
