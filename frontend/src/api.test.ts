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
