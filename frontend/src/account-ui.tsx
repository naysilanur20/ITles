import {
  useId,
  useEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { ApiError, errorMessage, FRONTEND_BUILD_ID } from "./api";

export function Field({
  label,
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  const id = useId();
  return (
    <div className="account-field">
      <label htmlFor={id}>{label}</label>
      <input
        {...props}
        id={id}
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </div>
  );
}

export function PasswordField({
  label = "Пароль",
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label?: string; hint?: string }) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  return (
    <div className="account-field">
      <label htmlFor={id}>{label}</label>
      <div className="password-control">
        <input
          {...props}
          id={id}
          type={visible ? "text" : "password"}
          aria-describedby={hint ? `${id}-hint` : undefined}
        />
        <button
          type="button"
          className="quiet-button"
          aria-controls={id}
          aria-pressed={visible}
          onClick={() => setVisible(!visible)}
        >
          {visible ? "Скрыть" : "Показать"}
          <span className="sr-only"> {label.toLowerCase()}</span>
        </button>
      </div>
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </div>
  );
}

export function Failure({ error }: { error: unknown }) {
  const message = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) message.current?.focus();
  }, [error]);
  if (!error) return null;
  return (
    <div className="account-error" role="alert" tabIndex={-1} ref={message}>
      <p>{typeof error === "string" ? error : errorMessage(error)}</p>
      {error instanceof ApiError && (
        <details>
          <summary>Сведения для диагностики</summary>
          <p>
            Адрес: {window.location.origin}
            {window.location.pathname}
            <br />
            Запрос API: {error.endpoint ?? "не зафиксирован"}
            <br />
            Ответ API: {error.status || "нет завершённого ответа (0)"}
            <br />
            Время ошибки (UTC): {error.occurredAt}
            <br />
            Сборка интерфейса: {FRONTEND_BUILD_ID}
            {FRONTEND_BUILD_ID === "unknown" && " (не определена при сборке)"}
            <br />
            Технический код: {error.code ?? "не зафиксирован"}
            {error.requestId && (
              <>
                <br />
                Номер запроса: {error.requestId}
              </>
            )}
          </p>
          <p>Не передавайте пароль, код восстановления или токен устройства.</p>
        </details>
      )}
    </div>
  );
}

export function SecretNotice({
  title,
  value,
  children,
  onDone,
  doneLabel = "Сохранил, продолжить",
  busy = false,
  secretLabel = "Код: показывается один раз",
}: {
  title: string;
  value: string;
  children?: ReactNode;
  onDone: () => void;
  doneLabel?: string;
  busy?: boolean;
  secretLabel?: string;
}) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    setSaved(false);
    setCopied(false);
    setCopyError("");
    heading.current?.focus();
  }, [value]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setCopyError("");
    } catch {
      setCopyError(
        "Буфер обмена недоступен. Выделите код и скопируйте его вручную.",
      );
    }
  }
  return (
    <section className="secret-notice" aria-label={title}>
      <h2 ref={heading} tabIndex={-1}>
        {title}
      </h2>
      {children}
      <p>
        Код показывается один раз. Сохраните его в защищённом хранилище,
        отдельно от пароля. Не включайте в снимки экрана и переписку.
      </p>
      <label className="account-field">
        <span>{secretLabel}</span>
        <textarea
          value={value}
          readOnly
          rows={2}
          spellCheck={false}
          data-private="true"
        />
      </label>
      <button
        type="button"
        className="secondary-button"
        onClick={() => void copy()}
      >
        {copied ? "Скопировано" : "Скопировать код"}
      </button>
      {copyError && <p role="status">{copyError}</p>}
      <label className="check-field">
        <input
          type="checkbox"
          checked={saved}
          onChange={(e) => setSaved(e.target.checked)}
        />
        Код сохранён в безопасном месте
      </label>
      <button
        type="button"
        className="primary-button"
        disabled={!saved || busy}
        onClick={onDone}
      >
        {busy ? "Проверяем сеанс…" : doneLabel}
      </button>
    </section>
  );
}
