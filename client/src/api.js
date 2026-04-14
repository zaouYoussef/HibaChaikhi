const FALLBACK_API_URL = "https://hibachaikhi-production.up.railway.app";
const BASE = import.meta.env.VITE_API_URL ?? FALLBACK_API_URL;

export function apiUrl(path) {
  if (path.startsWith("http")) return path;
  return `${BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

export async function apiFetch(path, options = {}) {
  const token = localStorage.getItem("token");
  const headers = {
    "Content-Type": "application/json",
    ...options.headers,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(apiUrl(path), { ...options, headers });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) {
    let msg = res.statusText;
    if (typeof data?.error === "string") msg = data.error;
    else if (data?.error?.formErrors) {
      msg = JSON.stringify(data.error.formErrors);
    } else if (data?.error) {
      msg = JSON.stringify(data.error);
    }
    const err = new Error(msg);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}
