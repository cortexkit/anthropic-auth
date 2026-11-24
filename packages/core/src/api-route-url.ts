/** Parse an API-route override, rejecting credentials embedded in the URL. */
function parseBaseUrl(raw: string | undefined): URL | null {
  const value = raw?.trim()
  if (!value) return null
  try {
    const baseUrl = new URL(value)
    if (
      (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') ||
      baseUrl.username ||
      baseUrl.password
    ) {
      return null
    }
    return baseUrl
  } catch {
    return null
  }
}

/** Apply an explicit API-route URL or the environment override to a request URL. */
export function applyAnthropicApiBaseUrl(
  requestUrl: URL,
  explicitBaseURL?: string,
): void {
  const baseUrl = parseBaseUrl(
    explicitBaseURL || process.env.ANTHROPIC_BASE_URL,
  )
  if (!baseUrl) return

  const basePath = baseUrl.pathname.replace(/\/$/, '')
  const inputPath = requestUrl.pathname
  requestUrl.protocol = baseUrl.protocol
  requestUrl.host = baseUrl.host

  const alreadyUnderBase =
    inputPath === basePath ||
    (basePath !== '' && inputPath.startsWith(`${basePath}/`))
  if (!alreadyUnderBase) {
    const baseEndsInVersion = /\/v\d[^/]*$/.test(basePath)
    if (inputPath === '/messages') {
      requestUrl.pathname = baseEndsInVersion
        ? `${basePath}/messages`
        : `${basePath}/v1/messages`
    } else if (inputPath === '/v1/messages' && baseEndsInVersion) {
      requestUrl.pathname = `${basePath}/messages`
    } else {
      requestUrl.pathname = `${basePath}${inputPath}`
    }
  } else if (inputPath === `${basePath}/messages`) {
    // Repair only the exact SDK form under a non-versioned base. Do not
    // rewrite sibling resources or explicit /v2 (and later) proxy paths.
    if (!/\/v\d[^/]*$/.test(basePath)) {
      requestUrl.pathname = `${basePath}/v1/messages`
    }
  }
}
