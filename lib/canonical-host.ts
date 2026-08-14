const CANONICAL_ORIGIN = "https://nearyoustill.com";
const REDIRECT_HOSTS = new Set(["www.nearyoustill.com", "nearnight.ebetson.chatgpt.site"]);
const SAFE_CAMPAIGN_FIELDS = new Set(["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "gclid", "fbclid"]);

function sanitizedReturnTo(value: string) {
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  try {
    const parsed = new URL(value, CANONICAL_ORIGIN);
    if (parsed.origin !== CANONICAL_ORIGIN || parsed.pathname === "/api" || parsed.pathname.startsWith("/api/") || parsed.pathname === "/auth" || parsed.pathname.startsWith("/auth/") || parsed.pathname === "/sign-in") return null;
    const safe = new URL(parsed.pathname, CANONICAL_ORIGIN);
    for (const [key, nestedValue] of parsed.searchParams) if (SAFE_CAMPAIGN_FIELDS.has(key) && nestedValue.length <= 200) safe.searchParams.append(key, nestedValue);
    return `${safe.pathname}${safe.search}`;
  } catch { return null; }
}

function isNonPagePath(pathname: string) {
  if (pathname === "/api" || pathname.startsWith("/api/") || pathname === "/auth" || pathname.startsWith("/auth/") || pathname === "/sign-in") return true;
  if (pathname.startsWith("/_next/") || pathname.startsWith("/_vinext/") || pathname.startsWith("/_")) return true;
  return /\/[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,12}$/.test(pathname);
}

export function canonicalRedirect(request: Request, enabled: boolean): Response | null {
  if (!enabled || (request.method !== "GET" && request.method !== "HEAD")) return null;
  const incoming = new URL(request.url);
  if (!REDIRECT_HOSTS.has(incoming.hostname)) return null;
  if (isNonPagePath(incoming.pathname)) return null;

  const destination = new URL(incoming.pathname, CANONICAL_ORIGIN);
  for (const [key, value] of incoming.searchParams) {
    if (SAFE_CAMPAIGN_FIELDS.has(key) && value.length <= 200) destination.searchParams.append(key, value);
    if (key === "returnTo" && value.length <= 500) {
      const safe = sanitizedReturnTo(value);
      if (safe) destination.searchParams.set(key, safe);
    }
  }
  return Response.redirect(destination, 308);
}
