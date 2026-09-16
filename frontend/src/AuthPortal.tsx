import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, request } from "./api";
import type { Session } from "./account-types";
import { Failure, Field, PasswordField, SecretNotice } from "./account-ui";
import "./account.css";

type Mode = "start" | "admin" | "login" | "register" | "activate" | "recover";
type AuthResult = Session & { recovery_code?: string };

async function confirmedSession(expected: Session): Promise<Session> {
  try {
    const actual = await request<Session>("/api/auth/me");
    if (
      actual.organization.id !== expected.organization.id ||
      actual.user?.id !== expected.user?.id
    ) {
      throw new ApiError(401, "Сеанс входа не совпадает с ответом сервера.");
    }
    return actual;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      throw new ApiError(
        401,
        "Сервер принял вход, но браузер не подтвердил сеанс. Откройте сайт в отдельной вкладке по HTTPS и повторите вход. Если проблема остаётся, сообщите администратору адрес страницы; не отключайте защиту cookies.",
        "session_not_retained",
        error.requestId,
        "/api/auth/me",
      );
    }
    throw error;
  }
}

type AuthPortalProps = {
  onSuccess: (session: Session) => void;
  initialMessage?: string;
  demoAvailable?: boolean;
};

export function AuthPortal(props: AuthPortalProps) {
  // Strict session cookies cannot be used in a cross-site preview frame.
  if (window.self !== window.top) {
    return (
      <main className="entry-shell" id="main-content">
        <header className="entry-header">
          <span className="wordmark-button">ИТлес</span>
          <span>Мониторинг харвестеров</span>
        </header>
        <section className="entry-intro">
          <h1>Мониторинг харвестеров</h1>
          <p>
            Сейчас сайт открыт во встроенном окне. Для входа откройте его в
            отдельной вкладке: во встроенном окне другого сайта браузер не
            сохраняет защищённый сеанс ИТлес.
          </p>
        </section>
        <section className="entry-path" aria-label="Открыть сайт для проверки">
          <div>
            <h2>Посмотреть учебный парк</h2>
            <p>Ключ и регистрация для демо не нужны.</p>
            <p>
              В новой вкладке нажмите «Посмотреть демо». Там же доступны
              создание своей компании и вход сотрудника.
            </p>
          </div>
          <a
            className="primary-button entry-standalone-link"
            href={`${window.location.origin}${window.location.pathname}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Открыть ИТлес в новой вкладке
          </a>
        </section>
        <p className="entry-standalone-url">
          Если новая вкладка не открылась, скопируйте адрес в адресную строку
          браузера:{" "}
          <code>
            {window.location.origin}
            {window.location.pathname}
          </code>
        </p>
        <p className="entry-footer">
          Учебный парк содержит вымышленные машины и записи с фиксированными
          датами. Реальная техника не подключена.
        </p>
      </main>
    );
  }
  return <StandaloneAuthPortal {...props} />;
}

function StandaloneAuthPortal({
  onSuccess,
  initialMessage = "",
  demoAvailable,
}: AuthPortalProps) {
  const [mode, setMode] = useState<Mode>("start");
  const [account, setAccount] = useState("");
  const [login, setLogin] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<unknown>(initialMessage);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<AuthResult | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [optionsRetry, setOptionsRetry] = useState(0);
  const [options, setOptions] = useState<{
    demo_enabled: boolean;
    registration_enabled?: boolean;
  } | null>(
    demoAvailable === undefined ? null : { demo_enabled: demoAvailable },
  );
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setOptionsLoading(true);
    request<{ demo_enabled: boolean; registration_enabled?: boolean }>(
      "/api/auth/options",
      { signal: controller.signal },
    )
      .then(setOptions)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e);
      })
      .finally(() => {
        if (!controller.signal.aborted) setOptionsLoading(false);
      });
    return () => controller.abort();
  }, [optionsRetry]);

  useEffect(() => {
    if (mode !== "start") heading.current?.focus();
  }, [mode]);

  function navigate(next: Mode) {
    setMode(next);
    setError("");
    setPassword("");
    setCode("");
    if (next === "admin" && !login) setLogin("admin");
  }

  async function finishSecret() {
    if (!pending) return;
    setBusy(true);
    setError("");
    try {
      onSuccess(await confirmedSession(pending));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function enterDemo() {
    setBusy(true);
    setError("");
    try {
      const result = await request<Session>("/api/auth/demo", {
        method: "POST",
        body: "{}",
      });
      onSuccess(await confirmedSession(result));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const action = mode === "admin" ? "login" : mode;
    const payload =
      mode === "register"
        ? {
            organization_name: name.trim(),
            account: account.trim(),
            login: login.trim(),
            password,
          }
        : mode === "activate"
          ? {
              account: account.trim(),
              login: login.trim(),
              code: code.trim(),
              password,
            }
          : mode === "recover"
            ? {
                account: account.trim(),
                login: login.trim(),
                recovery_code: code.trim(),
                password,
              }
            : { account: account.trim(), login: login.trim(), password };
    try {
      const result = await request<AuthResult>(`/api/auth/${action}`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setPassword("");
      setCode("");
      if (result.recovery_code) setPending(result);
      else onSuccess(await confirmedSession(result));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const title: Record<Mode, string> = {
    start: "Мониторинг харвестеров",
    admin: "Вход администратора",
    login: "Войти в компанию",
    register: "Создать компанию",
    activate: "Получить доступ",
    recover: "Восстановить доступ администратора",
  };
  const newPassword = ["register", "activate", "recover"].includes(mode);

  return (
    <main className="entry-shell" id="main-content">
      <header className="entry-header">
        <button
          className="wordmark-button"
          onClick={() => navigate("start")}
          disabled={busy || !!pending}
          aria-label="ИТлес: к выбору входа"
        >
          ИТлес
        </button>
        <span>Мониторинг харвестеров</span>
      </header>
      {pending ? (
        <div className="entry-form-wrap">
          <p className="success-message" role="status">
            {mode === "register"
              ? "Компания и учётная запись созданы."
              : mode === "activate"
                ? "Доступ администратора активирован."
                : "Пароль заменён. Прежние сеансы завершены."}
          </p>
          <SecretNotice
            title="Сохраните код восстановления"
            value={pending.recovery_code!}
            busy={busy}
            onDone={() => void finishSecret()}
          >
            <p>
              Он позволит заменить пароль администратора без почты и телефона.
              Код действует 30 дней. После использования будет выдан новый;
              обновить код можно в разделе «Мой доступ».
            </p>
            <p>
              Код компании:{" "}
              <strong>{pending.organization.account ?? account}</strong>. Логин:{" "}
              <strong>{pending.user?.login ?? login}</strong>.
            </p>
          </SecretNotice>
          {busy && <p role="status">Проверяем сеанс…</p>}
          <Failure error={error} />
        </div>
      ) : mode === "start" ? (
        <>
          <section className="entry-intro">
            <h1>Мониторинг харвестеров</h1>
            <p>
              ИТлес собирает данные харвестеров в одном журнале. Можно проверить
              последнее сообщение, найти машину и сверить объём за выбранный
              период.
            </p>
          </section>
          <Failure error={error} />
          <section className="entry-paths" aria-label="Выберите способ входа">
            <article className="entry-path entry-primary">
              <div>
                <h2>Для новой компании</h2>
                <p>
                  Создайте свою учётную запись, добавьте машины и выдайте
                  сотрудникам доступ. Настройку можно продолжить позже.
                </p>
              </div>
              <div className="entry-path-actions">
                <button
                  className="primary-button"
                  onClick={() => navigate("register")}
                  disabled={busy || options?.registration_enabled === false}
                >
                  Я администратор компании
                </button>
                <button
                  className="quiet-button"
                  onClick={() => navigate("admin")}
                  disabled={busy}
                >
                  Уже зарегистрированы? Войти
                </button>
              </div>
            </article>
            <article className="entry-path">
              <div>
                <h2>Для сотрудников и руководителей</h2>
                <p>
                  Нужны код компании, личный служебный логин и пароль. Доступ
                  выдаёт администратор вашей компании.
                </p>
              </div>
              <button
                className="secondary-button"
                onClick={() => navigate("login")}
                disabled={busy}
              >
                Войти в компанию
              </button>
            </article>
            <article className="entry-path">
              <div>
                <h2>Учебный парк</h2>
                <p>
                  Вымышленные машины и данные с фиксированными датами. Демо
                  изолировано от компаний и не требует регистрации.
                </p>
                <p>Ключ для демо не нужен.</p>
                {options?.demo_enabled === false && (
                  <p className="inline-warning">
                    Учебный парк отключён на этом сервере.
                  </p>
                )}
              </div>
              <button
                className="secondary-button"
                onClick={() => void enterDemo()}
                disabled={busy || !options?.demo_enabled}
              >
                {busy ? "Открываем учебный парк…" : "Посмотреть демо"}
              </button>
            </article>
          </section>
          {!options && optionsLoading && (
            <p role="status">Проверяем доступность входа…</p>
          )}
          {!options && !optionsLoading && (
            <button
              className="secondary-button"
              onClick={() => {
                setError("");
                setOptionsRetry((value) => value + 1);
              }}
            >
              Проверить доступность снова
            </button>
          )}
          {options?.registration_enabled === false && (
            <p className="inline-warning">
              Регистрация на этом сервере отключена. Уже выданный доступ
              продолжает работать.
            </p>
          )}
          <footer className="entry-footer">
            Подключение реальной машины требует поддерживаемого источника
            данных. Универсальный адаптер OEM / CAN / StanForD в эту версию не
            входит.
          </footer>
        </>
      ) : (
        <section className="entry-form-wrap">
          <button
            type="button"
            className="quiet-button back-button"
            onClick={() => navigate("start")}
            disabled={busy}
          >
            К выбору входа
          </button>
          <h1 ref={heading} tabIndex={-1}>
            {title[mode]}
          </h1>
          {mode === "register" && (
            <p>
              Создаётся отдельная компания. Совпадение названия с другой
              компанией не даёт доступа к её данным. Почта, телефон и ФИО не
              нужны.
            </p>
          )}
          {mode === "admin" && (
            <p>
              Войдите в свою учётную запись администратора. Для новой компании
              выберите регистрацию на первом экране.
            </p>
          )}
          {mode === "admin" && (
            <details className="technical-details">
              <summary>Доступ из прежней версии</summary>
              <p>
                Если доступ был создан в прежней версии по общему паролю
                компании, сначала нужен одноразовый код от владельца сервера
                после подтверждения ваших прав. Старый общий пароль не даёт
                административных полномочий.
              </p>
            </details>
          )}
          {mode === "login" && (
            <p>
              Вход по индивидуальному доступу, не регистрация. Если доступа нет,
              попросите администратора выдать служебный логин и одноразовый код
              активации.
            </p>
          )}
          {mode === "login" && (
            <details className="technical-details">
              <summary>Доступ из прежней версии</summary>
              <p>
                До переноса владельцем сервера прежний общий пароль работает
                только на чтение с логином <strong>legacy</strong>. После
                назначения администратора этот переходный доступ отключается;
                получите индивидуальный код активации.
              </p>
            </details>
          )}
          {mode === "activate" && (
            <p>
              Введите данные, полученные от администратора. Придумайте
              собственный пароль, который не нужно передавать коллегам.
            </p>
          )}
          {mode === "recover" && (
            <p>
              Нужен сохранённый одноразовый код восстановления. Он заменит
              пароль и завершит прежние сеансы. Если кода нет, обратитесь к
              владельцу сервера: подтверждение прав выполняется отдельно, не по
              названию компании.
            </p>
          )}
          <form
            className="account-form"
            onSubmit={(e) => void submit(e)}
            aria-busy={busy}
          >
            <fieldset disabled={busy}>
              {mode === "register" && (
                <Field
                  label="Название компании"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={100}
                  autoComplete="organization"
                  hint="Рабочее название без персональных данных."
                />
              )}
              <Field
                label="Код компании"
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                required
                minLength={2}
                maxLength={80}
                pattern={
                  mode === "register"
                    ? "[a-z0-9]+(?:[._\\-][a-z0-9]+)*"
                    : "[A-Za-z0-9]+(?:[._\\-][A-Za-z0-9]+)*"
                }
                autoCapitalize="none"
                spellCheck={false}
                autoComplete="section-company username"
                hint={
                  mode === "register"
                    ? "Уникальный служебный код: латинские строчные буквы, цифры, точка, дефис или подчёркивание."
                    : "Код, который вы создали или получили от администратора."
                }
              />
              <Field
                label="Служебный логин"
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                required
                minLength={2}
                maxLength={80}
                pattern="[a-z0-9]+(?:[._\-][a-z0-9]+)*"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                hint={
                  mode === "register"
                    ? "Например, admin. Используйте идентификатор, не ФИО или почту."
                    : undefined
                }
              />
              {(mode === "activate" || mode === "recover") && (
                <Field
                  label={
                    mode === "activate" ? "Код активации" : "Код восстановления"
                  }
                  type="password"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                  maxLength={256}
                  autoComplete="off"
                  spellCheck={false}
                />
              )}
              <PasswordField
                label={newPassword ? "Новый пароль" : "Пароль"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={newPassword ? 12 : 1}
                maxLength={128}
                autoComplete={newPassword ? "new-password" : "current-password"}
                hint={
                  newPassword
                    ? "От 12 символов. Можно использовать длинную фразу и менеджер паролей."
                    : undefined
                }
              />
              <Failure error={error} />
              <button type="submit" className="primary-button">
                {busy
                  ? "Проверяем данные…"
                  : mode === "register"
                    ? "Создать компанию и аккаунт"
                    : mode === "activate"
                      ? "Активировать доступ"
                      : mode === "recover"
                        ? "Заменить пароль и войти"
                        : "Войти"}
              </button>
            </fieldset>
          </form>
          <div className="entry-alternatives">
            {(mode === "login" || mode === "admin") && (
              <button
                className="quiet-button"
                onClick={() => navigate("activate")}
                disabled={busy}
              >
                У меня есть код активации
              </button>
            )}
            {(mode === "admin" || mode === "login") && (
              <button
                className="quiet-button"
                onClick={() => navigate("recover")}
                disabled={busy}
              >
                Восстановить доступ администратора
              </button>
            )}
            {mode === "register" && (
              <button
                className="quiet-button"
                onClick={() => navigate("admin")}
                disabled={busy}
              >
                Компания уже зарегистрирована? Войти
              </button>
            )}
          </div>
        </section>
      )}
    </main>
  );
}
