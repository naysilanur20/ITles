import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, request } from "./api";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("bounded API requests", () => {
  it("turns a hung request into an actionable timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, options: RequestInit) =>
          new Promise((_resolve, reject) =>
            options.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            ),
          ),
      ),
    );
    const outcome = request("/api/auth/demo").catch((error) => error);
    await vi.advanceTimersByTimeAsync(20_000);
    const error = await outcome;
    expect(error).toBeInstanceOf(ApiError);
    if (!(error instanceof ApiError)) throw error;
    expect(error.code).toBe("request_timeout");
    expect(error.message).toContain("проверьте результат действия");
  });

  it("preserves caller cancellation rather than displaying a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, options: RequestInit) =>
          new Promise((_resolve, reject) =>
            options.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            ),
          ),
      ),
    );
    const controller = new AbortController();
    const outcome = request("/api/machines", {
      signal: controller.signal,
    }).catch((error) => error);
    controller.abort();
    expect(await outcome).toMatchObject({ name: "AbortError" });
  });

  it("does not start a request that was already cancelled", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    controller.abort();
    await expect(
      request("/api/machines", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves a custom cancellation reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, options: RequestInit) =>
          new Promise((_resolve, reject) =>
            options.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            ),
          ),
      ),
    );
    const controller = new AbortController();
    const reason = new Error("view changed");
    const outcome = request("/api/machines", {
      signal: controller.signal,
    }).catch((error) => error);
    controller.abort(reason);
    expect(await outcome).toBe(reason);
  });

  it("preserves cancellation while the response body is being read", async () => {
    let cancelBody: () => void = () => {};
    const body = new Promise((_resolve, reject) => {
      cancelBody = () => reject(new DOMException("Aborted", "AbortError"));
    });
    const json = vi.fn(() => body);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "Content-Type": "application/json" }),
        json,
      }),
    );
    const controller = new AbortController();
    const outcome = request("/api/machines", {
      signal: controller.signal,
    }).catch((error) => error);
    await vi.waitFor(() => expect(json).toHaveBeenCalled());
    controller.abort();
    cancelBody();
    expect(await outcome).toMatchObject({ name: "AbortError" });
  });
});

describe("authentication errors", () => {
  it.each([
    "/api/auth/password",
    "/api/auth/recovery-code",
    "/api/admin/machines/test/tokens",
  ])(
    "does not mistake an incorrect current password for an expired session at %s",
    async (url) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({ detail: "current password is invalid" }),
            {
              status: 401,
              headers: { "Content-Type": "application/json" },
            },
          ),
        ),
      );
      await expect(
        request(url, { method: "POST", body: "{}" }),
      ).rejects.toMatchObject({
        status: 401,
        message:
          "Текущий пароль не подошёл. Проверьте его и повторите действие.",
      });
    },
  );
});

describe("safe request diagnostics", () => {
  it("records UTC failure time and request pathname without URL credentials or parameters", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T11:12:13.000Z"));
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ detail: "demo is disabled" }), {
            status: 404,
            headers: {
              "Content-Type": "application/json",
              "X-Request-Id": "synthetic-request-04",
            },
          }),
        ),
    );
    const error = await request(
      "https://synthetic-user:synthetic-password@example.test/api/auth/demo?token=synthetic-query#synthetic-fragment",
    ).catch((failure) => failure);
    expect(error).toBeInstanceOf(ApiError);
    if (!(error instanceof ApiError)) throw error;
    expect(error).toMatchObject({
      endpoint: "/api/auth/demo",
      occurredAt: "2026-09-16T11:12:13.000Z",
      status: 404,
      code: "demo_disabled",
      requestId: "synthetic-request-04",
    });
    expect(error.message).toContain("Учебный парк отключён");
    expect(JSON.stringify(error)).not.toMatch(
      /synthetic-user|synthetic-password|synthetic-query|synthetic-fragment|example\.test/,
    );
  });

  it("never retains arbitrary error response bodies or request credentials as diagnostic codes", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              detail: "password=synthetic-body-secret",
              cookie: "synthetic-response-cookie",
            }),
            {
              status: 500,
              headers: {
                "Content-Type": "application/json",
                "X-Request-Id": "cookie=synthetic-header-secret",
              },
            },
          ),
        ),
    );
    const error = await request("/api/auth/demo?key=synthetic-query-secret", {
      method: "POST",
      body: JSON.stringify({ password: "synthetic-request-secret" }),
      headers: { Authorization: "Bearer synthetic-bearer-secret" },
    }).catch((failure) => failure);
    if (!(error instanceof ApiError)) throw error;
    expect(error).toMatchObject({
      endpoint: "/api/auth/demo",
      status: 500,
      code: "http_500",
    });
    expect(error.requestId).toBeUndefined();
    expect(JSON.stringify(error)).not.toMatch(
      /synthetic-.*secret|synthetic-response-cookie/,
    );
    expect(error.message).not.toContain("synthetic-");
  });

  it.each([
    [
      "non_json_response",
      () =>
        new Response("<html>synthetic-private-page</html>", {
          status: 405,
          headers: {
            "Content-Type": "text/html",
            "X-Request-Id": "synthetic-html-id",
          },
        }),
    ],
    [
      "invalid_json_response",
      () =>
        new Response("{ synthetic-private-json", {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Request-Id": "synthetic-json-id",
          },
        }),
    ],
  ])(
    "records request context for %s without response contents",
    async (code, response) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response()));
      const error = await request("/api/auth/demo?ignored=yes#ignored").catch(
        (failure) => failure,
      );
      if (!(error instanceof ApiError)) throw error;
      expect(error).toMatchObject({ endpoint: "/api/auth/demo", code });
      expect(error.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      expect(error.requestId).toMatch(/^synthetic-/);
      expect(JSON.stringify(error)).not.toMatch(/synthetic-private|ignored/);
    },
  );

  it("records network failure context without preserving the transport exception", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("synthetic-transport-secret")),
    );
    const error = await request("/api/auth/demo?token=synthetic-query").catch(
      (failure) => failure,
    );
    expect(error).toMatchObject({
      endpoint: "/api/auth/demo",
      status: 0,
      code: "network_error",
    });
    expect(JSON.stringify(error)).not.toContain("synthetic-");
  });

  it("records the endpoint and UTC time when a request times out", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T11:12:00.000Z"));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, options: RequestInit) =>
          new Promise((_resolve, reject) =>
            options.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            ),
          ),
      ),
    );
    const outcome = request("/api/auth/demo?secret=synthetic-secret").catch(
      (failure) => failure,
    );
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await outcome).toMatchObject({
      endpoint: "/api/auth/demo",
      occurredAt: "2026-09-16T11:12:20.000Z",
      status: 0,
      code: "request_timeout",
    });
  });
});
