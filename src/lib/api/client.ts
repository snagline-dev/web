import { tokenStore } from "./tokenStore";

const API_BASE = import.meta.env.VITE_API_URL ?? "";

interface ApiErrorBody {
  message?: string;
  code?: string;
}

export class ApiError extends Error {
  status: number;
  body: ApiErrorBody;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message ?? `Request failed with status ${status}`);
    this.status = status;
    this.body = body;
  }
}

// Single-flight refresh: concurrent 401s from the same session share one
// `/auth/refresh` call. The in-flight promise is keyed to the store version it
// started at, so a refresh begun for a previous session is never handed to a
// newer one — a fresh login must trigger its own refresh.
let inFlightRefresh: { version: number; promise: Promise<string | null> } | null = null;

export async function refreshAccessToken(): Promise<string | null> {
  // Snapshot the store version now. If a logout or login writes to the store
  // while this request is in flight, the compare-and-set below is rejected so
  // we never restore a superseded session.
  const startVersion = tokenStore.getVersion();

  // Reuse an in-flight refresh only if it began under the current token state.
  if (inFlightRefresh && inFlightRefresh.version === startVersion) {
    return inFlightRefresh.promise;
  }

  const promise = (async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: "POST",
        credentials: "include", // sends the httpOnly refresh cookie
      });

      if (!res.ok) {
        const applied = tokenStore.setIfVersion(startVersion, null);
        // A newer login/logout already superseded us: leave its token in place
        // and let the 401 retry use the live session rather than failing.
        return applied ? null : tokenStore.get();
      }

      const data = await res.json();
      const applied = tokenStore.setIfVersion(startVersion, data.accessToken);
      // If a newer login/logout already superseded us, defer to the current
      // token so a 401 retry uses the live session rather than our stale one.
      return applied ? (data.accessToken as string) : tokenStore.get();
    } catch {
      const applied = tokenStore.setIfVersion(startVersion, null);
      return applied ? null : tokenStore.get();
    } finally {
      // Clear only if this is still the current entry — a newer session may
      // have replaced it. Successive entries have strictly increasing, unique
      // versions, so this comparison is unambiguous.
      if (inFlightRefresh?.version === startVersion) inFlightRefresh = null;
    }
  })();

  inFlightRefresh = { version: startVersion, promise };
  return promise;
}

interface RequestOptions extends RequestInit {
  skipAuth?: boolean; // for request-code / verify-code — no access token to send yet
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { skipAuth, headers, ...rest } = options;

  const doFetch = () => {
    const token = tokenStore.get();
    return fetch(`${API_BASE}${path}`, {
      ...rest,
      credentials: "include",
      headers: {
        ...(rest.body ? { "Content-Type": "application/json" } : {}),
        ...(token && !skipAuth ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
    });
  };

  let res = await doFetch();

  if (res.status === 401 && !skipAuth) {
    const newToken = await refreshAccessToken();
    res = newToken ? await doFetch() : res; // retry once, or fall through to the error below
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body);
  }

  return res.status === 204 ? (undefined as T) : res.json();
}
