import type { ModelsResponse } from "~/services/copilot/get-models"

export interface RuntimeAccount {
  id: string
  login: string
  avatarUrl: string
  token: string
  accountType: "individual" | "business" | "enterprise"
  createdAt: string
}

export interface State {
  githubToken?: string
  copilotToken?: string
  accounts?: Array<RuntimeAccount>

  accountType: string
  models?: ModelsResponse
  vsCodeVersion?: string

  rateLimitWait: boolean
  showToken: boolean

  // Rate limiting configuration
  rateLimitSeconds?: number
  lastRequestTimestamp?: number
  verbose: boolean
}

export const state: State = {
  accountType: "individual",
  rateLimitWait: false,
  showToken: false,
  verbose: false,
}
