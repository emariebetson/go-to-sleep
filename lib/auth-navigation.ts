export function signInPath(returnTo = "/studio") {
  return `/sign-in?returnTo=${encodeURIComponent(safeRelativeReturnPath(returnTo))}`;
}

export function safeRelativeReturnPath(value: string) {
  if (!value.startsWith("/") || value.startsWith("//")) return "/studio";
  try {
    const url = new URL(value, "https://nearnight.local");
    if (url.origin !== "https://nearnight.local" || url.pathname.startsWith("/api/auth") || url.pathname === "/sign-in") return "/studio";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/studio";
  }
}
