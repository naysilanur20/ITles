import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-leaflet", () => ({
  MapContainer: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  GeoJSON: () => null,
  ZoomControl: () => null,
  useMap: () => ({ fitBounds: () => undefined, panTo: () => undefined }),
  Polyline: () => null,
  CircleMarker: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  Tooltip: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
}));
vi.mock("leaflet", () => ({
  default: { latLngBounds: (points: unknown) => points },
}));

import { App, DataView, FleetView, Overview, Workspace } from "./main";

const session = {
  organization: { id: "demo", name: "Учебная организация" },
  demo: false,
};
const machines = {
  machines: [
    {
      id: "harvester-01",
      name: "Харвестер 01",
      model: null,
      head: null,
      computer: null,
      connection_status: "fresh",
      metrics: [],
      position: null,
      last_seen: null,
    },
  ],
};
const fleet = {
  period: { start: "2026-01-01", end: "2026-01-14" },
  totals: [],
  machines: [],
  record_count: 0,
};
const detail = {
  ...machines.machines[0],
  production: [],
  totals: [],
  track: [],
  engine_hours: null,
};

function json(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("production map frontend", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("offers the three entry paths and opens the isolated demo", async () => {
    const fetchMock = vi.mocked(fetch);
    let authMeCalls = 0;
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/auth/me") {
        authMeCalls += 1;
        return authMeCalls === 1
          ? json({ detail: "Не авторизован" }, 401)
          : json({ ...session, demo: true });
      }
      if (url === "/api/auth/options") return json({ demo_enabled: true });
      if (url === "/api/auth/demo") return json({ ...session, demo: true });
      if (url === "/api/machines") return json(machines);
      if (url.startsWith("/api/fleet?")) return json(fleet);
      if (url.startsWith("/api/machines/")) return json(detail);
      return json({});
    });

    render(<App />);
    const user = userEvent.setup();
    await screen.findByRole("heading", {
      name: "Мониторинг харвестеров",
    });
    expect(
      screen.getByRole("button", { name: "Я администратор компании" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Войти в компанию" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Посмотреть демо" }),
    ).toBeVisible();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Посмотреть демо" }),
      ).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Посмотреть демо" }));

    expect(await screen.findByRole("heading", { name: "Парк" })).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/demo",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("keeps individual company login available when the demo is disabled", async () => {
    const fetchMock = vi.mocked(fetch);
    let authMeCalls = 0;
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/auth/me") {
        authMeCalls += 1;
        return authMeCalls === 1
          ? json({ detail: "Не авторизован" }, 401)
          : json(session);
      }
      if (url === "/api/auth/options") return json({ demo_enabled: false });
      if (url === "/api/auth/login") return json(session);
      if (url === "/api/machines") return json(machines);
      if (url.startsWith("/api/fleet?")) return json(fleet);
      if (url.startsWith("/api/machines/")) return json(detail);
      return json({});
    });

    render(<App />);
    const user = userEvent.setup();
    expect(
      await screen.findByRole("heading", {
        name: "Мониторинг харвестеров",
      }),
    ).toBeVisible();
    expect(
      await screen.findByText("Учебный парк отключён на этом сервере."),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Посмотреть демо" }),
    ).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Войти в компанию" }));
    expect(
      await screen.findByRole("heading", { name: "Войти в компанию" }),
    ).toBeVisible();

    await user.type(screen.getByLabelText("Код компании"), "forest-1");
    await user.type(screen.getByLabelText("Служебный логин"), "operator-1");
    await user.type(screen.getByLabelText("Пароль"), "correct-horse-battery");
    await user.click(screen.getByRole("button", { name: "Войти" }));

    expect(await screen.findByRole("heading", { name: "Парк" })).toBeVisible();
  });

  it("restores an existing organization session regardless of demo availability", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/auth/me") return json(session);
      if (url === "/api/auth/options") return json({ demo_enabled: true });
      if (url === "/api/machines") return json(machines);
      if (url.startsWith("/api/fleet?")) return json(fleet);
      if (url.startsWith("/api/machines/")) return json(detail);
      return json({});
    });

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Парк" })).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: /Мониторинг харвестеров/i }),
    ).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/auth/options",
      expect.anything(),
    );
  });

  it("lets an organization user inspect the password before submitting it", async () => {
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/auth/me")
        return json({ detail: "Не авторизован" }, 401);
      if (url === "/api/auth/options") return json({ demo_enabled: true });
      return json({});
    });

    render(<App />);
    const user = userEvent.setup();
    await screen.findByRole("heading", {
      name: "Мониторинг харвестеров",
    });
    await user.click(screen.getByRole("button", { name: "Войти в компанию" }));
    await screen.findByRole("heading", { name: "Войти в компанию" });

    const password = screen.getByLabelText("Пароль");
    const reveal = screen.getByRole("button", { name: "Показать пароль" });
    expect(password).toHaveAttribute("type", "password");
    expect(reveal).toHaveAttribute("aria-pressed", "false");

    await user.click(reveal);
    expect(password).toHaveAttribute("type", "text");
    expect(
      screen.getByRole("button", { name: "Скрыть пароль" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("uses the fixed demo data period instead of the browser's current date", async () => {
    const demoSession = {
      ...session,
      demo: true,
      data_period: { start: "2024-02-01", end: "2024-02-29" },
    };
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/machines") return json(machines);
      if (url.startsWith("/api/fleet?")) return json(fleet);
      if (url.startsWith("/api/machines/")) return json(detail);
      return json({});
    });

    render(<Workspace session={demoSession} onLogout={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Карта" }));

    expect(screen.getByLabelText("Дата начала периода")).toHaveValue(
      "2024-02-01",
    );
    expect(screen.getByLabelText("Дата окончания периода")).toHaveValue(
      "2024-02-29",
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/fleet?start=2024-02-01&end=2024-02-29",
        expect.anything(),
      ),
    );
  });

  it("refreshes packet quality outcomes when refresh is requested", async () => {
    let qualityCalls = 0;
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/machines") return json(machines);
      if (url.startsWith("/api/fleet?")) return json(fleet);
      if (url.startsWith("/api/machines/")) return json(detail);
      if (url === "/api/quality") {
        qualityCalls += 1;
        return json({
          counts: { accepted: qualityCalls, duplicates: 0, rejected: 0 },
          recent: [],
          limitations: [],
        });
      }
      return json({});
    });
    render(<Workspace session={session} onLogout={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Карта" }));
    await screen.findByRole("heading", { name: "Харвестер 01" });
    await userEvent.click(screen.getByRole("button", { name: "Приём данных" }));
    expect(
      screen.getByRole("heading", { name: "Приём данных", level: 1 }),
    ).toHaveFocus();
    await waitFor(() => expect(qualityCalls).toBe(1));
    await userEvent.click(screen.getByRole("button", { name: /Обновить/ }));
    await waitFor(() => expect(qualityCalls).toBe(2));
  });

  it("shows a loading state while the receipt journal is requested", async () => {
    let resolveQuality: ((response: Response) => void) | undefined;
    const qualityResponse = new Promise<Response>((resolve) => {
      resolveQuality = resolve;
    });
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/machines") return json(machines);
      if (url.startsWith("/api/fleet?")) return json(fleet);
      if (url.startsWith("/api/machines/")) return json(detail);
      if (url === "/api/quality") return qualityResponse;
      return json({});
    });

    render(<Workspace session={session} onLogout={vi.fn()} />);
    await screen.findByRole("region", { name: "Таблица машин" });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Приём данных" }));

    expect(await screen.findByText("Получаем журнал приёма…")).toBeVisible();
    resolveQuality?.(
      new Response(
        JSON.stringify({
          counts: { accepted: 0, duplicates: 0, rejected: 0 },
          recent: [],
          limitations: [],
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );
    expect(
      await screen.findByText("Приём пакетов ещё не зафиксирован."),
    ).toBeVisible();
  });

  it("stops document loading after a failed request and offers a retry", async () => {
    let documentRequests = 0;
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/machines") return json(machines);
      if (url.startsWith("/api/fleet?")) return json(fleet);
      if (url.startsWith("/api/machines/")) return json(detail);
      if (url === "/api/documents") {
        documentRequests += 1;
        return documentRequests === 1
          ? json({ detail: "Документы временно недоступны" }, 503)
          : json({ documents: [] });
      }
      return json({});
    });

    render(<Workspace session={session} onLogout={vi.fn()} />);
    await screen.findByRole("region", { name: "Таблица машин" });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Документы" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Сервер временно недоступен",
    );
    expect(
      screen.queryByText("Получаем список документов…"),
    ).not.toBeInTheDocument();

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Повторить загрузку" }));
    expect(
      await screen.findByText("Сервер пока не опубликовал документов."),
    ).toBeVisible();
  });

  it("returns to login when the documents API rejects the session", async () => {
    const onLogout = vi.fn();
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/machines") return json(machines);
      if (url.startsWith("/api/fleet?")) return json(fleet);
      if (url.startsWith("/api/machines/")) return json(detail);
      if (url === "/api/documents")
        return json({ detail: "Не авторизован" }, 401);
      return json({});
    });

    render(<Workspace session={session} onLogout={onLogout} />);
    await screen.findByRole("region", { name: "Таблица машин" });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Документы" }));

    await waitFor(() => expect(onLogout).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByRole("button", { name: "Повторить загрузку" }),
    ).not.toBeInTheDocument();
  });

  it("does not pretend a session ended when logout failed", async () => {
    const onLogout = vi.fn();
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/machines") return json(machines);
      if (url.startsWith("/api/fleet?")) return json(fleet);
      if (url.startsWith("/api/machines/")) return json(detail);
      if (url === "/api/auth/logout")
        return Promise.reject(new TypeError("offline"));
      return json({});
    });
    render(<Workspace session={session} onLogout={onLogout} />);
    fireEvent.click(screen.getByRole("button", { name: "Карта" }));
    await screen.findByRole("heading", { name: "Харвестер 01" });
    await userEvent.click(screen.getByRole("button", { name: "Выйти" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Сервер не подтвердил выход",
    );
    expect(onLogout).not.toHaveBeenCalled();
  });

  it("does not mistake a failed park request for an empty company", async () => {
    const adminSession = {
      ...session,
      user: { id: "admin-1", login: "admin", role: "admin" as const },
    };
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/machines")
        return json({ detail: "Сервис временно недоступен" }, 503);
      if (url.startsWith("/api/fleet?")) return json(fleet);
      return json({});
    });

    render(<Workspace session={adminSession} onLogout={vi.fn()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Сервер временно недоступен",
    );
    expect(
      screen.getByText(
        "Данные парка не получены. Нажмите «Обновить» после восстановления связи.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText(/В компании пока нет машин/i),
    ).not.toBeInTheDocument();
  });

  it("returns to login when an expired session rejects a workspace request", async () => {
    const onLogout = vi.fn();
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/machines")
        return json({ detail: "Не авторизован" }, 401);
      if (url.startsWith("/api/fleet?")) return json(fleet);
      return json({});
    });

    render(<Workspace session={session} onLogout={onLogout} />);

    await waitFor(() => expect(onLogout).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("returns to login when an expired session rejects a machine detail", async () => {
    const onLogout = vi.fn();
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/machines") return json(machines);
      if (url.startsWith("/api/fleet?")) return json(fleet);
      if (url.startsWith("/api/machines/"))
        return json({ detail: "Не авторизован" }, 401);
      return json({});
    });

    render(<Workspace session={session} onLogout={onLogout} />);

    await waitFor(() => expect(onLogout).toHaveBeenCalledTimes(1));
  });

  it("returns to login when an expired session rejects the quality audit", async () => {
    const onLogout = vi.fn();
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/machines") return json(machines);
      if (url.startsWith("/api/fleet?")) return json(fleet);
      if (url.startsWith("/api/machines/")) return json(detail);
      if (url === "/api/quality")
        return json({ detail: "Не авторизован" }, 401);
      return json({});
    });

    render(<Workspace session={session} onLogout={onLogout} />);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Приём данных" }));

    await waitFor(() => expect(onLogout).toHaveBeenCalledTimes(1));
  });

  it("does not render a stale machine detail after the period changes", async () => {
    let resolveOldDetail!: (value: Response | PromiseLike<Response>) => void;
    const oldDetail = new Promise<Response>((resolve) => {
      resolveOldDetail = resolve;
    });
    let detailCalls = 0;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/machines") return json(machines);
      if (url.startsWith("/api/fleet?")) return json(fleet);
      if (url.startsWith("/api/machines/")) {
        detailCalls += 1;
        return detailCalls === 1
          ? oldDetail
          : json({ ...detail, name: "Новая карточка" });
      }
      return json({});
    });

    render(<Workspace session={session} onLogout={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Карта" }));
    await waitFor(() => expect(detailCalls).toBe(1));

    fireEvent.change(screen.getByLabelText("Дата начала периода"), {
      target: { value: "2026-01-01" },
    });
    await waitFor(() => expect(detailCalls).toBe(2));
    expect(
      await screen.findByRole("heading", { name: "Новая карточка" }),
    ).toBeVisible();

    json({ ...detail, name: "Старая карточка" }).then(resolveOldDetail);
    await waitFor(() =>
      expect(screen.queryByText("Старая карточка")).not.toBeInTheDocument(),
    );
  });

  it("does not render a stale detail after selecting another machine", async () => {
    let resolveFirstDetail!: (value: Response | PromiseLike<Response>) => void;
    const firstDetail = new Promise<Response>((resolve) => {
      resolveFirstDetail = resolve;
    });
    const twoMachines = {
      machines: [
        ...machines.machines,
        { ...machines.machines[0], id: "harvester-02", name: "Харвестер 02" },
      ],
    };
    let detailCalls = 0;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/machines") return json(twoMachines);
      if (url.startsWith("/api/fleet?")) return json(fleet);
      if (url.startsWith("/api/machines/")) {
        detailCalls += 1;
        return detailCalls === 1
          ? firstDetail
          : json({ ...detail, id: "harvester-02", name: "Вторая карточка" });
      }
      return json({});
    });

    render(<Workspace session={session} onLogout={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Карта" }));
    await waitFor(() => expect(detailCalls).toBe(1));
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /Харвестер 02/i }));
    expect(
      await screen.findByRole("heading", { name: "Вторая карточка" }),
    ).toBeVisible();

    json({ ...detail, name: "Первая устаревшая карточка" }).then(
      resolveFirstDetail,
    );
    await waitFor(() =>
      expect(
        screen.queryByText("Первая устаревшая карточка"),
      ).not.toBeInTheDocument(),
    );
  });

  it("does not render a stale detail after a manual refresh", async () => {
    let resolveOldDetail!: (value: Response | PromiseLike<Response>) => void;
    const oldDetail = new Promise<Response>((resolve) => {
      resolveOldDetail = resolve;
    });
    let detailCalls = 0;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/machines") return json(machines);
      if (url.startsWith("/api/fleet?")) return json(fleet);
      if (url.startsWith("/api/machines/")) {
        detailCalls += 1;
        return detailCalls === 1
          ? oldDetail
          : json({ ...detail, name: "Карточка после обновления" });
      }
      return json({});
    });

    render(<Workspace session={session} onLogout={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Карта" }));
    await waitFor(() => expect(detailCalls).toBe(1));
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /Обновить/i }));
    expect(
      await screen.findByRole("heading", { name: "Карточка после обновления" }),
    ).toBeVisible();

    json({ ...detail, name: "Устаревшая карточка" }).then(resolveOldDetail);
    await waitFor(() =>
      expect(screen.queryByText("Устаревшая карточка")).not.toBeInTheDocument(),
    );
  });

  it("does not make a period request when a date is empty", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/machines") return json(machines);
      if (url.startsWith("/api/fleet?")) return json(fleet);
      if (url.startsWith("/api/machines/")) return json(detail);
      return json({});
    });

    render(<Workspace session={session} onLogout={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Карта" }));
    await screen.findByText("Харвестер 01");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const callsBeforeEmptyDate = fetchMock.mock.calls.length;
    fireEvent.change(screen.getByLabelText("Дата начала периода"), {
      target: { value: "" },
    });

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Укажите обе даты периода",
      ),
    );
    expect(
      screen.getByText(
        "Укажите корректный период, чтобы получить журнал и данные машин.",
      ),
    ).toBeVisible();
    expect(fetchMock.mock.calls).toHaveLength(callsBeforeEmptyDate);
  });

  it("warns when the source or method provenance is unknown", () => {
    render(
      <FleetView
        machines={[]}
        fleet={{
          ...fleet,
          totals: [
            {
              basis: "under_bark",
              volume_m3: "12.5",
              records: 1,
              provenance: {
                sources: ["unknown"],
                methods: ["manual_ledger"],
                method_versions: ["unknown"],
                calibration_refs: [],
              },
            },
          ],
        }}
      />,
    );

    expect(
      screen.getByText(/Источник, метод или версия методики/i),
    ).toBeVisible();
    expect(screen.getByText("Изменение счётчика")).toBeVisible();
  });

  it("keeps known provenance available beside a production total", async () => {
    render(
      <FleetView
        fleet={{
          period: { start: "2026-01-01", end: "2026-01-14" },
          totals: [
            {
              basis: "under_bark",
              volume_m3: "0.000000",
              records: 1,
              provenance: {
                sources: ["onboard_measurement"],
                methods: ["harvester_onboard"],
                method_versions: ["synthetic-v2-a"],
                calibration_refs: ["check-2026-01"],
              },
            },
          ],
          machines: [],
          record_count: 1,
        }}
        machines={[]}
      />,
    );

    await userEvent.setup().click(screen.getByText("Источник, метод и версия"));

    expect(screen.getByText("Бортовое измерение")).toBeVisible();
    expect(screen.getByText("Бортовая система")).toBeVisible();
    expect(screen.getByText("synthetic-v2-a")).toBeVisible();
    expect(screen.getByText("check-2026-01")).toBeVisible();
    expect(screen.getByText("0", { exact: true })).toBeVisible();
  });

  it("warns when known methods or method versions are mixed in one total", () => {
    const mixedMethodWarning =
      "В итоге смешаны методы или версии расчёта. Сумма арифметическая; сопоставимость методик не подтверждена.";
    render(
      <FleetView
        machines={[]}
        fleet={{
          ...fleet,
          totals: [
            {
              basis: "under_bark",
              volume_m3: "12.5",
              records: 2,
              provenance: {
                sources: ["onboard_measurement"],
                methods: ["harvester_onboard", "merchantable_log"],
                method_versions: ["hpr-4.2", "hpr-4.3"],
                calibration_refs: [],
              },
              warnings: [mixedMethodWarning, mixedMethodWarning],
            },
          ],
        }}
      />,
    );

    expect(screen.getByText(mixedMethodWarning)).toBeVisible();
    expect(screen.getAllByText(mixedMethodWarning)).toHaveLength(1);
    expect(
      screen.queryByText(
        /Источник, метод или версия методики указаны не полностью/i,
      ),
    ).not.toBeInTheDocument();
  });

  it("renders a mixed-source warning supplied by the API", () => {
    const mixedSourceWarning =
      "В итоге смешаны источники. Требуется сверка, чтобы исключить повторный учёт одной выработки.";
    render(
      <FleetView
        machines={[]}
        fleet={{
          ...fleet,
          totals: [
            {
              basis: "under_bark",
              volume_m3: "12.5",
              records: 2,
              provenance: {
                sources: ["onboard_measurement", "operator_export"],
                methods: ["harvester_onboard"],
                method_versions: ["hpr-4.2"],
                calibration_refs: [],
              },
              warnings: [mixedSourceWarning],
            },
          ],
        }}
      />,
    );

    expect(screen.getByText(mixedSourceWarning)).toBeVisible();
    expect(
      screen.queryByText(
        /Источник, метод или версия методики указаны не полностью/i,
      ),
    ).not.toBeInTheDocument();
  });

  it("keeps stale GPS in the attention filter despite fresh connection", async () => {
    const onSelect = vi.fn();
    render(
      <Overview
        fleet={fleet}
        onSelect={onSelect}
        onNavigate={vi.fn()}
        machines={[
          {
            ...machines.machines[0],
            connection_status: "fresh" as const,
            last_seen: "2026-01-14T08:30:00Z",
            position: {
              latitude: 61.1,
              longitude: 73.4,
              observed_at: "2026-01-13T08:30:00Z",
              status: "stale",
            },
          },
        ]}
      />,
    );

    await userEvent.selectOptions(
      screen.getByLabelText("Состояние данных"),
      "attention",
    );
    const attention = screen.getByRole("button", {
      name: /Харвестер 01.*Координаты устарели/i,
    });
    expect(attention).toHaveTextContent(
      "Координаты устарели или требуют проверки",
    );
    await userEvent.setup().click(attention);
    expect(onSelect).toHaveBeenCalledWith("harvester-01");
  });

  it("filters and sorts machines without confusing stored zeroes with missing data", async () => {
    const overviewMachines = [
      {
        ...machines.machines[0],
        connection_status: "fresh" as const,
        id: "alpha",
        name: "Альфа",
        model: "A-1",
        last_seen: "2026-01-14T08:30:00Z",
        metrics: [
          {
            key: "fuel_level_pct",
            label: "Уровень топлива",
            value: 0,
            unit: "%",
            observed_at: "2026-01-14T08:30:00Z",
            status: "fresh" as const,
            source: "onboard_measurement",
            explanation: "Тестовое значение.",
            norm: null,
          },
        ],
      },
      {
        ...machines.machines[0],
        connection_status: "fresh" as const,
        id: "beta",
        name: "Бета",
        model: null,
        last_seen: null,
        metrics: [
          {
            key: "fuel_level_pct",
            label: "Уровень топлива",
            value: null,
            unit: "%",
            observed_at: null,
            status: "missing" as const,
            source: "onboard_measurement",
            explanation: "Тестовое значение.",
            norm: null,
          },
        ],
      },
    ];
    render(
      <Overview
        machines={overviewMachines}
        fleet={{
          ...fleet,
          machines: [
            {
              id: "alpha",
              name: "Альфа",
              engine_hours: 0,
              totals: [{ basis: "under_bark", volume_m3: "0", records: 0 }],
            },
            { id: "beta", name: "Бета", engine_hours: null, totals: [] },
          ],
        }}
        onSelect={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    const table = screen.getByRole("region", { name: "Таблица машин" });

    expect(screen.getByRole("row", { name: /Альфа/ })).toHaveTextContent("0 %");
    expect(screen.getByRole("row", { name: /Альфа/ })).toHaveTextContent(
      "0 м³",
    );
    expect(screen.getByRole("row", { name: /Бета/ })).toHaveTextContent(
      "Нет данных",
    );
    expect(screen.getByRole("row", { name: /Бета/ })).toHaveTextContent(
      "Нет записей",
    );

    const rowsBeforeSort = Array.from(table.querySelectorAll("tbody tr"));
    expect(rowsBeforeSort.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Альфа"),
      expect.stringContaining("Бета"),
    ]);
    await user.click(
      screen.getByRole("button", { name: "Сортировать машины от Я до А" }),
    );
    expect(table.querySelectorAll("tbody tr")[0]).toHaveTextContent("Бета");

    await user.type(screen.getByLabelText("Поиск машин"), "альфа");
    expect(screen.getByRole("row", { name: /Альфа/ })).toBeVisible();
    expect(screen.queryByRole("row", { name: /Бета/ })).not.toBeInTheDocument();
    expect(screen.getByText("Показано 1 из 2")).toBeVisible();
  });

  it("combines state and text filters and resets an empty result without claiming an empty company", async () => {
    render(
      <Overview
        machines={[
          {
            ...machines.machines[0],
            id: "missing",
            name: "Без сообщений",
            last_seen: null,
            position: null,
            connection_status: "missing",
          },
          {
            ...machines.machines[0],
            id: "fresh",
            name: "Свежая",
            last_seen: "2026-01-14T08:30:00Z",
            connection_status: "fresh",
            position: {
              latitude: 61,
              longitude: 73,
              observed_at: "2026-01-14T08:30:00Z",
              status: "fresh",
            },
          },
        ]}
        fleet={fleet}
        onSelect={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    await user.selectOptions(
      screen.getByLabelText("Состояние данных"),
      "missing",
    );
    expect(screen.getByRole("row", { name: /Без сообщений/ })).toBeVisible();
    expect(
      screen.queryByRole("row", { name: /Свежая/ }),
    ).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Поиск машин"), " свежая ");
    expect(screen.getByText(/Нет машин по выбранным условиям/)).toBeVisible();
    expect(
      screen.queryByText(/В компании пока нет машин/),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Сбросить поиск и фильтр" }),
    );
    expect(screen.getByLabelText("Поиск машин")).toHaveValue("");
    expect(screen.getByLabelText("Состояние данных")).toHaveValue("all");
    expect(screen.getByText("Показано 2 из 2")).toBeVisible();
    await user.selectOptions(
      screen.getByLabelText("Состояние данных"),
      "attention",
    );
    expect(
      screen.getByRole("row", { name: /Без сообщений/ }),
    ).toHaveTextContent("События ещё не поступали");
    expect(
      screen.queryByRole("row", { name: /Свежая/ }),
    ).not.toBeInTheDocument();
  });

  it("keeps packet receipt, event, and coordinate times in separate columns when the API provides them", () => {
    render(
      <Overview
        fleet={{ ...fleet, machines: [] }}
        onSelect={vi.fn()}
        onNavigate={vi.fn()}
        machines={[
          {
            ...machines.machines[0],
            connection_status: "fresh" as const,
            last_seen: "2026-01-14T08:30:00Z",
            observed_at: "2026-01-14T08:30:00Z",
            received_at: "2026-01-14T09:00:00Z",
            position: {
              latitude: 61.1,
              longitude: 73.4,
              observed_at: "2026-01-14T08:15:00Z",
              status: "fresh" as const,
            },
          },
        ]}
      />,
    );

    expect(screen.getByText("Последний пакет")).toBeVisible();
    expect(screen.getByText("Время события")).toBeVisible();
    expect(screen.getByText("Координаты")).toBeVisible();
    expect(screen.getByRole("row", { name: /Харвестер 01/ })).toHaveTextContent(
      "UTC",
    );
  });

  it("sends an administrator from an empty fleet to company setup", async () => {
    const onOpenCompany = vi.fn();
    render(
      <Overview
        fleet={fleet}
        machines={[]}
        onSelect={vi.fn()}
        onNavigate={vi.fn()}
        onOpenCompany={onOpenCompany}
      />,
    );

    expect(
      screen.getByText(/В компании пока нет машин. Добавьте машину/i),
    ).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Добавить машину" }));
    expect(onOpenCompany).toHaveBeenCalledTimes(1);
  });

  it("shows the real outbox commands and a schema-valid production example", () => {
    render(
      <DataView
        dates={{ start: "2026-01-01", end: "2026-01-14" }}
        validDates
      />,
    );

    expect(
      screen.getByText(/python -m edge\.outbox enqueue normalized\.json/),
    ).toBeVisible();
    expect(screen.getByText(/export ITLES_DEVICE_TOKEN=/)).toBeVisible();
    expect(screen.getByText(/python -m edge\.outbox flush/)).toBeVisible();
    expect(screen.getByText(/--url https:\/\/ваш-домен/)).toBeVisible();
    expect(
      screen.getByText(/"method_version": "synthetic-example-v1"/),
    ).toBeVisible();
    expect(screen.queryByText(/--token/)).not.toBeInTheDocument();
  });

  it("keeps focus in a metric dialog and restores it after Escape", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/machines") return json(machines);
      if (url.startsWith("/api/fleet?")) return json(fleet);
      if (url.startsWith("/api/machines/")) {
        return json({
          ...detail,
          metrics: [
            {
              key: "fuel_level_pct",
              label: "Уровень топлива",
              value: 62.5,
              unit: "%",
              observed_at: "2026-01-14T08:30:00Z",
              status: "fresh",
              source: "onboard_measurement",
              explanation: "Значение поступает из нормализованного события.",
              norm: null,
            },
          ],
        });
      }
      return json({});
    });

    render(<Workspace session={session} onLogout={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Карта" }));
    const trigger = await screen.findByRole("button", {
      name: "Уровень топлива: открыть пояснение",
    });
    await userEvent.setup().click(trigger);

    expect(
      screen.getByRole("dialog", { name: "Уровень топлива" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Закрыть пояснение" }),
    ).toHaveFocus();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
  });

  it("makes the closed mobile navigation inert and returns focus on Escape", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/machines") return json(machines);
      if (url.startsWith("/api/fleet?")) return json(fleet);
      if (url.startsWith("/api/machines/")) return json(detail);
      return json({});
    });

    render(<Workspace session={session} onLogout={vi.fn()} />);
    const menu = screen.getByRole("button", { name: "Открыть меню" });
    const navigation = document.getElementById("main-navigation");
    expect(navigation).toHaveAttribute("inert");

    await userEvent.setup().click(menu);
    const closeNavigation = navigation?.querySelector(".close-nav");
    expect(closeNavigation).toHaveFocus();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(menu).toHaveAttribute("aria-expanded", "false"));
    expect(menu).toHaveFocus();
  });
});
