export function readEmailChangeProof(
  location: Pick<Location, "href">,
  history: Pick<History, "state" | "replaceState">,
): string | null {
  const url = new URL(location.href);
  const token = url.hash.slice(1) || url.searchParams.get("token");
  history.replaceState(history.state, "", url.pathname);
  return token && /^[A-Za-z0-9_-]{43}$/u.test(token) ? token : null;
}
