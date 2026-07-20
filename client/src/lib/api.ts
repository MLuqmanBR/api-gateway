const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
export const UNAUTHORIZED_EVENT = 'api-gateway:unauthorized';

export const TOKEN_KEY = 'api-gateway_dashboard_token';

/** Read the dashboard auth token from localStorage. Used by non-apiFetch
 *  callers (SettingsPage export, Playground) that need to set Authorization
 *  on a raw fetch. apiFetch itself relies on the HttpOnly session cookie. */
export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    // `...options` first so an explicit method/body/signal applies, but headers
    // are merged last — otherwise an options.headers would clobber the
    // Content-Type we set here. The HttpOnly session cookie (#35) is sent
    // automatically for same-origin requests.
    ...options,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  if (res.status === 401) {
    // Session missing/expired — let the AuthGate re-render.
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { message: res.statusText } }));
    throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  }
  // A 200 whose body isn't JSON means this request never reached the API — the
  // usual cause is a reverse proxy (or static host) serving the dashboard's
  // index.html for /api/* instead of forwarding it to the backend. Without this
  // guard the raw res.json() throws an opaque "Unexpected token '<'", which on
  // the setup/login form surfaces as "sign up page cannot work". Say what's
  // actually wrong. (#257)
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `Expected JSON from ${path} but got a non-JSON response. The API isn't reachable at this origin — ` +
      `make sure the backend is running and that /api is forwarded to it, not served as the dashboard's static files.`,
    );
  }
}
