export async function fetchJson(
  url: string | URL,
  options: RequestInit,
  fetcher: typeof fetch = fetch,
  timeoutMs = 20000,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, {
      ...options,
      redirect: "error",
      signal: controller.signal,
    });
    return {
      ok: response.ok,
      status: response.status,
      data: response.ok ? await response.json() : null,
    };
  } finally {
    clearTimeout(timer);
  }
}
