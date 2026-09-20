export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fieldErrors: Record<string, string[]> = {}
  ) {
    super(message);
  }
}

type ApiOptions = Omit<RequestInit, "body"> & { body?: unknown };

export async function request<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const { body, ...requestOptions } = options;
  const headers = new Headers(options.headers);
  const init: RequestInit = {
    ...requestOptions,
    credentials: "include",
    headers
  };
  if (body !== undefined && !(body instanceof FormData)) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  } else if (body instanceof FormData) {
    init.body = body;
  }

  const response = await fetch(`/api/v1${path}`, init);
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = payload.error ?? {};
    const code = error.code ?? "REQUEST_FAILED";
    if (response.status === 401 && ["UNAUTHENTICATED", "SESSION_EXPIRED"].includes(code) && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("handcraft:unauthorized"));
    }
    throw new ApiError(response.status, code, error.message ?? "请求失败", error.fieldErrors ?? {});
  }
  return payload as T;
}

export async function download(path: string): Promise<void> {
  const response = await fetch(`/api/v1${path}`, { credentials: "include" });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const error = payload.error ?? {};
    const code = error.code ?? "DOWNLOAD_FAILED";
    if (response.status === 401 && ["UNAUTHENTICATED", "SESSION_EXPIRED"].includes(code)) {
      window.dispatchEvent(new CustomEvent("handcraft:unauthorized"));
    }
    throw new ApiError(response.status, code, error.message ?? "导出失败", error.fieldErrors ?? {});
  }

  const disposition = response.headers.get("content-disposition") ?? "";
  const filenameMatch = /filename="?([^";]+)"?/i.exec(disposition);
  const filename = filenameMatch?.[1] ?? "handcraft-export";
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
