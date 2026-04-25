import consola from "consola"
import { getProxyForUrl } from "proxy-from-env"
import { Agent, ProxyAgent, setGlobalDispatcher, type Dispatcher } from "undici"

export interface ProxyApplyOptions {
  useEnvironmentProxy?: boolean
}

type ProxyFetchInit = NonNullable<Parameters<typeof fetch>[1]> & {
  proxy?: string
}

let activeHttpProxyUrl: string | undefined
let originalFetch: typeof fetch | null = null
let fetchProxyInstalled = false

export function normalizeHttpProxyUrl(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined
  }

  if (typeof value !== "string") {
    throw new TypeError('"httpProxy" must be a string or null')
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }

  let proxyUrl: URL
  try {
    proxyUrl = new URL(trimmed)
  } catch {
    throw new Error('"httpProxy" must be a valid URL')
  }

  if (proxyUrl.protocol !== "http:" && proxyUrl.protocol !== "https:") {
    throw new Error('"httpProxy" must use http:// or https://')
  }

  if (
    (proxyUrl.pathname && proxyUrl.pathname !== "/")
    || proxyUrl.search
    || proxyUrl.hash
  ) {
    throw new Error('"httpProxy" must not include a path, query, or fragment')
  }

  return proxyUrl.toString()
}

export function getActiveHttpProxy(): string | undefined {
  return activeHttpProxyUrl
}

function isBunRuntime(): boolean {
  return typeof Bun !== "undefined"
}

function installBunFetchProxy(): void {
  if (fetchProxyInstalled) {
    return
  }

  originalFetch = globalThis.fetch
  const sourceFetch = originalFetch

  globalThis.fetch = ((
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    if (!activeHttpProxyUrl) {
      return sourceFetch(input, init)
    }

    const proxyInit: ProxyFetchInit = {
      ...init,
      proxy: activeHttpProxyUrl,
    }

    return sourceFetch(input, proxyInit)
  }) as typeof fetch
  fetchProxyInstalled = true
}

export function configureHttpProxy(value: unknown): string | undefined {
  const proxyUrl = normalizeHttpProxyUrl(value)
  activeHttpProxyUrl = proxyUrl

  if (isBunRuntime()) {
    if (proxyUrl) {
      installBunFetchProxy()
      consola.debug(`HTTP proxy configured: ${proxyUrl}`)
    } else {
      consola.debug("HTTP proxy disabled")
    }
    return proxyUrl
  }

  try {
    setGlobalDispatcher(proxyUrl ? new ProxyAgent(proxyUrl) : new Agent())
    consola.debug(
      proxyUrl ? `HTTP proxy configured: ${proxyUrl}` : "HTTP proxy disabled",
    )
  } catch (err) {
    consola.debug("Proxy setup skipped:", err)
  }

  return proxyUrl
}

export function applyHttpProxyConfig(
  value: unknown,
  options: ProxyApplyOptions = {},
): string | undefined {
  const proxyUrl = normalizeHttpProxyUrl(value)

  if (proxyUrl || !options.useEnvironmentProxy) {
    return configureHttpProxy(proxyUrl)
  }

  activeHttpProxyUrl = undefined
  if (!isBunRuntime()) {
    initProxyFromEnv()
  }

  return undefined
}

export function initProxyFromEnv(): void {
  if (typeof Bun !== "undefined") return

  try {
    const direct = new Agent()
    const proxies = new Map<string, ProxyAgent>()

    // We only need a minimal dispatcher that implements `dispatch` at runtime.
    // Typing the object as `Dispatcher` forces TypeScript to require many
    // additional methods. Instead, keep a plain object and cast when passing
    // to `setGlobalDispatcher`.
    const dispatcher = {
      dispatch(
        options: Dispatcher.DispatchOptions,
        handler: Dispatcher.DispatchHandler,
      ) {
        try {
          const origin =
            typeof options.origin === "string" ?
              new URL(options.origin)
            : (options.origin as URL)
          const get = getProxyForUrl as unknown as (
            u: string,
          ) => string | undefined
          const raw = get(origin.toString())
          const proxyUrl = raw && raw.length > 0 ? raw : undefined
          if (!proxyUrl) {
            consola.debug(`HTTP proxy bypass: ${origin.hostname}`)
            return (direct as unknown as Dispatcher).dispatch(options, handler)
          }
          let agent = proxies.get(proxyUrl)
          if (!agent) {
            agent = new ProxyAgent(proxyUrl)
            proxies.set(proxyUrl, agent)
          }
          let label = proxyUrl
          try {
            const u = new URL(proxyUrl)
            label = `${u.protocol}//${u.host}`
          } catch {
            /* noop */
          }
          consola.debug(`HTTP proxy route: ${origin.hostname} via ${label}`)
          return (agent as unknown as Dispatcher).dispatch(options, handler)
        } catch {
          return (direct as unknown as Dispatcher).dispatch(options, handler)
        }
      },
      close() {
        return direct.close()
      },
      destroy() {
        return direct.destroy()
      },
    }

    setGlobalDispatcher(dispatcher as unknown as Dispatcher)
    consola.debug("HTTP proxy configured from environment (per-URL)")
  } catch (err) {
    consola.debug("Proxy setup skipped:", err)
  }
}

export function resetHttpProxyForTests(): void {
  activeHttpProxyUrl = undefined

  if (fetchProxyInstalled && originalFetch) {
    globalThis.fetch = originalFetch
  }

  originalFetch = null
  fetchProxyInstalled = false

  if (!isBunRuntime()) {
    setGlobalDispatcher(new Agent())
  }
}
