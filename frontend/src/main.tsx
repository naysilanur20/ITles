import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import {
  CircleMarker,
  GeoJSON,
  MapContainer,
  Polyline,
  Tooltip,
  useMap,
  ZoomControl,
} from "react-leaflet";
import L from "leaflet";
import type { GeoJsonObject } from "geojson";
import {
  AlertTriangle,
  BarChart3,
  BookOpen,
  Building2,
  CalendarDays,
  ChevronRight,
  CircleHelp,
  Database,
  Download,
  FileText,
  LogOut,
  Map as MapIcon,
  Menu,
  RefreshCw,
  Route,
  ShieldCheck,
  Trees,
  X,
  ArrowUpRight,
  ArrowUpDown,
  LayoutDashboard,
  LocateFixed,
  Search,
} from "lucide-react";
import "leaflet/dist/leaflet.css";
import "./styles.css";
import naturalEarthRussiaRegionText from "./assets/natural-earth-russia-region.geojson?raw";
import { ApiError, request } from "./api";
import { AuthPortal } from "./AuthPortal";
import { CompanyPanel } from "./CompanyPanel";
import type { Session } from "./account-types";

type Status = "fresh" | "stale" | "missing" | "invalid";
type Metric = {
  key: string;
  label: string;
  value: number | null;
  unit: string;
  observed_at: string | null;
  status: Status;
  source: string;
  explanation: string;
  norm: string | null;
};
type Position = {
  latitude: number;
  longitude: number;
  observed_at: string;
  status: Status;
};
type Machine = {
  id: string;
  name: string;
  model: string | null;
  head: string | null;
  computer: string | null;
  connection_status: Status;
  metrics: Metric[];
  position: Position | null;
  last_seen: string | null;
  received_at?: string | null;
  last_received_at?: string | null;
  observed_at?: string | null;
  last_observed_at?: string | null;
};
type Provenance = {
  sources: string[];
  methods: string[];
  method_versions: string[];
  calibration_refs: string[];
};
type Total = {
  basis: "under_bark" | "over_bark" | "unknown";
  volume_m3: string;
  records: number;
  provenance?: Provenance;
  warnings?: string[];
};
type Fleet = {
  period: { start: string; end: string };
  totals: Total[];
  machines: {
    id: string;
    name: string;
    totals: Total[];
    engine_hours: number | null;
  }[];
  record_count: number;
};
type MachineDetail = Machine & {
  production: {
    event_id: string;
    occurred_at: string;
    volume_m3: string;
    basis: string;
    source: string;
    method: string;
    method_version: string;
    calibration_ref: string | null;
  }[];
  totals: Total[];
  track: { latitude: number; longitude: number; observed_at: string }[];
  engine_hours: number | null;
};
type Quality = {
  counts: { accepted: number; duplicates: number; rejected: number };
  recent: {
    received_at: string;
    status: string;
    reason: string | null;
    machine_id: string | null;
  }[];
  limitations: string[];
};
type DocumentItem = {
  name: string;
  title: string;
  url: string;
  format: string;
};
type DateRange = { start: string; end: string };

const today = new Date().toISOString().slice(0, 10);
const naturalEarthRussiaRegion = JSON.parse(
  naturalEarthRussiaRegionText,
) as GeoJsonObject;
const nav = [
  ["overview", "Парк", LayoutDashboard],
  ["map", "Карта", MapIcon],
  ["fleet", "Выработка", BarChart3],
  ["quality", "Приём данных", ShieldCheck],
  ["data", "Инструкция", Database],
  ["docs", "Документы", BookOpen],
  ["company", "Компания", Building2],
] as const;
type ViewId = (typeof nav)[number][0];

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function hasValidDateRange({ start, end }: { start: string; end: string }) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(start) &&
    /^\d{4}-\d{2}-\d{2}$/.test(end) &&
    start <= end
  );
}

function initialDates(session: Session): DateRange {
  if (
    session.demo &&
    session.data_period &&
    hasValidDateRange(session.data_period)
  ) {
    return session.data_period;
  }
  return { start: today, end: today };
}

function useMediaQuery(query: string) {
  const getMatches = () =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(query).matches;
  const [matches, setMatches] = useState(getMatches);

  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);

  return matches;
}

function displayDate(value: string | null) {
  if (!value) return "нет данных";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("ru-RU", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(date) + " UTC";
}
function basisName(basis: string) {
  return basis === "under_bark"
    ? "без коры"
    : basis === "over_bark"
      ? "с корой"
      : "база не указана";
}
function statusLabel(status: Status) {
  return (
    {
      fresh: "данные актуальны",
      stale: "наблюдение устарело",
      missing: "нет данных",
      invalid: "данные требуют проверки",
    } as Record<Status, string>
  )[status];
}

function receivedAt(machine: Machine) {
  return machine.received_at ?? machine.last_received_at ?? null;
}

function observedAt(machine: Machine) {
  return machine.observed_at ?? machine.last_observed_at ?? machine.last_seen;
}

function coordinates(position: Position) {
  return `${position.latitude.toFixed(5)}, ${position.longitude.toFixed(5)}`;
}
function metricValue(metric: Metric) {
  return metric.value === null
    ? "—"
    : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(
        metric.value,
      );
}
function volume(value: string) {
  const [integer, fraction = ""] = value.split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
  const significantFraction = fraction.slice(0, 6).replace(/0+$/, "");
  return significantFraction ? `${grouped},${significantFraction}` : grouped;
}

function recordCount(count: number) {
  const form = new Intl.PluralRules("ru").select(count);
  return `${count} ${form === "one" ? "запись" : form === "few" ? "записи" : "записей"}`;
}

function StatusPill({ status }: { status: Status }) {
  return (
    <span className={`status status--${status}`}>
      <i aria-hidden="true" />
      {statusLabel(status)}
    </span>
  );
}
function Explanation({
  label,
  text,
  norm,
}: {
  label: string;
  text: string;
  norm: string | null;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const dialogId = useId();
  const headingId = useId();
  const descriptionId = useId();
  useEffect(() => {
    if (!open) return;
    const opener = trigger.current;
    const focusable = () =>
      Array.from(
        dialog.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
      if (event.key === "Tab") {
        const controls = focusable();
        if (!controls.length) return;
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", close);
    dialog.current?.querySelector<HTMLElement>("button")?.focus();
    return () => {
      window.removeEventListener("keydown", close);
      opener?.focus();
    };
  }, [open]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="explanation"
        aria-label={`${label}: открыть пояснение`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={dialogId}
        onClick={() => setOpen(true)}
      >
        <CircleHelp size={15} />
      </button>
      {open &&
        createPortal(
          <div
            className="modal-scrim"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setOpen(false);
            }}
          >
            <div
              id={dialogId}
              className="metric-modal"
              ref={dialog}
              role="dialog"
              aria-modal="true"
              aria-labelledby={headingId}
              aria-describedby={descriptionId}
            >
              <div>
                <p className="eyebrow">ПОЯСНЕНИЕ ПОКАЗАТЕЛЯ</p>
                <h2 id={headingId}>{label}</h2>
              </div>
              <button
                type="button"
                className="modal-close"
                aria-label="Закрыть пояснение"
                onClick={() => setOpen(false)}
              >
                <X size={18} />
              </button>
              <p id={descriptionId}>{text}</p>
              <p className="modal-norm">
                {norm
                  ? `Норма: ${norm}`
                  : "Норма не подтверждена для этой машины и узла."}
              </p>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="empty">
      <Database size={22} aria-hidden="true" />
      <div>{children}</div>
    </div>
  );
}

function WorkspaceDataState({ validDates }: { validDates: boolean }) {
  return (
    <div className="content-page">
      <Empty>
        <p>
          {validDates
            ? "Данные парка не получены. Нажмите «Обновить» после восстановления связи."
            : "Укажите корректный период, чтобы получить журнал и данные машин."}
        </p>
      </Empty>
    </div>
  );
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checked, setChecked] = useState(false);
  const [initialError, setInitialError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const report = (error: unknown) => {
      if (
        !controller.signal.aborted &&
        !(error instanceof ApiError && error.status === 401)
      ) {
        setInitialError(
          error instanceof Error
            ? error.message
            : "Не удалось проверить доступность сервера.",
        );
      }
    };
    void request<Session>("/api/auth/me", options)
      .then((value) => {
        if (!controller.signal.aborted) setSession(value);
      })
      .catch(report)
      .finally(() => {
        if (!controller.signal.aborted) setChecked(true);
      });
    return () => controller.abort();
  }, []);
  if (!checked)
    return (
      <div className="splash" role="status">
        <Trees size={26} aria-hidden="true" />
        Загрузка ИТлес
      </div>
    );
  return session ? (
    <Workspace session={session} onLogout={() => setSession(null)} />
  ) : (
    <AuthPortal
      onSuccess={setSession}
      initialMessage={initialError || undefined}
    />
  );
}

export function Workspace({
  session,
  onLogout,
}: {
  session: Session;
  onLogout: () => void;
}) {
  const needsCompanySetup =
    !session.demo &&
    session.user?.role === "admin" &&
    session.onboarding?.completed === false;
  const [view, setView] = useState<ViewId>(() =>
    needsCompanySetup ? "company" : "overview",
  );
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [dates, setDates] = useState(() => initialDates(session));
  const [machines, setMachines] = useState<Machine[]>([]);
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const [detail, setDetail] = useState<MachineDetail | null>(null);
  const [quality, setQuality] = useState<Quality | null>(null);
  const [qualityLoading, setQualityLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [loggingOut, setLoggingOut] = useState(false);
  const [loadedPeriod, setLoadedPeriod] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(selected);
  const loadRequest = useRef(0);
  const detailRequest = useRef(0);
  const loadAbort = useRef<AbortController | null>(null);
  const detailAbort = useRef<AbortController | null>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const content = useRef<HTMLElement>(null);
  const isMobileNavigation = useMediaQuery("(max-width: 850px)");
  const validDates = hasValidDateRange(dates);
  const hasPeriod = ["overview", "map", "fleet", "data"].includes(view);
  const canManageCompany = !session.demo && session.user?.role === "admin";
  const navigation = nav.filter(([id]) => id !== "company" || !session.demo);
  const viewLabel =
    view === "company" && session.user?.role === "user"
      ? "Мой доступ"
      : (nav.find(([id]) => id === view)?.[1] ?? "Парк");
  const query = `start=${encodeURIComponent(dates.start)}&end=${encodeURIComponent(dates.end)}`;

  useEffect(() => {
    content.current?.scrollIntoView({ block: "start" });
    content.current?.querySelector("h1")?.focus({ preventScroll: true });
  }, [view]);
  const period = `${dates.start}:${dates.end}`;

  useEffect(
    () => () => {
      loadAbort.current?.abort();
      detailAbort.current?.abort();
      ++loadRequest.current;
      ++detailRequest.current;
    },
    [],
  );

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  const load = useCallback(
    async (manual = false) => {
      if (manual) setRefreshVersion((value) => value + 1);
      const requestId = ++loadRequest.current;
      loadAbort.current?.abort();
      detailAbort.current?.abort();
      ++detailRequest.current;
      setDetail(null);
      setFleet(null);
      setMachines([]);
      setLoadedPeriod(null);

      if (!hasValidDateRange(dates)) {
        setError("");
        setLoading(false);
        setRefreshing(false);
        return;
      }

      const controller = new AbortController();
      loadAbort.current = controller;
      setError("");
      manual ? setRefreshing(true) : setLoading(true);
      try {
        const [machinePayload, fleetPayload] = await Promise.all([
          request<{ machines: Machine[] }>("/api/machines", {
            signal: controller.signal,
          }),
          request<Fleet>(`/api/fleet?${query}`, { signal: controller.signal }),
        ]);
        if (requestId !== loadRequest.current) return;
        setMachines(machinePayload.machines);
        setFleet(fleetPayload);
        const id =
          selectedRef.current &&
          machinePayload.machines.some((m) => m.id === selectedRef.current)
            ? selectedRef.current
            : (machinePayload.machines[0]?.id ?? null);
        setSelected(id);
        setLoadedPeriod(period);
      } catch (err) {
        if (requestId !== loadRequest.current || isAbortError(err)) return;
        if (err instanceof ApiError && err.status === 401) {
          onLogout();
          return;
        }
        setError(
          err instanceof Error ? err.message : "Не удалось получить данные",
        );
      } finally {
        if (requestId !== loadRequest.current) return;
        setLoading(false);
        setRefreshing(false);
      }
    },
    [dates, period, query, onLogout],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!selected || !validDates || loadedPeriod !== period) {
      detailAbort.current?.abort();
      ++detailRequest.current;
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    detailAbort.current?.abort();
    detailAbort.current = controller;
    const requestId = ++detailRequest.current;
    setDetail(null);
    request<MachineDetail>(
      `/api/machines/${encodeURIComponent(selected)}?${query}`,
      { signal: controller.signal },
    )
      .then((payload) => {
        if (requestId === detailRequest.current) setDetail(payload);
      })
      .catch((err) => {
        if (requestId !== detailRequest.current || isAbortError(err)) return;
        if (err instanceof ApiError && err.status === 401) {
          onLogout();
          return;
        }
        setError(
          err instanceof Error ? err.message : "Не удалось открыть машину",
        );
      });
    return () => controller.abort();
  }, [loadedPeriod, period, query, selected, validDates, onLogout]);

  useEffect(() => {
    if (view !== "quality") return;
    const controller = new AbortController();
    setQuality(null);
    setQualityLoading(true);
    request<Quality>("/api/quality", { signal: controller.signal })
      .then((payload) => {
        if (!controller.signal.aborted) setQuality(payload);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && err.status === 401) {
          onLogout();
          return;
        }
        setError(
          err instanceof Error ? err.message : "Не удалось загрузить журнал",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setQualityLoading(false);
      });
    return () => controller.abort();
  }, [view, refreshVersion, onLogout]);

  useEffect(() => {
    const navigation = sidebar.current;
    if (!navigation) return;
    if (isMobileNavigation && !open) {
      navigation.setAttribute("inert", "");
      return;
    }
    navigation.removeAttribute("inert");
  }, [isMobileNavigation, open]);

  useEffect(() => {
    if (!open) return;
    const opener = menuButton.current;
    const focusable = () =>
      Array.from(
        sidebar.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
      if (event.key !== "Tab") return;
      const controls = focusable();
      if (!controls.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeydown);
    sidebar.current?.querySelector<HTMLElement>("button")?.focus();
    return () => {
      window.removeEventListener("keydown", handleKeydown);
      opener?.focus();
    };
  }, [open]);

  function changeDates(part: "start" | "end", value: string) {
    // Invalidate immediately: useEffect starts the next request after this render.
    loadAbort.current?.abort();
    ++loadRequest.current;
    detailAbort.current?.abort();
    ++detailRequest.current;
    setDetail(null);
    setFleet(null);
    setLoadedPeriod(null);
    setError("");
    setDates((current) => ({ ...current, [part]: value }));
  }

  function select(id: string) {
    if (id === selected) {
      setOpen(false);
      setView("map");
      return;
    }
    detailAbort.current?.abort();
    ++detailRequest.current;
    setDetail(null);
    setError("");
    setSelected(id);
    setOpen(false);
    setView("map");
  }
  async function logout() {
    setLoggingOut(true);
    try {
      await request("/api/auth/logout", { method: "POST" });
      onLogout();
    } catch {
      setError(
        "Сервер не подтвердил выход. Сеанс мог остаться активным; повторите попытку после восстановления связи.",
      );
    } finally {
      setLoggingOut(false);
    }
  }
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        К содержимому
      </a>
      <aside
        ref={sidebar}
        id="main-navigation"
        className={`sidebar ${open ? "sidebar--open" : ""}`}
        aria-label="Основная навигация"
        aria-hidden={isMobileNavigation && !open ? true : undefined}
      >
        <div className="sidebar-head">
          <div className="wordmark">
            <Trees size={21} />
            ИТлес
          </div>
          <button
            className="icon-button close-nav"
            aria-label="Закрыть меню"
            type="button"
            onClick={() => setOpen(false)}
          >
            <X />
          </button>
        </div>
        <div className="org-name">{session.organization.name}</div>
        <nav>
          {navigation.map(([id, label, Icon]) => {
            const itemLabel =
              id === "company" && session.user?.role === "user"
                ? "Мой доступ"
                : label;
            return (
              <button
                key={id}
                type="button"
                className={
                  view === id ? "nav-item nav-item--active" : "nav-item"
                }
                aria-current={view === id ? "page" : undefined}
                onClick={() => {
                  setView(id);
                  setOpen(false);
                }}
              >
                <Icon size={18} aria-hidden="true" />
                {itemLabel}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          {!session.demo && session.user && (
            <p className="account-summary">
              {session.user.login}
              <span>
                {session.user.role === "admin"
                  ? "Администратор"
                  : "Пользователь"}
              </span>
            </p>
          )}
          <button
            className="logout"
            type="button"
            onClick={logout}
            disabled={loggingOut}
          >
            <LogOut size={16} />
            Выйти
          </button>
        </div>
      </aside>
      {open && (
        <button
          className="backdrop"
          aria-label="Закрыть меню"
          type="button"
          onClick={() => setOpen(false)}
        />
      )}
      <main className="workspace" id="main-content" tabIndex={-1} ref={content}>
        <header className="topbar">
          <button
            className="icon-button menu-button"
            aria-label="Открыть меню"
            aria-expanded={open}
            aria-controls="main-navigation"
            ref={menuButton}
            type="button"
            onClick={() => setOpen(true)}
          >
            <Menu />
          </button>
          <div>
            <p className="eyebrow">
              {session.demo ? "Учебные данные" : session.organization.name}
            </p>
            <h1 tabIndex={-1}>{viewLabel}</h1>
          </div>
          {hasPeriod && (
            <div className="date-controls" aria-label="Период журнала, UTC">
              <CalendarDays size={17} />
              <label>
                с
                <input
                  type="date"
                  aria-label="Дата начала периода"
                  value={dates.start}
                  max={dates.end}
                  onChange={(e) => changeDates("start", e.target.value)}
                />
              </label>
              <label>
                по
                <input
                  type="date"
                  aria-label="Дата окончания периода"
                  value={dates.end}
                  min={dates.start}
                  onChange={(e) => changeDates("end", e.target.value)}
                />
              </label>
              <span className="date-timezone">UTC</span>
            </div>
          )}
          <button
            className="refresh"
            type="button"
            onClick={() => void load(true)}
            disabled={
              refreshing ||
              (hasPeriod && !validDates) ||
              view === "docs" ||
              view === "company"
            }
          >
            <RefreshCw size={17} className={refreshing ? "spin" : ""} />
            Обновить
          </button>
        </header>
        {session.demo && (
          <div className="demo-banner">
            <span className="demo-label">Учебный парк</span>
            <p>
              Вымышленные машины и записи. Даты сохранены; реальная техника не
              подключена.
            </p>
            <button type="button" onClick={() => setView("data")}>
              Открыть инструкцию <ArrowUpRight size={15} />
            </button>
          </div>
        )}
        {!validDates && hasPeriod && (
          <div className="message message--error" role="alert">
            Укажите обе даты периода; дата окончания не может быть раньше даты
            начала.
          </div>
        )}
        {error && (
          <div className="message message--error" role="alert">
            <AlertTriangle size={17} />
            {error}
            <button
              type="button"
              onClick={() => setError("")}
              aria-label="Закрыть сообщение"
            >
              <X size={16} />
            </button>
          </div>
        )}
        {view === "company" ? (
          <div className="company-page">
            <CompanyPanel
              session={session}
              onSessionEnded={onLogout}
              onChanged={() => void load(true)}
              onOpenMachine={(id) => {
                selectedRef.current = id;
                setSelected(id);
                setOpen(false);
                setView("map");
                void load(true);
              }}
            />
          </div>
        ) : loading || refreshing ? (
          <div className="loading" role="status">
            Получаем журнал и состояние машин…
          </div>
        ) : (
          <View
            view={view}
            machines={machines}
            fleet={fleet}
            detail={detail}
            quality={quality}
            qualityLoading={qualityLoading}
            selected={selected}
            onSelect={select}
            dates={dates}
            validDates={validDates}
            onNavigate={setView}
            onSessionEnded={onLogout}
            onOpenCompany={
              canManageCompany ? () => setView("company") : undefined
            }
          />
        )}
      </main>
    </div>
  );
}

function View({
  view,
  onOpenCompany,
  ...props
}: {
  view: ViewId;
  machines: Machine[];
  fleet: Fleet | null;
  detail: MachineDetail | null;
  quality: Quality | null;
  qualityLoading: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
  dates: { start: string; end: string };
  validDates: boolean;
  onNavigate: (view: (typeof nav)[number][0]) => void;
  onSessionEnded: () => void;
  onOpenCompany?: () => void;
}) {
  if (!props.validDates && ["overview", "map", "fleet"].includes(view))
    return <WorkspaceDataState validDates={false} />;
  if (!props.fleet && ["overview", "map"].includes(view))
    return <WorkspaceDataState validDates />;
  if (view === "overview")
    return <Overview {...props} onOpenCompany={onOpenCompany} />;
  if (view === "fleet") return <FleetView {...props} />;
  if (view === "quality")
    return (
      <QualityView quality={props.quality} loading={props.qualityLoading} />
    );
  if (view === "data")
    return (
      <DataView
        dates={props.dates}
        validDates={props.validDates}
        onOpenCompany={onOpenCompany}
      />
    );
  if (view === "docs")
    return <Documents onSessionEnded={props.onSessionEnded} />;
  if (view === "company") return null;
  return <MapView {...props} />;
}

export function Overview({
  machines,
  fleet,
  onSelect,
  validDates = true,
  onNavigate,
  onOpenCompany,
}: {
  machines: Machine[];
  fleet: Fleet | null;
  onSelect: (id: string) => void;
  validDates?: boolean;
  onNavigate: (view: (typeof nav)[number][0]) => void;
  onOpenCompany?: () => void;
}) {
  const [search, setSearch] = useState("");
  const [ascending, setAscending] = useState(true);
  const [dataFilter, setDataFilter] = useState("all");
  const needsAttention = (machine: Machine) =>
    machine.connection_status !== "fresh" ||
    machine.position?.status !== "fresh";
  const filtered = machines
    .filter((machine) =>
      `${machine.name} ${machine.model ?? ""}`
        .toLocaleLowerCase("ru")
        .includes(search.trim().toLocaleLowerCase("ru")),
    )
    .filter((machine) =>
      dataFilter === "attention"
        ? needsAttention(machine)
        : dataFilter === "missing"
          ? !observedAt(machine)
          : true,
    )
    .sort((a, b) => a.name.localeCompare(b.name, "ru") * (ascending ? 1 : -1));
  const attention = machines.filter(needsAttention);
  const hasFuel = machines.some((machine) =>
    machine.metrics.some(
      (metric) => metric.key === "fuel_level_pct" && metric.value !== null,
    ),
  );
  const hasReceivedTimes = machines.some(
    (machine) => receivedAt(machine) !== null,
  );

  function attentionMessage(machine: Machine) {
    if (!observedAt(machine)) return "События ещё не поступали";
    if (machine.connection_status === "invalid")
      return "Последние данные требуют проверки";
    if (machine.connection_status !== "fresh")
      return "Последнее событие устарело";
    if (!machine.position) return "Координаты не поступали";
    return "Координаты устарели или требуют проверки";
  }

  return (
    <div className="content-page overview-page">
      <section
        className="table-card fleet-register"
        aria-labelledby="fleet-title"
      >
        <div className="section-title fleet-register__head">
          <div>
            <h2 id="fleet-title">Машины</h2>
            <p className="section-description">
              Последние сообщения и координаты — за всё время. Объём — за
              выбранный период.
            </p>
          </div>
          <div className="fleet-tools">
            <label className="search-field">
              <Search size={17} aria-hidden="true" />
              <input
                type="search"
                aria-label="Поиск машин"
                placeholder="Название или модель"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <label className="data-filter">
              <span>Состояние данных</span>
              <select
                value={dataFilter}
                onChange={(event) => setDataFilter(event.target.value)}
              >
                <option value="all">Все машины</option>
                <option value="attention">
                  Требуют внимания ({attention.length})
                </option>
                <option value="missing">События не поступали</option>
              </select>
            </label>
          </div>
        </div>
        <details className="registry-help">
          <summary>Как читать время и состояния</summary>
          <p>
            Последний пакет — время приёма сервером; событие и координаты —
            время наблюдения источником. Все даты в UTC. Свежесть данных не
            подтверждает исправность машины. Порог устаревания — 2 часа, это не
            норма датчика.
          </p>
        </details>
        {!fleet ? (
          <Empty>
            <p>
              {validDates
                ? "Список машин и выработка не получены. Нажмите «Обновить» после восстановления связи."
                : "Укажите корректный период, чтобы получить данные парка."}
            </p>
          </Empty>
        ) : filtered.length ? (
          <>
            <p className="table-scroll-hint">
              Таблицу можно прокрутить вправо, чтобы увидеть все показатели.
            </p>
            <div
              className="table-scroll"
              tabIndex={0}
              role="region"
              aria-label="Таблица машин"
            >
              <table>
                <caption className="sr-only">
                  Машины, время последних событий, координат и объём из журнала
                </caption>
                <thead>
                  <tr>
                    <th
                      scope="col"
                      aria-sort={ascending ? "ascending" : "descending"}
                    >
                      <button
                        type="button"
                        onClick={() => setAscending(!ascending)}
                        aria-label={
                          ascending
                            ? "Сортировать машины от Я до А"
                            : "Сортировать машины от А до Я"
                        }
                      >
                        Машина <ArrowUpDown size={14} aria-hidden="true" />
                      </button>
                    </th>
                    <th scope="col">
                      {hasReceivedTimes
                        ? "Последний пакет"
                        : "Последнее событие"}
                    </th>
                    {hasReceivedTimes && <th scope="col">Время события</th>}
                    <th scope="col">Координаты</th>
                    {hasFuel && <th scope="col">Топливо</th>}
                    <th scope="col">Объём за период</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((machine) => {
                    const fuel = machine.metrics.find(
                      (metric) => metric.key === "fuel_level_pct",
                    );
                    const totals = fleet?.machines.find(
                      (entry) => entry.id === machine.id,
                    )?.totals;
                    const packetTime = receivedAt(machine);
                    const eventTime = observedAt(machine);
                    return (
                      <tr key={machine.id}>
                        <th scope="row">
                          <button
                            type="button"
                            className="machine-link"
                            onClick={() => onSelect(machine.id)}
                          >
                            <span>
                              <b>{machine.name}</b>
                              <small>
                                {machine.model || "Модель не указана"}
                              </small>
                              {dataFilter === "attention" && (
                                <small className="attention-reason">
                                  {attentionMessage(machine)}
                                </small>
                              )}
                            </span>
                            <ArrowUpRight size={16} />
                          </button>
                        </th>
                        <td>
                          <span>
                            {displayDate(
                              hasReceivedTimes ? packetTime : eventTime,
                            )}
                          </span>
                          {!hasReceivedTimes && eventTime && (
                            <StatusPill status={machine.connection_status} />
                          )}
                        </td>
                        {hasReceivedTimes && (
                          <td>
                            <span>{displayDate(eventTime)}</span>
                            {eventTime && (
                              <StatusPill status={machine.connection_status} />
                            )}
                          </td>
                        )}
                        <td>
                          {machine.position ? (
                            <>
                              <span>
                                {displayDate(machine.position.observed_at)}
                              </span>
                              <StatusPill status={machine.position.status} />
                            </>
                          ) : (
                            <span className="muted">
                              Координаты не поступали
                            </span>
                          )}
                        </td>
                        {hasFuel && (
                          <td>
                            {fuel?.value != null ? (
                              <>
                                <b>
                                  {metricValue(fuel)} {fuel.unit}
                                </b>
                                <StatusPill status={fuel.status} />
                              </>
                            ) : (
                              <span className="muted">Нет данных</span>
                            )}
                          </td>
                        )}
                        <td>
                          {totals?.length ? (
                            totals.map((total) => (
                              <span className="table-volume" key={total.basis}>
                                <b>{volume(total.volume_m3)} м³</b>{" "}
                                {basisName(total.basis)}
                              </span>
                            ))
                          ) : (
                            <span className="muted">
                              {fleet ? "Нет записей" : "Не получен"}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <Empty>
            {search || dataFilter !== "all" ? (
              <>
                <p>
                  Нет машин по выбранным условиям. Измените поиск или состояние
                  данных.
                </p>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setSearch("");
                    setDataFilter("all");
                  }}
                >
                  Сбросить поиск и фильтр
                </button>
              </>
            ) : onOpenCompany ? (
              <>
                <p>
                  В компании пока нет машин. Добавьте машину, затем укажите
                  доступный источник и дождитесь первого сообщения.
                </p>
                <button
                  type="button"
                  className="button button--primary"
                  onClick={onOpenCompany}
                >
                  <Building2 size={17} aria-hidden="true" />
                  Добавить машину
                </button>
              </>
            ) : (
              <p>
                В компании пока нет машин. Обратитесь к администратору, чтобы он
                добавил машину и настроил источник данных.
              </p>
            )}
          </Empty>
        )}
        {fleet && (
          <div className="table-footer">
            <span role="status">
              Показано {filtered.length} из {machines.length}
            </span>
            <button
              className="text-button"
              type="button"
              onClick={() => onNavigate("quality")}
            >
              Журнал приёма
            </button>
            <button
              className="text-button"
              type="button"
              onClick={() => onNavigate("map")}
              disabled={!machines.length}
            >
              Открыть карту <ArrowUpRight size={17} aria-hidden="true" />
            </button>
          </div>
        )}
      </section>
      <div className="overview-support">
        <section
          className="production-summary"
          aria-labelledby="production-summary-title"
        >
          <div className="section-heading">
            <div>
              <h2 id="production-summary-title">Выработка за период</h2>
              <p>Суммы собраны из событий журнала.</p>
            </div>
          </div>
          {fleet?.totals.length ? (
            <div className="production-values">
              {fleet.totals.map((total) => (
                <div className="production-value" key={total.basis}>
                  <span>{basisName(total.basis)}</span>
                  <p>
                    <b>{volume(total.volume_m3)}</b> <span>м³</span>
                  </p>
                  <small>{recordCount(total.records)}</small>
                  <ProvenanceNotice total={total} />
                </div>
              ))}
            </div>
          ) : (
            <Empty>
              <p>
                {fleet
                  ? "За выбранный период нет записей выработки. Это не означает нулевую выработку."
                  : "Сводка не получена. Обновите данные после восстановления связи."}
              </p>
            </Empty>
          )}
          <div className="summary-footer">
            <p>
              Базы объёма не складываются. Сумма не подтверждает точность
              измерений.
            </p>
            <button
              type="button"
              className="text-button"
              onClick={() => onNavigate("fleet")}
            >
              Проверить выработку <ArrowUpRight size={17} aria-hidden="true" />
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

function FitMachineBounds({
  machines,
  reset,
  selected,
}: {
  machines: Machine[];
  reset: number;
  selected: string | null;
}) {
  const map = useMap();
  const positions = machines
    .filter((machine) => machine.position)
    .map(
      (machine) =>
        [
          machine.position!.latitude,
          machine.position!.longitude,
        ] as L.LatLngTuple,
    );
  const coordinates = JSON.stringify(positions);
  useEffect(() => {
    const points = JSON.parse(coordinates) as L.LatLngTuple[];
    if (points.length)
      map.fitBounds(L.latLngBounds(points), {
        padding: [60, 60],
        // The offline country outlines need a regional starting view.
        maxZoom: 6,
        animate: false,
      });
  }, [map, coordinates, reset]);
  const selectedPosition = machines.find(
    (machine) => machine.id === selected,
  )?.position;
  const latitude = selectedPosition?.latitude;
  const longitude = selectedPosition?.longitude;
  useEffect(() => {
    if (latitude !== undefined && longitude !== undefined)
      map.panTo([latitude, longitude], { animate: false });
  }, [map, selected, latitude, longitude]);
  return null;
}

function MapView({
  machines,
  detail,
  selected,
  onSelect,
}: Omit<Parameters<typeof View>[0], "view" | "fleet" | "quality" | "dates">) {
  const [reset, setReset] = useState(0);
  const positioned = machines.filter((m) => m.position);
  const center: L.LatLngTuple = positioned.length
    ? [
        positioned.reduce((sum, m) => sum + m.position!.latitude, 0) /
          positioned.length,
        positioned.reduce((sum, m) => sum + m.position!.longitude, 0) /
          positioned.length,
      ]
    : [61.5, 90];
  return (
    <div className="map-layout">
      <section
        className="map-stage"
        aria-label="Карта последних известных координат"
      >
        <MapContainer
          center={center}
          zoom={5}
          scrollWheelZoom
          className="offline-map"
          zoomControl={false}
          attributionControl={false}
        >
          <FitMachineBounds
            machines={machines}
            reset={reset}
            selected={selected}
          />
          <ZoomControl position="topright" />
          <GeoJSON
            data={naturalEarthRussiaRegion}
            style={{
              color: "var(--map-border)",
              weight: 1,
              fillColor: "var(--map-land)",
              fillOpacity: 0.72,
            }}
          />
          <div className="map-label map-label--north">Карта</div>
          <div className="map-grid-note">
            Показаны сохранённые координаты. Дороги и лесные кварталы не
            загружаются.
          </div>
          {detail?.track && detail.track.length > 1 && (
            <Polyline
              positions={detail.track.map((p) => [p.latitude, p.longitude])}
              pathOptions={{
                color: "var(--map-border)",
                weight: 2,
                dashArray: "5 7",
              }}
            />
          )}
          {positioned.map((machine) => (
            <CircleMarker
              key={machine.id}
              center={[machine.position!.latitude, machine.position!.longitude]}
              radius={machine.id === selected ? 10 : 7}
              pathOptions={{
                color: "var(--ink)",
                fillColor:
                  machine.id === selected ? "var(--accent)" : "var(--surface)",
                fillOpacity: 1,
                weight: 3,
              }}
              eventHandlers={{ click: () => onSelect(machine.id) }}
            >
              {/* Leaflet reads permanent only when creating the tooltip. */}
              <Tooltip
                key={String(machine.id === selected)}
                direction="top"
                opacity={1}
                permanent={machine.id === selected}
              >
                {machine.name}
                <br />
                <small>
                  {statusLabel(machine.position!.status)} ·{" "}
                  {displayDate(machine.position!.observed_at)}
                </small>
              </Tooltip>
            </CircleMarker>
          ))}
        </MapContainer>
        <button
          className="map-reset"
          type="button"
          onClick={() => setReset((value) => value + 1)}
        >
          <LocateFixed size={16} />
          Весь парк
        </button>
        {!positioned.length && (
          <div className="map-empty">
            Координаты ещё не поступали. Положение машин на карте не показано.
          </div>
        )}
        <div className="map-legend">
          <span>
            <i className="legend-dot" />
            последняя известная координата
          </span>
          <span>
            <Route size={14} />
            линия: координаты выбранного периода
          </span>
        </div>
        <div className="map-attribution">
          Границы: Natural Earth, Admin 0 Countries 1:110m · public domain
        </div>
      </section>
      <aside className="machine-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Парк</p>
            <h2>Машины</h2>
          </div>
          <span>{machines.length} шт.</span>
        </div>
        <p className="current-data-note">
          Последние события, показатели и координаты могут быть вне выбранного
          периода журнала.
        </p>
        <div className="machine-list">
          {machines.length === 0 ? (
            <Empty>Нет машин, доступных этой организации.</Empty>
          ) : (
            machines.map((machine) => (
              <button
                key={machine.id}
                type="button"
                className={`machine-row ${machine.id === selected ? "machine-row--selected" : ""}`}
                aria-pressed={machine.id === selected}
                onClick={() => onSelect(machine.id)}
              >
                <span
                  className={`signal signal--${machine.connection_status}`}
                />
                <span>
                  <b>{machine.name}</b>
                  <small>{machine.model || "модель не указана"}</small>
                </span>
                <ChevronRight size={17} />
              </button>
            ))
          )}
        </div>
        {detail ? (
          <MachineDetails detail={detail} />
        ) : (
          <Empty>Выберите машину, чтобы открыть карточку.</Empty>
        )}
      </aside>
    </div>
  );
}
function MachineDetails({ detail }: { detail: MachineDetail }) {
  const primaryKeys = [
    "fuel_level_pct",
    "engine_rpm",
    "engine_oil_pressure_kpa",
    "hydraulic_oil_temperature_c",
  ];
  const primary = detail.metrics.filter((metric) =>
    primaryKeys.includes(metric.key),
  );
  const other = detail.metrics.filter(
    (metric) => !primaryKeys.includes(metric.key),
  );
  const packetTime = receivedAt(detail);
  const eventTime = observedAt(detail);
  return (
    <section className="detail">
      <div className="detail-title">
        <div>
          <p className="eyebrow">Карточка машины</p>
          <h2>{detail.name}</h2>
        </div>
        <StatusPill status={detail.connection_status} />
      </div>
      <p className="machine-spec">
        {[detail.model, detail.head, detail.computer]
          .filter(Boolean)
          .join(" · ") || "Конфигурация не поступала"}
      </p>
      <div className="machine-times" aria-label="Время данных машины">
        <div>
          <span>{packetTime ? "Последний пакет" : "Последнее событие"}</span>
          <b>{displayDate(packetTime ?? eventTime)}</b>
          {!packetTime && <StatusPill status={detail.connection_status} />}
        </div>
        {packetTime && (
          <div>
            <span>Время события</span>
            <b>{displayDate(eventTime)}</b>
            <StatusPill status={detail.connection_status} />
          </div>
        )}
      </div>
      <div className="position-reading">
        <MapIcon size={16} aria-hidden="true" />
        <div>
          <b>Последняя координата</b>
          {detail.position ? (
            <>
              <span>{coordinates(detail.position)}</span>
              <span>{displayDate(detail.position.observed_at)}</span>
              <StatusPill status={detail.position.status} />
            </>
          ) : (
            <span>Координаты не поступали</span>
          )}
        </div>
      </div>
      <div className="metrics">
        {primary.map((metric) => (
          <MetricReading metric={metric} key={metric.key} />
        ))}
      </div>
      {other.length > 0 && (
        <details className="other-metrics">
          <summary>
            Остальные показатели <span>{other.length}</span>
          </summary>
          <div className="metrics metrics--additional">
            {other.map((metric) => (
              <MetricReading metric={metric} key={metric.key} />
            ))}
          </div>
        </details>
      )}
      <p className="norm-note">
        Статус показывает свежесть данных, а не исправность машины. Заводские
        нормы для этой конфигурации не подтверждены.
      </p>
      <div className="volume-box">
        <div>
          <span>Объём за период</span>
          <Explanation
            label="Объём за период"
            text="Сумма неизменяемых событий журнала. Базы объёма не смешиваются."
            norm={null}
          />
        </div>
        {detail.totals.length ? (
          detail.totals.map((total) => (
            <div className="volume-total" key={total.basis}>
              <p>
                <b>{volume(total.volume_m3)} м³</b>
                <span>
                  {basisName(total.basis)} · {recordCount(total.records)}
                </span>
              </p>
              <ProvenanceNotice total={total} />
            </div>
          ))
        ) : (
          <span>Записей выработки нет</span>
        )}
      </div>
    </section>
  );
}

function MetricReading({ metric }: { metric: Metric }) {
  return (
    <div className="metric">
      <div>
        <span>{metric.label}</span>
        <Explanation
          label={metric.label}
          text={metric.explanation}
          norm={metric.norm}
        />
      </div>
      <strong>
        {metricValue(metric)}
        <em>{metric.value !== null ? metric.unit : ""}</em>
      </strong>
      <footer>
        <StatusPill status={metric.status} />
        <small>
          {metric.observed_at
            ? displayDate(metric.observed_at)
            : "Не поступало"}
        </small>
      </footer>
    </div>
  );
}

const sourceLabels: Record<string, string> = {
  onboard_measurement: "Бортовое измерение",
  operator_export: "Выгрузка оператора",
  accounting_import: "Учётный импорт",
};

const methodLabels: Record<string, string> = {
  harvester_onboard: "Бортовая система",
  merchantable_log: "Журнал товарной древесины",
  manual_ledger: "Ручной журнал",
};

function provenanceValues(
  values: string[],
  labels: Record<string, string> = {},
) {
  return values.length
    ? values.map((value) => labels[value] ?? value).join("; ")
    : "не указано";
}

function ProvenanceNotice({
  total,
  variant = "details",
}: {
  total: Total;
  variant?: "details" | "inline";
}) {
  const provenance = total.provenance;
  const sourceIsUnknown =
    !provenance ||
    provenance.sources.length === 0 ||
    provenance.sources.some(
      (source) =>
        ![
          "onboard_measurement",
          "operator_export",
          "accounting_import",
        ].includes(source),
    );
  const methodIsUnknown =
    !provenance ||
    provenance.methods.length === 0 ||
    provenance.methods.some(
      (method) =>
        !["harvester_onboard", "merchantable_log", "manual_ledger"].includes(
          method,
        ),
    );
  const versionIsUnknown =
    !provenance ||
    provenance.method_versions.length === 0 ||
    provenance.method_versions.some((version) => version === "unknown");
  const unknown =
    sourceIsUnknown ||
    methodIsUnknown ||
    versionIsUnknown ||
    total.warnings?.some((warning) => /неизвестн/i.test(warning));
  const warnings = [...new Set(total.warnings ?? [])];
  if (!provenance && !unknown && !warnings.length) return null;
  const source = provenanceValues(provenance?.sources ?? [], sourceLabels);
  const method = provenanceValues(provenance?.methods ?? [], methodLabels);
  const version = provenanceValues(provenance?.method_versions ?? []);
  const calibration = provenanceValues(provenance?.calibration_refs ?? []);
  return (
    <div className="provenance">
      {(unknown || warnings.length > 0) && (
        <div className="provenance-warning">
          {unknown && (
            <p>
              <AlertTriangle size={14} aria-hidden="true" />
              Источник, метод или версия методики указаны не полностью.
              Требуется сверка.
            </p>
          )}
          {warnings.map((warning) => (
            <p key={warning}>
              <AlertTriangle size={14} aria-hidden="true" />
              {warning}
            </p>
          ))}
        </div>
      )}
      {provenance &&
        (variant === "inline" ? (
          <p className="provenance-inline">
            Источник: {source}. Метод: {method}. Версия: {version}.
          </p>
        ) : (
          <details className="provenance-details">
            <summary>Источник, метод и версия</summary>
            <dl>
              <div>
                <dt>Источник</dt>
                <dd>{source}</dd>
              </div>
              <div>
                <dt>Метод</dt>
                <dd>{method}</dd>
              </div>
              <div>
                <dt>Версия</dt>
                <dd>{version}</dd>
              </div>
              {provenance.calibration_refs.length > 0 && (
                <div>
                  <dt>Идентификатор калибровки</dt>
                  <dd>{calibration}</dd>
                </div>
              )}
            </dl>
          </details>
        ))}
    </div>
  );
}

export function FleetView({
  fleet,
  machines,
  onSelect,
  validDates = true,
}: {
  fleet: Fleet | null;
  machines: Machine[];
  onSelect?: (id: string) => void;
  validDates?: boolean;
}) {
  return (
    <div className="content-page">
      <section className="intro">
        <p>
          Выработка рассчитана по событиям журнала за выбранный период UTC.
          Объём с корой, без коры и с неизвестной базой показан отдельно.
        </p>
      </section>
      {!fleet ? (
        <Empty>
          <p>
            {validDates
              ? "Сводка не получена. Нажмите «Обновить» после восстановления связи."
              : "Укажите корректный период, чтобы получить сводку выработки."}
          </p>
        </Empty>
      ) : (
        <>
          <div className="total-grid">
            {fleet.totals.length ? (
              fleet.totals.map((total) => (
                <article className="total-card" key={total.basis}>
                  <p>{basisName(total.basis)}</p>
                  <strong>
                    {volume(total.volume_m3)} <small>м³</small>
                  </strong>
                  <span>{recordCount(total.records)} журнала</span>
                  <ProvenanceNotice total={total} />
                </article>
              ))
            ) : (
              <Empty>
                <p>
                  За выбранный период событий выработки нет. Это не доказывает
                  нулевую выработку.
                </p>
              </Empty>
            )}
          </div>
          <section className="table-card">
            <div className="section-title">
              <div>
                <p className="eyebrow">Журнал выработки</p>
                <h2>По машинам</h2>
                <p className="section-description">
                  {machines.length} машин, {recordCount(fleet.record_count)}.
                </p>
              </div>
              <a
                className="text-button"
                href={`/api/exports/ledger.csv?start=${encodeURIComponent(fleet.period.start)}&end=${encodeURIComponent(fleet.period.end)}`}
              >
                <Download size={17} />
                Скачать журнал CSV
              </a>
            </div>
            <div
              className="table-scroll"
              tabIndex={0}
              role="region"
              aria-label="Расшифровка объёма по машинам"
            >
              <table>
                <caption className="sr-only">
                  Выработка и изменение счётчика наработки за выбранный период
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Машина</th>
                    <th scope="col">Выработка</th>
                    <th scope="col">Изменение счётчика</th>
                  </tr>
                </thead>
                <tbody>
                  {fleet.machines.map((machine) => (
                    <tr key={machine.id}>
                      <th scope="row">
                        {onSelect ? (
                          <button
                            className="machine-link"
                            type="button"
                            onClick={() => onSelect(machine.id)}
                          >
                            <b>{machine.name}</b>
                            <ArrowUpRight size={16} />
                          </button>
                        ) : (
                          machine.name
                        )}
                      </th>
                      <td>
                        {machine.totals.length
                          ? machine.totals.map((x) => (
                              <div key={x.basis}>
                                <span className="table-volume">
                                  <b>{volume(x.volume_m3)} м³</b>{" "}
                                  {basisName(x.basis)}
                                </span>
                                <ProvenanceNotice total={x} variant="inline" />
                              </div>
                            ))
                          : "Нет записей за период"}
                      </td>
                      <td>
                        {machine.engine_hours === null
                          ? "Недоступна: недостаточно наблюдений или счётчик сброшен"
                          : `${machine.engine_hours.toLocaleString("ru-RU")} ч между наблюдениями`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function QualityView({
  quality,
  loading,
}: {
  quality: Quality | null;
  loading: boolean;
}) {
  return (
    <div className="content-page">
      <section className="intro">
        <p>
          Счётчики показывают исходы пакетов, а не число событий. «Принято»
          означает, что пакет прошёл проверку формата и повторной доставки. Это
          не подтверждает исправность датчика.
        </p>
        <p>
          Журнал организации не включает отклонённые до определения организации
          пакеты: например, без авторизации или превышающие допустимый размер.
        </p>
      </section>
      {loading ? (
        <div className="loading" role="status">
          Получаем журнал приёма…
        </div>
      ) : !quality ? (
        <Empty>Журнал качества пока недоступен.</Empty>
      ) : (
        <>
          <div className="quality-counts">
            {Object.entries(quality.counts).map(([key, value]) => (
              <article key={key}>
                <b>{value}</b>
                <span>
                  {
                    {
                      accepted: "принято",
                      duplicates: "повторно",
                      rejected: "отклонено",
                    }[key]
                  }
                </span>
              </article>
            ))}
          </div>
          <section className="table-card">
            <div className="section-title">
              <div>
                <p className="eyebrow">Журнал приёма</p>
                <h2>Последние пакеты</h2>
              </div>
            </div>
            {quality.recent.length ? (
              <div
                className="table-scroll"
                tabIndex={0}
                role="region"
                aria-label="Аудит доставки"
              >
                <table>
                  <caption className="sr-only">
                    Последние исходы приёма пакетов
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Получено</th>
                      <th scope="col">Статус</th>
                      <th scope="col">Причина</th>
                    </tr>
                  </thead>
                  <tbody>
                    {quality.recent.map((item, index) => (
                      <tr key={`${item.received_at}-${index}`}>
                        <td>{displayDate(item.received_at)}</td>
                        <td>
                          {{
                            accepted: "Принято",
                            duplicate: "Повтор",
                            duplicates: "Повтор",
                            rejected: "Отклонено",
                          }[item.status] ?? item.status}
                        </td>
                        <td>{item.reason || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>Приём пакетов ещё не зафиксирован.</Empty>
            )}
          </section>
          {quality.limitations.length > 0 && (
            <section className="limitations">
              <h2>Что важно учесть</h2>
              {quality.limitations.map((x) => (
                <p key={x}>
                  <CircleHelp size={16} aria-hidden="true" />
                  {x}
                </p>
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}

export function DataView({
  dates,
  validDates,
  onOpenCompany,
}: {
  dates: { start: string; end: string };
  validDates: boolean;
  onOpenCompany?: () => void;
}) {
  const href = validDates
    ? `/api/exports/ledger.csv?start=${encodeURIComponent(dates.start)}&end=${encodeURIComponent(dates.end)}`
    : undefined;
  return (
    <div className="content-page narrow">
      <section className="data-lead">
        <Database size={27} aria-hidden="true" />
        <div>
          <p className="eyebrow">Подключение машины</p>
          <h2>Передача данных</h2>
          <p>
            Сначала добавьте конкретную машину и зафиксируйте доступный
            источник. Сервис принимает нормализованный JSON, но не заменяет
            OEM-адаптер.
          </p>
          {onOpenCompany && (
            <button
              className="button button--primary"
              type="button"
              onClick={onOpenCompany}
            >
              Настроить машину <ArrowUpRight size={17} aria-hidden="true" />
            </button>
          )}
        </div>
      </section>
      <div className="readiness-grid">
        <section>
          <h3>Доступно сейчас</h3>
          <p>
            API принимает нормализованные события, SQLite хранит записи,
            интерфейс показывает показатели и раздельные суммы. Локальная
            очередь повторяет доставку. Корректность проверяется синтетическими
            тестами.
          </p>
        </section>
        <section>
          <h3>Нужно подтвердить отдельно</h3>
          <p>
            Штатный компьютер реального харвестера, OEM/CAN/StanForD-адаптер и
            конфигурация 1С заказчика. Для них нужны доступ, эталонные файлы и
            отдельная проверка на технике.
          </p>
        </section>
      </div>
      <article className="instruction">
        <h3>Что принимает система</h3>
        <p>
          Только нормализованный JSON: события телеметрии, координаты и дельты
          выработки. Пакеты имеют идентификаторы, поэтому повторная доставка не
          должна удваивать записи. Сначала положите пакет в очередь, затем
          отправьте накопленные пакеты на HTTPS origin сервера.
        </p>
        <pre>
          <code>{`python -m edge.outbox enqueue normalized.json
export ITLES_DEVICE_TOKEN="ваш_токен_устройства"
python -m edge.outbox flush \\
  --url https://ваш-домен`}</code>
        </pre>
        <p className="fine-print">
          ITLES_DEVICE_TOKEN передаётся только через переменную окружения и не
          добавляется в команду. URL: HTTPS origin без /api/ingest и других
          путей. Это не доказывает поддержку CAN, StanForD, 1С или конкретной
          бортовой системы.
        </p>
      </article>
      <article className="instruction">
        <h3>Минимальный пакет production</h3>
        <p>
          Значение объёма передаётся десятичной строкой, а версия методики —
          обязательной технической меткой.
        </p>
        <pre>
          <code>{`{
  "schema_version": 1,
  "batch_id": "c2a7e35d-c33d-45c9-8a2e-09c772f0b75b",
  "events": [{
    "event_id": "69a339f6-69ab-4e54-8c4e-dfa7e239a2cb",
    "machine_id": "harvester_01",
    "occurred_at": "2026-01-14T08:30:00Z",
    "kind": "production",
    "volume_m3": "12.500000",
    "basis": "under_bark",
    "source": "onboard_measurement",
    "method": "harvester_onboard",
    "method_version": "synthetic-example-v1"
  }]
}`}</code>
        </pre>
      </article>
      <article className="instruction">
        <h3>Журнал для сверки</h3>
        <p>
          CSV содержит события выработки, источник и метод. Это выгрузка для
          проверки и сопоставления, <b>не интеграция с 1С</b>.
        </p>
        {href ? (
          <a className="button button--primary" href={href}>
            <Download size={17} />
            Скачать журнал CSV
          </a>
        ) : (
          <p className="fine-print">Укажите корректный период для выгрузки.</p>
        )}
      </article>
      <article className="instruction subtle">
        <h3>Перед подключением</h3>
        <ul>
          <li>
            Подтвердить доступные интерфейсы, версии ПО и лицензии на конкретной
            машине.
          </li>
          <li>
            Зафиксировать методику объёма, базу «с корой / без коры» и
            калибровку.
          </li>
          <li>
            Проверить накопление, повторную доставку и сверку с приёмкой в
            полевых условиях.
          </li>
        </ul>
      </article>
    </div>
  );
}

function Documents({ onSessionEnded }: { onSessionEnded: () => void }) {
  const [documents, setDocuments] = useState<DocumentItem[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setDocuments(null);
    request<{ documents: DocumentItem[] }>("/api/documents", {
      signal: controller.signal,
    })
      .then((x) => setDocuments(x.documents))
      .catch((err) => {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && err.status === 401) {
          onSessionEnded();
          return;
        }
        setError(err instanceof Error ? err.message : "Документы недоступны");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [attempt, onSessionEnded]);
  return (
    <div className="content-page narrow">
      <section className="intro">
        <p>
          Источники, методики расчёта и программа полевых испытаний. Документы
          отделяют подтверждённые сведения от проектных решений и непроверенных
          предположений.
        </p>
      </section>
      {error && (
        <>
          <div className="message message--error document-error" role="alert">
            {error}
          </div>
          <button
            className="button button--secondary document-retry"
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Повторить загрузку
          </button>
        </>
      )}
      {loading ? (
        <div className="loading" role="status">
          Получаем список документов…
        </div>
      ) : documents === null ? (
        <Empty>
          <p>Список документов не получен. Повторите загрузку.</p>
        </Empty>
      ) : documents.length === 0 ? (
        <Empty>Сервер пока не опубликовал документов.</Empty>
      ) : (
        <div className="document-list">
          {documents.map((doc) => (
            <a href={doc.url} key={doc.name} className="document" download>
              <FileText size={22} />
              <span>
                <b>{doc.title}</b>
                <small>{doc.name}</small>
              </span>
              <em>{doc.format}</em>
              <Download size={18} />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

const rootElement = document.getElementById("root");
if (rootElement) {
  createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
