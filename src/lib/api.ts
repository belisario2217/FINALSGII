const TOKEN_KEY = "aula-nova-token";
const API_BASE_URL = (import.meta.env.VITE_API_URL || "/api").replace(/\/$/, "");

function apiUrl(path: string) {
  return `${API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

type RequestOptions = Omit<RequestInit, "body"> & {
  body?: BodyInit | Record<string, unknown> | unknown[];
};

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  let body = options.body;
  if (body && !(body instanceof FormData) && typeof body !== "string") {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(body);
  }
  const response = await fetch(apiUrl(path), { ...options, headers, body: body as BodyInit });
  if (response.status === 401 && path !== "/auth/login") {
    setToken(null);
    window.location.assign("/login");
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: "No fue posible completar la solicitud." }));
    throw new Error(error.message || "No fue posible completar la solicitud.");
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}

export async function download(path: string, filename: string) {
  const token = getToken();
  const response = await fetch(apiUrl(path), {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: "No fue posible generar el archivo." }));
    throw new Error(error.message);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function openDocument(path: string) {
  const token = getToken();
  fetch(apiUrl(path), { headers: token ? { Authorization: `Bearer ${token}` } : undefined })
    .then(async (response) => {
      if (!response.ok) throw new Error((await response.json()).message);
      const url = URL.createObjectURL(await response.blob());
      window.open(url, "_blank", "noopener,noreferrer");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    });
}
