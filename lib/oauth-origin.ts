export function canonicalAuthRedirect(request: Request, canonicalOrigin: string): Response | null {
  const incoming = new URL(request.url);
  const canonical = new URL(canonicalOrigin);
  if (incoming.origin === canonical.origin) return null;
  const destination = new URL(`${incoming.pathname}${incoming.search}`, canonical.origin);
  return new Response(null, { status: 307, headers: { location: destination.toString(), "cache-control": "no-store" } });
}
