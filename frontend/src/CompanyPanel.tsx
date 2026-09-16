import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { ApiError, request } from "./api";
import type { Session } from "./account-types";
import { Failure, Field, PasswordField, SecretNotice } from "./account-ui";
import "./account.css";

type MachineIdentity = {
  id: string;
  name: string;
  model: string | null;
  head: string | null;
  computer: string | null;
};
type AccessUser = {
  id: string;
  login: string;
  role: "admin" | "user";
  status: "active" | "pending" | "revoked";
  created_at: string;
  legacy_access?: boolean;
};
type Onboarding = {
  completed: boolean;
  step: string;
  machine_added: boolean;
  users_configured: boolean;
  source_configured: boolean;
  data_received: boolean;
  data_reviewed: boolean;
};
type Source = {
  model?: string | null;
  computer?: string | null;
  software_version?: string | null;
  source_kind: "unconfigured" | "normalized_json" | "unsupported";
  export_description?: string | null;
  permission_confirmed: boolean;
};
type SourceResponse = {
  machine: MachineIdentity;
  onboarding?: Onboarding;
  source: Source;
  connection: {
    state:
      | "added"
      | "source_unconfigured"
      | "awaiting_message"
      | "message_received"
      | "review_required"
      | "stale";
    last_received_at: string | null;
    last_observed_at: string | null;
    last_position_at: string | null;
    reviewed_at: string | null;
    message_count: number;
  };
  tokens: { id: string; created_at: string }[];
};
const connectionNames: Record<SourceResponse["connection"]["state"], string> = {
  added: "Машина добавлена",
  source_unconfigured: "Источник ещё не настроен",
  awaiting_message: "Ожидается первое сообщение",
  message_received: "Сообщение принято",
  review_required: "Данные требуют проверки",
  stale: "Данные устарели",
};
const userState = {
  active: "Доступ активен",
  pending: "Ожидает активации",
  revoked: "Доступ отозван",
};
const time = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat("ru-RU", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(new Date(value)) + " UTC"
    : "Не поступало";

export function CompanyPanel({
  session,
  onSessionEnded,
  onChanged,
  onOpenMachine,
}: {
  session: Session;
  onSessionEnded: () => void;
  onChanged?: () => void;
  onOpenMachine?: (id: string) => void;
}) {
  const admin = session.user?.role === "admin" && !session.demo;
  const [tab, setTab] = useState<"setup" | "users" | "account">(
    admin ? "setup" : "account",
  );
  const [machines, setMachines] = useState<MachineIdentity[]>([]);
  const [users, setUsers] = useState<AccessUser[]>([]);
  const [progress, setProgress] = useState<Onboarding | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(admin);
  const [error, setError] = useState<unknown>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (!admin) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    Promise.all([
      request<{ machines: MachineIdentity[] }>("/api/machines", {
        signal: controller.signal,
      }),
      request<{ users: AccessUser[] }>("/api/admin/users", {
        signal: controller.signal,
      }),
      request<Onboarding>("/api/admin/onboarding", {
        signal: controller.signal,
      }),
    ])
      .then(([fleet, access, onboarding]) => {
        if (!controller.signal.aborted) {
          setMachines(fleet.machines);
          setUsers(access.users);
          setProgress(onboarding);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          if (e instanceof ApiError && e.status === 401) onSessionEnded();
          else setError(e);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [admin, refresh, onSessionEnded]);

  const changed = useCallback(() => {
    setRefresh((value) => value + 1);
    onChanged?.();
  }, [onChanged]);

  if (session.demo)
    return (
      <p>
        Учебный парк доступен только для просмотра. Для настройки создайте свою
        компанию.
      </p>
    );
  return (
    <div className="company-panel">
      <nav className="company-tabs" aria-label="Настройки доступа">
        {admin && (
          <>
            <button
              className="secondary-button"
              aria-current={tab === "setup" ? "page" : undefined}
              onClick={() => setTab("setup")}
            >
              Машины и подключение
            </button>
            <button
              className="secondary-button"
              aria-current={tab === "users" ? "page" : undefined}
              onClick={() => setTab("users")}
            >
              Пользователи
            </button>
          </>
        )}
        <button
          className="secondary-button"
          aria-current={tab === "account" ? "page" : undefined}
          onClick={() => setTab("account")}
        >
          Мой доступ
        </button>
      </nav>
      <Failure error={error} />
      {!!error && (
        <button
          className="secondary-button"
          onClick={() => setRefresh((value) => value + 1)}
        >
          Повторить загрузку
        </button>
      )}
      {tab === "account" ? (
        <AccountSettings session={session} onSessionEnded={onSessionEnded} />
      ) : loading ? (
        <p role="status">Загружаем настройки компании…</p>
      ) : (
        !error && (
          <>
            {tab === "setup" && (
              <>
                <p>
                  Компания: <strong>{session.organization.name}</strong>. Код
                  для входа: <strong>{session.organization.account}</strong>.
                </p>
                {progress && (
                  <ol
                    className="setup-progress"
                    aria-label="Прогресс настройки компании"
                  >
                    <li data-complete={progress.machine_added}>
                      <strong>1. Добавить машину</strong>
                      <span>
                        {progress.machine_added
                          ? "Машина сохранена"
                          : "Нужны название и известная конфигурация"}
                      </span>
                    </li>
                    <li data-complete={progress.users_configured}>
                      <strong>2. Настроить доступ</strong>
                      <span>
                        {progress.users_configured
                          ? "Выбор доступа сохранён"
                          : "Выдать доступ или оставить только себе"}
                      </span>
                    </li>
                    <li data-complete={progress.source_configured}>
                      <strong>3. Настроить источник</strong>
                      <span>
                        {progress.source_configured
                          ? "Способ передачи сохранён. Проверьте приём данных"
                          : "Выяснить доступный интерфейс и разрешения"}
                      </span>
                    </li>
                    <li data-complete={progress.data_received}>
                      <strong>4. Получить сообщение</strong>
                      <span>
                        {progress.data_received
                          ? "На сервере есть принятые события"
                          : "Проверить отправитель, адрес и токен"}
                      </span>
                    </li>
                    <li data-complete={progress.data_reviewed}>
                      <strong>5. Сравнить данные</strong>
                      <span>
                        {progress.data_reviewed
                          ? "Сравнение с источником отмечено"
                          : "Открыть показания и сверить с источником"}
                      </span>
                    </li>
                  </ol>
                )}
                <p className="muted">
                  Сохранённые машины, доступ и описание источника останутся
                  после выхода. Сохранение формы не означает, что машина
                  передаёт данные.
                </p>
                {selected ? (
                  <MachineSource
                    machineId={selected}
                    onProgress={setProgress}
                    onBack={() => setSelected(null)}
                    onChanged={changed}
                    onOpenMachine={onOpenMachine}
                    onSessionEnded={onSessionEnded}
                  />
                ) : (
                  <>
                    <section className="company-section">
                      <header>
                        <h2>Машины компании</h2>
                        <button
                          className="quiet-button"
                          onClick={() => setTab("users")}
                        >
                          К настройке пользователей
                        </button>
                      </header>
                      {!machines.length ? (
                        <p className="company-empty">
                          Машин пока нет. Добавьте первую ниже, затем опишите
                          доступный источник.
                        </p>
                      ) : (
                        <ul className="company-machine-list">
                          {machines.map((machine) => (
                            <li key={machine.id}>
                              <div>
                                <strong>{machine.name}</strong>
                                <p className="muted">
                                  {machine.model || "Модель не указана"}
                                </p>
                              </div>
                              <button
                                className="secondary-button"
                                onClick={() => setSelected(machine.id)}
                                aria-label={`Настроить источник: ${machine.name}`}
                              >
                                Настроить источник
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                    <AddMachine
                      onAdded={(machine) => {
                        setSelected(machine.id);
                        changed();
                      }}
                    />
                  </>
                )}
              </>
            )}
            {tab === "users" && (
              <UserAccess
                users={users}
                account={session.organization.account ?? ""}
                onChanged={changed}
                onContinue={() => setTab("setup")}
              />
            )}
          </>
        )
      )}
    </div>
  );
}

function AddMachine({
  onAdded,
}: {
  onAdded: (machine: MachineIdentity) => void;
}) {
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await request<{ machine: MachineIdentity }>(
        "/api/admin/machines",
        {
          method: "POST",
          body: JSON.stringify({
            name: name.trim(),
            model: model.trim() || null,
          }),
        },
      );
      onAdded(result.machine);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="company-section">
      <h2>Добавить машину</h2>
      <p>
        Используйте бортовой или служебный номер, не имя оператора. Неизвестную
        модель можно уточнить при настройке источника.
      </p>
      <form
        className="account-form"
        onSubmit={(e) => void submit(e)}
        aria-busy={busy}
      >
        <fieldset disabled={busy}>
          <Field
            label="Название машины"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={100}
            hint="Например, Харвестер 04."
          />
          <Field
            label="Модель машины"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            maxLength={120}
            hint="Укажите фактическую модель, если она известна."
          />
          <Failure error={error} />
          <button className="primary-button" type="submit">
            {busy ? "Сохраняем машину…" : "Добавить машину"}
          </button>
        </fieldset>
      </form>
    </section>
  );
}

function UserAccess({
  users,
  account,
  onChanged,
  onContinue,
}: {
  users: AccessUser[];
  account: string;
  onChanged: () => void;
  onContinue: () => void;
}) {
  const [login, setLogin] = useState("");
  const [issued, setIssued] = useState<{
    user: AccessUser;
    activation_code: string;
    expires_at: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [success, setSuccess] = useState("");
  const [confirm, setConfirm] = useState<AccessUser | null>(null);
  async function action(run: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setSuccess("");
    try {
      await run();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  function issue(user?: AccessUser) {
    return action(async () => {
      const result = await request<{
        user: AccessUser;
        activation_code: string;
        expires_at: string;
      }>(
        user
          ? `/api/admin/users/${encodeURIComponent(user.id)}/reissue`
          : "/api/admin/users",
        {
          method: "POST",
          body: JSON.stringify(user ? {} : { login: login.trim() }),
        },
      );
      setIssued(result);
      setLogin("");
    });
  }
  if (issued)
    return (
      <SecretNotice
        title={`Доступ для ${issued.user.login}`}
        value={issued.activation_code}
        onDone={() => {
          setIssued(null);
          onChanged();
        }}
      >
        <p>
          Передайте сотруднику код компании <strong>{account}</strong>, логин{" "}
          <strong>{issued.user.login}</strong> и этот код активации по
          согласованному защищённому каналу. Сотрудник задаст свой пароль через
          «Войти в компанию» → «У меня есть код активации».
        </p>
        <p>
          Код действует до {time(issued.expires_at)}. Повторная выдача отменит
          предыдущий код и сеансы этого пользователя.
        </p>
      </SecretNotice>
    );
  return (
    <section className="company-section">
      <h2>Пользователи компании</h2>
      <p>
        Пользователь видит все машины, показатели и выгрузки только этой
        компании. Он не может менять настройки, выдавать доступ или токены.
        Разделение по отдельным машинам в этой версии не предусмотрено.
      </p>
      <Failure error={error} />
      {success && (
        <p role="status" className="success-message">
          {success}
        </p>
      )}
      <ul className="access-list">
        {users.map((user) => (
          <li key={user.id}>
            <div>
              <strong>{user.login}</strong>
              <p>
                {user.role === "admin"
                  ? "Администратор компании"
                  : userState[user.status]}
              </p>
            </div>
            {user.role === "user" && !user.legacy_access && (
              <div className="company-actions">
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => void issue(user)}
                >
                  Выдать новый код
                </button>
                {user.status !== "revoked" && (
                  <>
                    <button
                      className="quiet-button"
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await request(
                            `/api/admin/users/${encodeURIComponent(user.id)}/sessions/revoke`,
                            { method: "POST", body: "{}" },
                          );
                          setSuccess(
                            `Сеансы ${user.login} завершены. Право на новый вход сохранено.`,
                          );
                        })
                      }
                    >
                      Завершить сеансы
                    </button>
                    <button
                      className="danger-button"
                      disabled={busy}
                      onClick={() => setConfirm(user)}
                    >
                      Отозвать доступ
                    </button>
                  </>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {confirm && (
        <div
          className="confirmation-box"
          role="group"
          aria-label="Подтверждение отзыва доступа"
        >
          <p>
            Отозвать доступ <strong>{confirm.login}</strong>? Все его сеансы и
            код активации будут отменены. Данные компании сохранятся.
          </p>
          <div className="company-actions">
            <button
              className="danger-button"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await request(
                    `/api/admin/users/${encodeURIComponent(confirm.id)}`,
                    { method: "DELETE" },
                  );
                  setConfirm(null);
                  onChanged();
                })
              }
            >
              Подтвердить отзыв
            </button>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => setConfirm(null)}
            >
              Отмена
            </button>
          </div>
        </div>
      )}
      <form
        className="account-form"
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault();
          void issue();
        }}
      >
        <fieldset disabled={busy}>
          <Field
            label="Логин нового пользователя"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            required
            minLength={2}
            maxLength={80}
            pattern="[a-z0-9]+(?:[._\-][a-z0-9]+)*"
            autoComplete="off"
            hint="Служебный идентификатор, например dispatcher-01. Без имени, телефона и почты."
          />
          <button className="primary-button" type="submit">
            {busy ? "Выполняем действие…" : "Выдать доступ"}
          </button>
        </fieldset>
      </form>
      <div className="company-actions">
        <button
          className="secondary-button"
          disabled={busy}
          onClick={() =>
            void action(async () => {
              await request("/api/admin/onboarding", {
                method: "PATCH",
                body: JSON.stringify({
                  users_configured: true,
                  step: "source",
                }),
              });
              onChanged();
              onContinue();
            })
          }
        >
          Доступ настроен, перейти к машинам
        </button>
        <button
          className="quiet-button"
          disabled={busy}
          onClick={() =>
            void action(async () => {
              await request("/api/admin/onboarding", {
                method: "PATCH",
                body: JSON.stringify({
                  users_configured: true,
                  step: "source",
                }),
              });
              onChanged();
              onContinue();
            })
          }
        >
          Пока только я, продолжить позже
        </button>
      </div>
    </section>
  );
}

function MachineSource({
  machineId,
  onProgress,
  onBack,
  onChanged,
  onOpenMachine,
  onSessionEnded,
}: {
  machineId: string;
  onProgress: (progress: Onboarding) => void;
  onBack: () => void;
  onChanged: () => void;
  onOpenMachine?: (id: string) => void;
  onSessionEnded: () => void;
}) {
  const [data, setData] = useState<SourceResponse | null>(null);
  const [source, setSource] = useState<Source>({
    source_kind: "unconfigured",
    permission_confirmed: false,
  });
  const [error, setError] = useState<unknown>(null);
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [compared, setCompared] = useState(false);
  const title = useRef<HTMLHeadingElement>(null);
  const confirmation = useRef<HTMLParagraphElement>(null);
  const path = `/api/admin/machines/${encodeURIComponent(machineId)}`;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    request<SourceResponse>(`${path}/source`, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) {
          setData(result);
          setCompared(false);
          if (result.onboarding) onProgress(result.onboarding);
          setSource({
            ...result.source,
            model: result.source.model ?? result.machine.model,
            computer: result.source.computer ?? result.machine.computer,
          });
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          if (e instanceof ApiError && e.status === 401) onSessionEnded();
          else setError(e);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [path, refresh, onSessionEnded, onProgress]);
  useEffect(() => {
    if (data && !loading) title.current?.focus();
  }, [!!data, loading]);
  useEffect(() => {
    if (success) confirmation.current?.focus();
  }, [success]);

  async function action(run: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setSuccess("");
    try {
      await run();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  function save(event: FormEvent) {
    event.preventDefault();
    void action(async () => {
      const result = await request<SourceResponse>(`${path}/source`, {
        method: "PUT",
        body: JSON.stringify(source),
      });
      setData(result);
      setCompared(false);
      if (result.onboarding) onProgress(result.onboarding);
      setSource(result.source);
      setSuccess(
        "Описание источника сохранено. Приём сообщений проверяется отдельно.",
      );
    });
  }
  return (
    <section className="company-section">
      <button
        className="quiet-button"
        onClick={() => {
          onChanged();
          onBack();
        }}
        disabled={busy}
      >
        К списку машин
      </button>
      <Failure error={error} />
      {loading ? (
        <p role="status">Загружаем источник…</p>
      ) : !data ? (
        <button
          className="secondary-button"
          onClick={() => setRefresh((value) => value + 1)}
        >
          Повторить загрузку
        </button>
      ) : (
        <>
          <h2 ref={title} tabIndex={-1}>
            {data.machine.name}: источник данных
          </h2>
          <p>
            <strong>{connectionNames[data.connection.state]}</strong>
          </p>
          <dl className="connection-facts">
            <div>
              <dt>Последний принятый пакет</dt>
              <dd>{time(data.connection.last_received_at)}</dd>
            </div>
            <div>
              <dt>Последнее наблюдение в данных</dt>
              <dd>{time(data.connection.last_observed_at)}</dd>
            </div>
            <div>
              <dt>Время последних координат</dt>
              <dd>{time(data.connection.last_position_at)}</dd>
            </div>
            <div>
              <dt>Сравнение с источником</dt>
              <dd>
                {data.connection.reviewed_at
                  ? time(data.connection.reviewed_at)
                  : "Ещё не отмечено"}
              </dd>
            </div>
          </dl>
          <p className="muted">
            Свежий пакет может содержать старые показания. Приём данных не
            подтверждает исправность машины и точность датчиков.
          </p>
          {success && (
            <p
              role="status"
              className="success-message"
              tabIndex={-1}
              ref={confirmation}
            >
              {success}
            </p>
          )}
          <form className="account-form" onSubmit={save} aria-busy={busy}>
            <fieldset disabled={busy}>
              <Field
                label="Модель машины"
                value={source.model ?? ""}
                onChange={(e) =>
                  setSource({ ...source, model: e.target.value })
                }
                maxLength={120}
              />
              <Field
                label="Бортовой компьютер"
                value={source.computer ?? ""}
                onChange={(e) =>
                  setSource({ ...source, computer: e.target.value })
                }
                maxLength={120}
                hint="Фактическая модель компьютера, не только марка харвестера."
              />
              <Field
                label="Версия бортового ПО"
                value={source.software_version ?? ""}
                onChange={(e) =>
                  setSource({ ...source, software_version: e.target.value })
                }
                maxLength={120}
              />
              <label className="account-field">
                <span>Доступный способ передачи</span>
                <select
                  value={source.source_kind}
                  onChange={(e) =>
                    setSource({
                      ...source,
                      source_kind: e.target.value as Source["source_kind"],
                    })
                  }
                >
                  <option value="unconfigured">Ещё не выяснен</option>
                  <option value="normalized_json">
                    Нормализованный JSON по контракту ИТлес
                  </option>
                  <option value="unsupported">
                    OEM / CAN / StanForD или другой неподдерживаемый источник
                  </option>
                </select>
              </label>
              <Field
                label="Экспорт, API или интерфейс"
                value={source.export_description ?? ""}
                onChange={(e) =>
                  setSource({ ...source, export_description: e.target.value })
                }
                maxLength={500}
                hint="Что реально доступно, какая документация или эталонный файл есть. Не вводите пароли и ключи."
              />
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={source.permission_confirmed}
                  onChange={(e) =>
                    setSource({
                      ...source,
                      permission_confirmed: e.target.checked,
                    })
                  }
                />
                Доступ к указанному источнику разрешён владельцем техники
              </label>
              <button className="primary-button" type="submit">
                {busy ? "Сохраняем…" : "Сохранить описание источника"}
              </button>
            </fieldset>
          </form>
          {data.source.source_kind === "unsupported" && (
            <section className="company-section">
              <h3>Для этого источника адаптера пока нет</h3>
              <p>
                Получите у владельца техники или поставщика документацию
                разрешённого интерфейса и обезличенный эталонный файл. После
                этого нужен отдельный адаптер в нормализованный JSON и проверка
                его результата. Выданный токен не добавляет поддержку OEM, CAN
                или StanForD.
              </p>
              <p>
                Не подключайте сервис к управлению машиной и не меняйте бортовую
                сеть без отдельной инженерной проверки.
              </p>
            </section>
          )}
          {data.source.source_kind === "unconfigured" && (
            <p className="company-section">
              Следующий шаг: выясните модель компьютера, версию ПО и доступный
              экспорт у ответственного за технику. Можно сохранить известные
              сведения и вернуться позже.
            </p>
          )}
          {data.source.source_kind === "normalized_json" && (
            <>
              <section className="company-section">
                <h3>Передача нормализованных данных</h3>
                <p>
                  Этот путь работает только для файла, уже преобразованного в
                  контракт ИТлес. Очередь outbox не читает OEM/CAN/StanForD и не
                  преобразует исходный файл сама.
                </p>
                <ol className="instruction-steps">
                  <li>
                    На согласованном компьютере предприятия установите Python
                    3.12 и зависимости из архива ИТлес. Сырые данные и
                    преобразование остаются на стороне предприятия.
                  </li>
                  <li>
                    Проверьте разрешение на чтение и подготовьте нормализованный
                    JSON. ID этой машины: <code>{machineId}</code>. В каждом
                    событии должен быть этот ID, стабильный UUID и время UTC.
                    Объём является дельтой, не накопительным счётчиком.
                  </li>
                  <li>
                    Выдайте ниже токен только для этой машины. Передайте его
                    процессу очереди через защищённую переменную{" "}
                    <code>ITLES_DEVICE_TOKEN</code>, не параметр команды и не
                    URL.
                  </li>
                  <li>
                    Поставьте файл в очередь и отправьте на HTTPS-адрес вашего
                    сервера:
                    <pre>{`.venv/bin/python -m edge.outbox --db .local/outbox.sqlite3 enqueue normalized.json\n.venv/bin/python -m edge.outbox --db .local/outbox.sqlite3 flush --url ${window.location.origin.startsWith("https:") ? window.location.origin : "https://your-approved-host.example"}\n.venv/bin/python -m edge.outbox --db .local/outbox.sqlite3 status`}</pre>
                    При потере сети повторяйте доставку тех же событий с теми же
                    ID. Конфликтующие события требуют разбора, не переименования
                    ID.
                  </li>
                  <li>
                    Нажмите «Проверить поступление». Откройте показания,
                    сравните время, единицы, базу объёма и значения с
                    разрешённым исходным файлом. Отдельно выполните инженерную и
                    метрологическую проверку реальных измерений.
                  </li>
                </ol>
                <details className="technical-details">
                  <summary>
                    Контракт и безопасная синтетическая проверка
                  </summary>
                  <p>
                    Схема доступна в{" "}
                    <a href="/openapi.json" target="_blank" rel="noreferrer">
                      OpenAPI JSON
                    </a>
                    , типы и пример формирования находятся в архиве исходников:{" "}
                    <code>backend/schemas.py</code> и{" "}
                    <code>scripts/stress_synthetic.py</code>. Не отправляйте
                    синтетический объём в производственную машину. Для проверки
                    создайте отдельную тестовую машину или компанию.
                  </p>
                  <p>
                    JSON schema_version: 1. До 500 событий в пакете и 512 КиБ на
                    запрос. В ответе приёма должны быть JSON и числа
                    принятых/повторных событий. CSV остаётся выгрузкой журнала,
                    не интеграцией с 1С.
                  </p>
                </details>
              </section>
            </>
          )}
          {(data.source.source_kind === "normalized_json" ||
            data.tokens.length > 0) && (
            <>
              <section className="company-section">
                <h3>Токен устройства</h3>
                <p>
                  Активных токенов: {data.tokens.length}. Токен даёт только
                  приём событий этой машины, не просмотр данных и не вход в
                  компанию. Новый токен заменяет прежний.
                </p>
                {token ? (
                  <SecretNotice
                    title="Сохраните токен устройства"
                    value={token}
                    secretLabel="Токен устройства"
                    onDone={() => {
                      setToken("");
                      setRefresh((value) => value + 1);
                    }}
                  >
                    <p>
                      Сохраните в защищённом окружении отправителя. После
                      закрытия токен нельзя прочитать повторно; можно только
                      выдать замену.
                    </p>
                  </SecretNotice>
                ) : (
                  data.source.source_kind === "normalized_json" && (
                    <form
                      className="account-form"
                      aria-busy={busy}
                      onSubmit={(event) => {
                        event.preventDefault();
                        void action(async () => {
                          const result = await request<{ token: string }>(
                            `${path}/tokens`,
                            {
                              method: "POST",
                              body: JSON.stringify({ password }),
                            },
                          );
                          setPassword("");
                          setToken(result.token);
                        });
                      }}
                    >
                      <fieldset disabled={busy}>
                        <PasswordField
                          label="Ваш пароль для выдачи токена"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          required
                          maxLength={128}
                          autoComplete="current-password"
                        />
                        <button className="primary-button" type="submit">
                          {busy
                            ? "Выдаём токен…"
                            : data.tokens.length
                              ? "Заменить токен устройства"
                              : "Выдать токен устройства"}
                        </button>
                      </fieldset>
                    </form>
                  )
                )}
                {!!data.tokens.length && !token && (
                  <div className="company-actions">
                    <button
                      className="danger-button"
                      disabled={busy}
                      onClick={() => setConfirmRevoke(true)}
                    >
                      Отозвать токены машины
                    </button>
                  </div>
                )}
                {confirmRevoke && (
                  <div className="confirmation-box">
                    <p>
                      После отзыва новые пакеты с этими токенами будут
                      отклоняться. Уже принятые данные сохранятся.
                    </p>
                    <div className="company-actions">
                      <button
                        className="danger-button"
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            await request(`${path}/tokens`, {
                              method: "DELETE",
                            });
                            setConfirmRevoke(false);
                            setRefresh((value) => value + 1);
                            setSuccess(
                              "Токены отозваны. Приём по прежним ключам запрещён.",
                            );
                          })
                        }
                      >
                        Подтвердить отзыв токенов
                      </button>
                      <button
                        className="secondary-button"
                        disabled={busy}
                        onClick={() => setConfirmRevoke(false)}
                      >
                        Отмена
                      </button>
                    </div>
                  </div>
                )}
              </section>
            </>
          )}
          <section className="company-section">
            <h3>Проверка поступления и данных</h3>
            <p>
              {data.connection.message_count
                ? "На сервере есть принятые пакеты. Проверьте сами значения, не только факт доставки."
                : "Принятых пакетов пока нет. Нулевую выработку из этого вывести нельзя."}
            </p>
            <div className="company-actions">
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => {
                  setRefresh((value) => value + 1);
                  setSuccess("");
                }}
              >
                Проверить поступление
              </button>
              {onOpenMachine && (
                <button
                  className="secondary-button"
                  onClick={() => onOpenMachine(machineId)}
                >
                  Открыть показания машины
                </button>
              )}
            </div>
            {!!data.connection.message_count &&
              data.source.source_kind === "normalized_json" &&
              data.source.permission_confirmed && (
                <>
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={compared}
                      onChange={(e) => setCompared(e.target.checked)}
                    />
                    Я сравнил время, единицы и значения с исходным файлом. Это
                    не подтверждение точности датчиков.
                  </label>
                  <button
                    className="secondary-button"
                    disabled={busy || !compared}
                    onClick={() =>
                      void action(async () => {
                        const result = await request<SourceResponse>(
                          `${path}/review`,
                          {
                            method: "POST",
                            body: JSON.stringify({
                              message_count: data.connection.message_count,
                            }),
                          },
                        );
                        setData(result);
                        if (result.onboarding) onProgress(result.onboarding);
                        setCompared(false);
                        setSuccess(
                          "Сравнение с источником отмечено. Метрологическая проверка остаётся отдельным испытанием.",
                        );
                      })
                    }
                  >
                    Отметить сравнение с источником
                  </button>
                </>
              )}
          </section>
        </>
      )}
    </section>
  );
}

function AccountSettings({
  session,
  onSessionEnded,
}: {
  session: Session;
  onSessionEnded: () => void;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [recoveryPassword, setRecoveryPassword] = useState("");
  const [recovery, setRecovery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirmLogout, setConfirmLogout] = useState(false);
  async function action(run: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="company-section">
      <h2>Мой доступ</h2>
      <p>
        Компания: <strong>{session.organization.name}</strong>. Код:{" "}
        <strong>{session.organization.account}</strong>.<br />
        Служебный логин: <strong>{session.user?.login}</strong>. Права:{" "}
        <strong>
          {session.user?.role === "admin"
            ? "администратор"
            : "просмотр данных компании"}
        </strong>
        .
      </p>
      {session.user?.legacy_access && (
        <p className="inline-warning" role="status">
          Это переходный доступ прежней версии, только для чтения. Общий пароль
          не подтверждает права администратора. Владелец сервера должен отдельно
          подтвердить администратора компании, после чего он выдаст вам
          индивидуальный код доступа.
        </p>
      )}
      <Failure error={error} />
      {!session.user?.legacy_access && (
        <>
          <h3>Заменить пароль</h3>
          <p>
            После замены все ваши сеансы будут завершены. Войдите с новым
            паролем.
          </p>
          <form
            className="account-form"
            aria-busy={busy}
            onSubmit={(event) => {
              event.preventDefault();
              void action(async () => {
                await request("/api/auth/password", {
                  method: "POST",
                  body: JSON.stringify({
                    current_password: currentPassword,
                    new_password: newPassword,
                  }),
                });
                setCurrentPassword("");
                setNewPassword("");
                onSessionEnded();
              });
            }}
          >
            <fieldset disabled={busy}>
              <PasswordField
                label="Текущий пароль"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
                maxLength={128}
                autoComplete="current-password"
              />
              <PasswordField
                label="Новый личный пароль"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
                hint="От 12 символов; не передавайте его другим сотрудникам."
              />
              <button className="primary-button" type="submit">
                {busy ? "Сохраняем…" : "Заменить пароль"}
              </button>
            </fieldset>
          </form>
        </>
      )}
      {session.user?.role === "admin" && (
        <section className="company-section">
          <h3>Восстановление без почты и телефона</h3>
          {recovery ? (
            <SecretNotice
              title="Новый код восстановления"
              value={recovery}
              onDone={() => setRecovery("")}
            >
              <p>
                Предыдущий код больше не действует. Сохраните новый в защищённом
                хранилище. Код действует 30 дней; после истечения его можно
                заменить здесь, подтвердив свой пароль.
              </p>
            </SecretNotice>
          ) : (
            <form
              className="account-form"
              aria-busy={busy}
              onSubmit={(event) => {
                event.preventDefault();
                void action(async () => {
                  const result = await request<{ recovery_code: string }>(
                    "/api/auth/recovery-code",
                    {
                      method: "POST",
                      body: JSON.stringify({ password: recoveryPassword }),
                    },
                  );
                  setRecovery(result.recovery_code);
                  setRecoveryPassword("");
                });
              }}
            >
              <fieldset disabled={busy}>
                <PasswordField
                  label="Ваш пароль для замены кода"
                  value={recoveryPassword}
                  onChange={(e) => setRecoveryPassword(e.target.value)}
                  required
                  maxLength={128}
                  autoComplete="current-password"
                />
                <button className="secondary-button" type="submit">
                  Заменить код восстановления
                </button>
              </fieldset>
            </form>
          )}
        </section>
      )}
      <section className="company-section">
        <h3>Сеансы</h3>
        <p>
          Если входили на чужом устройстве, завершите все свои сеансы. Доступы
          коллег не изменятся.
        </p>
        <button
          className="danger-button"
          disabled={busy}
          onClick={() => setConfirmLogout(true)}
        >
          Выйти на всех устройствах
        </button>
        {confirmLogout && (
          <div className="confirmation-box">
            <p>Текущий сеанс тоже будет завершён.</p>
            <div className="company-actions">
              <button
                className="danger-button"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await request("/api/auth/logout-all", {
                      method: "POST",
                      body: "{}",
                    });
                    onSessionEnded();
                  })
                }
              >
                Подтвердить выход везде
              </button>
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => setConfirmLogout(false)}
              >
                Отмена
              </button>
            </div>
          </div>
        )}
      </section>
    </section>
  );
}
