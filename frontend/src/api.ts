export const FRONTEND_BUILD_ID =
  typeof __ITLES_FRONTEND_BUILD_ID__ === "string"
    ? __ITLES_FRONTEND_BUILD_ID__
    : "unknown";

function requestPathname(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.pathname
      : undefined;
  } catch {
    return undefined;
  }
}

const responseCodes = new Map([
  ["authentication required", "authentication_required"],
  ["current password is invalid", "current_password_invalid"],
  ["invalid account, login, or password", "invalid_credentials"],
  ["too many authentication attempts; try again later", "auth_rate_limited"],
  ["demo session limit reached; try again later", "demo_rate_limited"],
  ["demo session capacity reached; try again later", "demo_capacity_reached"],
  ["demo is disabled", "demo_disabled"],
  ["registration is disabled", "registration_disabled"],
  [
    "new data arrived; refresh and compare before review",
    "source_review_outdated",
  ],
  [
    "configure normalized_json source and confirm permission before issuing a token",
    "source_permission_required",
  ],
]);

export class ApiError extends Error {
  public readonly occurredAt = new Date().toISOString();
  public readonly endpoint?: string;

  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly requestId?: string,
    requestUrl?: string,
  ) {
    super(message);
    this.name = "ApiError";
    this.endpoint = requestPathname(requestUrl);
    this.code = code && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : undefined;
    this.requestId =
      requestId && /^[A-Za-z0-9._-]{1,128}$/.test(requestId)
        ? requestId
        : undefined;
  }
}

export async function request<T>(
  url: string,
  options?: RequestInit,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort(options?.signal?.reason);
  options?.signal?.addEventListener("abort", cancel, { once: true });
  if (options?.signal?.aborted) cancel();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 20_000);
  try {
    controller.signal.throwIfAborted();
    const result = await performRequest<T>(url, {
      ...options,
      signal: controller.signal,
    });
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (timedOut) {
      throw new ApiError(
        0,
        "Сервер не ответил за 20 секунд. Проверьте соединение. Если вы сохраняли данные, сначала проверьте результат действия перед повторной отправкой.",
        "request_timeout",
        undefined,
        url,
      );
    }
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    options?.signal?.removeEventListener("abort", cancel);
  }
}

async function performRequest<T>(
  url: string,
  options: RequestInit,
): Promise<T> {
  const endpoint = requestPathname(url);
  let response: Response;
  try {
    response = await fetch(url, {
      credentials: "same-origin",
      ...options,
      headers: { "Content-Type": "application/json", ...options?.headers },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ApiError(
      0,
      "Нет связи с сервером. Проверьте соединение и повторите попытку.",
      "network_error",
      undefined,
      url,
    );
  }
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new ApiError(
      response.status,
      "Сервер ответил не в формате API. Повторите попытку; если ошибка останется, передайте адрес страницы и код ответа обслуживающему специалисту. Для ИТлес нужен сервер приложения, не только статическая страница.",
      "non_json_response",
      response.headers.get("x-request-id") ?? undefined,
      url,
    );
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const detail =
      body && typeof body === "object" && "detail" in body ? body.detail : null;
    const code =
      (typeof detail === "string" ? responseCodes.get(detail) : undefined) ??
      `http_${response.status}`;
    const authForm = endpoint?.startsWith("/api/auth/");
    let message =
      "Не удалось получить данные. Повторите запрос; если ошибка останется, сообщите администратору.";
    if (response.status === 401) {
      message =
        detail === "current password is invalid"
          ? "Текущий пароль не подошёл. Проверьте его и повторите действие."
          : authForm && endpoint !== "/api/auth/me"
            ? "Не удалось подтвердить доступ. Проверьте код компании, логин и пароль или одноразовый код. Вход не создаёт учётную запись."
            : "Сеанс завершён или доступ отозван. Войдите снова.";
    } else if (response.status === 429) {
      message =
        detail === "demo session capacity reached; try again later"
          ? "Учебный парк достиг лимита одновременных сеансов. Попробуйте позже: неиспользуемые сеансы истекают в течение часа."
          : "Слишком много попыток. Подождите перед повторным входом.";
    } else if (response.status === 404 && endpoint === "/api/auth/demo") {
      message =
        "Учебный парк отключён на этом сервере. Используйте выданный доступ организации.";
    } else if (response.status === 422) {
      message =
        authForm || (options?.method && options.method !== "GET")
          ? "Сервер не принял форму. Проверьте заполненные поля, допустимые символы и длину пароля."
          : "Проверьте выбранный период: сервер не принял параметры запроса.";
    } else if (response.status === 409) {
      message =
        detail === "new data arrived; refresh and compare before review"
          ? "Поступили новые данные. Нажмите «Проверить поступление» и сравните обновлённые значения с источником."
          : detail ===
              "configure normalized_json source and confirm permission before issuing a token"
            ? "Сначала сохраните поддерживаемый источник JSON и подтвердите разрешение на чтение данных."
            : "Этот код уже используется или данные изменились. Выберите другой код либо обновите страницу.";
    } else if (response.status === 403) {
      message =
        "Сервер отклонил запрос. Проверьте адрес сайта и права доступа у администратора.";
    } else if (response.status === 503 || response.status >= 500) {
      message =
        endpoint === "/api/auth/demo"
          ? "Сейчас не удалось открыть учебный парк. Сервер временно недоступен; повторите попытку позже."
          : "Сервер временно недоступен. Повторите попытку позже; если ошибка остаётся, сообщите обслуживающему специалисту.";
    }
    throw new ApiError(
      response.status,
      message,
      code,
      response.headers.get("x-request-id") ?? undefined,
      url,
    );
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError(
      response.status,
      "Сервер вернул повреждённые данные. Повторите запрос.",
      "invalid_json_response",
      response.headers.get("x-request-id") ?? undefined,
      url,
    );
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Действие не выполнено. Повторите попытку.";
}
