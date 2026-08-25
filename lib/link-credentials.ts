/**
 * The order number and token out of an emailed link, read once and replayed.
 *
 * H-15: the tracking and feedback emails have to carry credentials in the URL —
 * email is the private channel that makes handing them out reasonable. What is
 * avoidable is the token *staying* in the address bar afterwards, where it
 * reaches browser history, a bookmark, a shared screenshot, or the next person
 * to pick up the phone. So the token is stripped with `replaceState` as soon as
 * it has been read, and it travels to the API in a header rather than a query
 * string so it never lands in an access log either.
 *
 * That scrub is what makes reading destructive, and it is why the read cannot
 * simply be repeated: a second look at an already-cleaned URL finds no token,
 * which from the page's point of view is indistinguishable from a customer who
 * arrived without one. React does read more than once — it re-renders a
 * component from scratch when the server and browser markups disagree, and
 * double-invokes both state initialisers and effects under StrictMode — so the
 * answer is captured here, outside React, and every later caller is handed
 * exactly what the first one saw.
 *
 * Keyed by path so that /track and /feedback cannot be served each other's
 * credentials if someone reaches both without a full page load.
 *
 * Browser only. There is no URL to read on the server, and callers are expected
 * to have something else to render until there is.
 */
export type LinkCredentials = { order: string; token: string };

const captured = new Map<string, LinkCredentials>();

export function readLinkCredentials(): LinkCredentials {
  const url = new URL(window.location.href);
  const already = captured.get(url.pathname);
  if (already) return already;

  const credentials: LinkCredentials = {
    order: url.searchParams.get("order") ?? "",
    token: url.searchParams.get("token") ?? "",
  };
  if (credentials.token) {
    url.searchParams.delete("token");
    window.history.replaceState({}, "", url.toString());
  }
  captured.set(url.pathname, credentials);
  return credentials;
}
