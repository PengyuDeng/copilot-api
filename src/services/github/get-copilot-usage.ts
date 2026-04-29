import { GITHUB_API_BASE_URL, githubHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { fetchWithTimeout } from "~/lib/fetch-timeout"
import { state } from "~/lib/state"

interface GitHubUsageRequestState {
  githubToken?: string
  vsCodeVersion?: string
}

export const getCopilotUsage = async (
  requestState: GitHubUsageRequestState = state,
): Promise<CopilotUsageResponse> => {
  const response = await fetchWithTimeout(
    `${GITHUB_API_BASE_URL}/copilot_internal/user`,
    {
      headers: githubHeaders(requestState),
    },
  )

  if (!response.ok) {
    throw new HTTPError("Failed to get Copilot usage", response)
  }

  return (await response.json()) as CopilotUsageResponse
}

export type CopilotQuotaId = "chat" | "completions" | "premium_interactions"

export interface QuotaDetail {
  entitlement: number
  has_quota?: boolean
  overage_count: number
  overage_permitted: boolean
  percent_remaining: number
  quota_reset_at?: number
  quota_id: string
  quota_remaining: number
  remaining: number
  timestamp_utc?: string
  unlimited: boolean
}

export type QuotaSnapshots = Partial<Record<CopilotQuotaId, QuotaDetail>>
export type CopilotQuotaMap = Partial<Record<CopilotQuotaId, number>>

export interface CopilotUsageResponse {
  access_type_sku: string
  analytics_tracking_id: string
  assigned_date: string
  can_signup_for_limited: boolean
  chat_enabled: boolean
  copilot_plan: string
  copilotignore_enabled?: boolean
  endpoints?: Record<string, string>
  is_mcp_enabled?: boolean
  limited_user_quotas?: CopilotQuotaMap
  limited_user_reset_date?: string
  limited_user_subscribed_day?: number
  login?: string
  monthly_quotas?: CopilotQuotaMap
  organization_login_list: Array<unknown>
  organization_list: Array<unknown>
  quota_reset_date?: string
  quota_reset_date_utc?: string
  quota_snapshots?: QuotaSnapshots
  restricted_telemetry?: boolean
}
