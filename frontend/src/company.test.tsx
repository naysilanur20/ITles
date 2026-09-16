import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyPanel } from "./CompanyPanel";
import { SecretNotice } from "./account-ui";

const session = {
  organization: {
    id: "company-a",
    account: "company-a",
    name: "Синтетическая компания",
  },
  user: { id: "admin-a", login: "admin", role: "admin" as const },
  demo: false,
};
const machine = {
  id: "machine-a",
  name: "Харвестер 04",
  model: "Test Model",
  head: null,
  computer: null,
};
const source = {
  model: "Test Model",
  computer: "Test PC",
  software_version: "test-1",
  source_kind: "unconfigured",
  export_description: "",
  permission_confirmed: false,
};
const connection = {
  state: "added",
  last_received_at: null,
  last_observed_at: null,
  last_position_at: null,
  reviewed_at: null,
  message_count: 0,
};

function json(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("company setup and access", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function mockSetup(
    overrides?: (
      url: string,
      options?: RequestInit,
    ) => ReturnType<typeof json> | undefined,
  ) {
    vi.mocked(fetch).mockImplementation((input, options) => {
      const url = String(input);
      const override = overrides?.(url, options);
      if (override) return override;
      if (url === "/api/machines") return json({ machines: [machine] });
      if (url === "/api/admin/users")
        return json({
          users: [
            {
              ...session.user,
              status: "active",
              created_at: "2026-09-16T00:00:00Z",
            },
          ],
        });
      if (url === "/api/admin/onboarding")
        return json({
          completed: false,
          step: "source",
          machine_added: true,
          users_configured: false,
          source_configured: false,
        });
      if (url.endsWith("/source"))
        return json({ machine, source, connection, tokens: [] });
      return json({ ok: true });
    });
  }

  it("does not expose or fetch admin settings for a read-only user", async () => {
    render(
      <CompanyPanel
        session={{
          ...session,
          user: { id: "user-a", login: "viewer", role: "user" },
        }}
        onSessionEnded={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { name: "Мой доступ" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Пользователи" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Добавить машину" }),
    ).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("loads saved source settings and shows added without implying a connection", async () => {
    mockSetup();
    render(<CompanyPanel session={session} onSessionEnded={vi.fn()} />);
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Настроить источник: Харвестер 04",
      }),
    );
    expect(await screen.findByLabelText("Бортовой компьютер")).toHaveValue(
      "Test PC",
    );
    expect(screen.getByLabelText("Версия бортового ПО")).toHaveValue("test-1");
    expect(screen.getByText("Машина добавлена")).toBeVisible();
    expect(screen.getByText(/Принятых пакетов пока нет/)).toBeVisible();
    expect(screen.queryByText("Сообщение принято")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Выдать токен устройства" }),
    ).not.toBeInTheDocument();
  });

  it("persists an unsupported source without pretending an adapter exists", async () => {
    let savedSource = { ...source };
    mockSetup((url, options) => {
      if (url.endsWith("/source")) {
        if (options?.method === "PUT")
          savedSource = JSON.parse(options.body as string);
        return json({
          machine,
          source: savedSource,
          connection: { ...connection, state: "source_unconfigured" },
          tokens: [],
        });
      }
    });
    render(<CompanyPanel session={session} onSessionEnded={vi.fn()} />);
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Настроить источник: Харвестер 04",
      }),
    );
    await screen.findByLabelText("Доступный способ передачи");
    await userEvent.selectOptions(
      screen.getByLabelText("Доступный способ передачи"),
      "unsupported",
    );
    fireEvent.change(screen.getByLabelText("Экспорт, API или интерфейс"), {
      target: { value: "HPR: требуется эталонный файл" },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Сохранить описание источника" }),
    );
    expect(
      await screen.findByText("Для этого источника адаптера пока нет"),
    ).toBeVisible();
    expect(savedSource.export_description).toBe(
      "HPR: требуется эталонный файл",
    );
    expect(
      screen.queryByRole("button", { name: "Выдать токен устройства" }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Проверить поступление" }),
    );
    expect(
      await screen.findByLabelText("Экспорт, API или интерфейс"),
    ).toHaveValue("HPR: требуется эталонный файл");
  });

  it("allows revoking previously issued tokens after switching to an unsupported source", async () => {
    mockSetup((url) =>
      url.endsWith("/source")
        ? json({
            machine,
            source: { ...source, source_kind: "unsupported" },
            connection,
            tokens: [
              { id: "opaque-token-id", created_at: "2026-09-16T00:00:00Z" },
            ],
          })
        : undefined,
    );
    render(<CompanyPanel session={session} onSessionEnded={vi.fn()} />);
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Настроить источник: Харвестер 04",
      }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Отозвать токены машины" }),
    );
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([, options]) => options?.method === "DELETE"),
    ).toBe(false);
    await userEvent.click(
      screen.getByRole("button", { name: "Подтвердить отзыв токенов" }),
    );
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(
            ([url, options]) =>
              String(url).endsWith("/tokens") && options?.method === "DELETE",
          ),
      ).toBe(true),
    );
  });

  it("issues activation rather than an administrator-chosen shared password", async () => {
    mockSetup((url, options) =>
      url === "/api/admin/users" && options?.method === "POST"
        ? json({
            user: {
              id: "viewer-a",
              login: "dispatcher-01",
              role: "user",
              status: "pending",
            },
            activation_code: "synthetic-activation-code",
            expires_at: "2026-09-17T00:00:00Z",
          })
        : undefined,
    );
    render(<CompanyPanel session={session} onSessionEnded={vi.fn()} />);
    await screen.findByRole("button", {
      name: "Настроить источник: Харвестер 04",
    });
    await userEvent.click(screen.getByRole("button", { name: "Пользователи" }));
    fireEvent.change(screen.getByLabelText("Логин нового пользователя"), {
      target: { value: "dispatcher-01" },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Выдать доступ" }),
    );
    expect(
      await screen.findByLabelText("Код: показывается один раз"),
    ).toHaveValue("synthetic-activation-code");
    expect(screen.getByText(/Сотрудник задаст свой пароль/)).toBeVisible();
    const call = vi
      .mocked(fetch)
      .mock.calls.find(
        ([url, options]) =>
          url === "/api/admin/users" && options?.method === "POST",
      );
    expect(JSON.parse(call![1]!.body as string)).toEqual({
      login: "dispatcher-01",
    });
  });

  it("requires confirmation before revoking a user's access", async () => {
    mockSetup((url) =>
      url === "/api/admin/users"
        ? json({
            users: [
              {
                id: "viewer-a",
                login: "viewer",
                role: "user",
                status: "active",
                created_at: "2026-09-16T00:00:00Z",
              },
            ],
          })
        : undefined,
    );
    render(<CompanyPanel session={session} onSessionEnded={vi.fn()} />);
    await screen.findByRole("button", {
      name: "Настроить источник: Харвестер 04",
    });
    await userEvent.click(screen.getByRole("button", { name: "Пользователи" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Отозвать доступ" }),
    );
    expect(
      screen.getByRole("group", { name: "Подтверждение отзыва доступа" }),
    ).toBeVisible();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([, options]) => options?.method === "DELETE"),
    ).toBe(false);
    await userEvent.click(
      screen.getByRole("button", { name: "Подтвердить отзыв" }),
    );
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(
            ([url, options]) =>
              url === "/api/admin/users/viewer-a" &&
              options?.method === "DELETE",
          ),
      ).toBe(true),
    );
  });

  it("updates progress from source facts and invalidates confirmation on refresh", async () => {
    let messageCount = 1;
    let reviewed = false;
    mockSetup((url, options) => {
      if (url.endsWith("/review")) {
        expect(JSON.parse(options!.body as string)).toEqual({
          message_count: 2,
        });
        reviewed = true;
      } else if (!url.endsWith("/source")) return;
      return json({
        machine,
        source: {
          ...source,
          source_kind: "normalized_json",
          permission_confirmed: true,
        },
        connection: {
          ...connection,
          state: reviewed ? "message_received" : "review_required",
          message_count: messageCount,
        },
        tokens: [{ id: "test-token-id", created_at: "2026-09-16T00:00:00Z" }],
        onboarding: {
          completed: reviewed,
          step: "source",
          machine_added: true,
          users_configured: true,
          source_configured: true,
          data_received: true,
          data_reviewed: reviewed,
        },
      });
    });
    const { container } = render(
      <CompanyPanel session={session} onSessionEnded={vi.fn()} />,
    );
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Настроить источник: Харвестер 04",
      }),
    );
    const confirmation = await screen.findByRole("checkbox", {
      name: /Я сравнил время/,
    });
    expect(
      container.querySelector(".setup-progress li:nth-child(4)"),
    ).toHaveAttribute("data-complete", "true");
    expect(
      container.querySelector(".setup-progress li:nth-child(5)"),
    ).toHaveAttribute("data-complete", "false");
    await userEvent.click(confirmation);
    messageCount = 2;
    await userEvent.click(
      screen.getByRole("button", { name: "Проверить поступление" }),
    );
    expect(
      await screen.findByRole("checkbox", { name: /Я сравнил время/ }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("button", { name: "Отметить сравнение с источником" }),
    ).toBeDisabled();
    await userEvent.click(
      screen.getByRole("checkbox", { name: /Я сравнил время/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Отметить сравнение с источником" }),
    );
    expect(await screen.findByText("Сообщение принято")).toBeVisible();
    expect(
      screen.getByText(/Сравнение с источником отмечено\. Метрологическая/),
    ).toHaveFocus();
    expect(
      container.querySelectorAll('.setup-progress li[data-complete="true"]'),
    ).toHaveLength(5);
    expect(
      screen.getByRole("heading", { name: "Харвестер 04: источник данных" }),
    ).toBeVisible();
  });

  it("allows an administrator to revoke migrated shared access without reissuing it", async () => {
    let revoked = false;
    mockSetup((url, options) => {
      if (url === "/api/admin/users/legacy-a" && options?.method === "DELETE") {
        revoked = true;
        return json({ ok: true });
      }
      if (url === "/api/admin/users")
        return json({
          users: [
            {
              id: "legacy-a",
              login: "legacy",
              role: "user",
              status: revoked ? "revoked" : "active",
              legacy_access: true,
              created_at: "2026-09-16T00:00:00Z",
            },
          ],
        });
    });
    render(<CompanyPanel session={session} onSessionEnded={vi.fn()} />);
    await screen.findByRole("button", {
      name: "Настроить источник: Харвестер 04",
    });
    await userEvent.click(screen.getByRole("button", { name: "Пользователи" }));
    expect(
      screen.queryByRole("button", { name: "Выдать новый код" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Завершить сеансы" }),
    ).toBeEnabled();
    await userEvent.click(
      screen.getByRole("button", { name: "Отозвать доступ" }),
    );
    expect(revoked).toBe(false);
    await userEvent.click(
      screen.getByRole("button", { name: "Подтвердить отзыв" }),
    );
    expect(await screen.findByText("Доступ отозван")).toBeVisible();
    expect(revoked).toBe(true);
  });

  it("warns before reissuing access cancels the user's password and sessions", async () => {
    const user = {
      id: "viewer-a",
      login: "viewer",
      role: "user",
      status: "active",
      created_at: "2026-09-16T00:00:00Z",
    };
    let issued = false;
    mockSetup((url) => {
      if (url === "/api/admin/users") return json({ users: [user] });
      if (url.endsWith("/reissue")) {
        issued = true;
        return json({
          user,
          activation_code: "synthetic-new-code",
          expires_at: "2026-09-17T00:00:00Z",
        });
      }
    });
    render(<CompanyPanel session={session} onSessionEnded={vi.fn()} />);
    await screen.findByRole("button", {
      name: "Настроить источник: Харвестер 04",
    });
    await userEvent.click(screen.getByRole("button", { name: "Пользователи" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Выдать новый код" }),
    );
    expect(issued).toBe(false);
    expect(
      screen.getByText(/Прежний пароль, код активации и сеансы/),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(issued).toBe(false);
    await userEvent.click(
      screen.getByRole("button", { name: "Выдать новый код" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Подтвердить замену кода" }),
    );
    expect(
      await screen.findByLabelText("Код: показывается один раз"),
    ).toHaveValue("synthetic-new-code");
  });

  it("preserves unsaved source fields when checking reception and reloads saved fields on a new visit", async () => {
    let savedSource = { ...source };
    mockSetup((url, options) => {
      if (!url.endsWith("/source")) return;
      if (options?.method === "PUT")
        savedSource = JSON.parse(options.body as string);
      return json({ machine, source: savedSource, connection, tokens: [] });
    });
    const view = render(
      <CompanyPanel session={session} onSessionEnded={vi.fn()} />,
    );
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Настроить источник: Харвестер 04",
      }),
    );
    fireEvent.change(await screen.findByLabelText("Бортовой компьютер"), {
      target: { value: "Confirmed PC" },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Проверить поступление" }),
    );
    expect(await screen.findByLabelText("Бортовой компьютер")).toHaveValue(
      "Confirmed PC",
    );
    expect(savedSource.computer).toBe("Test PC");
    await userEvent.click(
      screen.getByRole("button", { name: "Сохранить описание источника" }),
    );
    await screen.findByText(/Описание источника сохранено/);
    view.unmount();
    render(<CompanyPanel session={session} onSessionEnded={vi.fn()} />);
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Настроить источник: Харвестер 04",
      }),
    );
    expect(await screen.findByLabelText("Бортовой компьютер")).toHaveValue(
      "Confirmed PC",
    );
  });

  it("clears comparison approval even when refreshing source facts fails", async () => {
    let failRefresh = false;
    mockSetup((url) => {
      if (!url.endsWith("/source")) return;
      return failRefresh
        ? json({ detail: "unavailable" }, 503)
        : json({
            machine,
            source: {
              ...source,
              source_kind: "normalized_json",
              permission_confirmed: true,
            },
            connection: {
              ...connection,
              state: "review_required",
              message_count: 1,
            },
            tokens: [],
          });
    });
    render(<CompanyPanel session={session} onSessionEnded={vi.fn()} />);
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Настроить источник: Харвестер 04",
      }),
    );
    await userEvent.click(
      await screen.findByRole("checkbox", { name: /Я сравнил время/ }),
    );
    failRefresh = true;
    await userEvent.click(
      screen.getByRole("button", { name: "Проверить поступление" }),
    );
    await screen.findByRole("alert");
    expect(
      screen.getByRole("checkbox", { name: /Я сравнил время/ }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("button", { name: "Отметить сравнение с источником" }),
    ).toBeDisabled();
  });

  it("requires saved source permission before offering device credentials", async () => {
    let savedSource = { ...source, source_kind: "normalized_json" };
    mockSetup((url, options) => {
      if (url.endsWith("/source")) {
        if (options?.method === "PUT")
          savedSource = JSON.parse(options.body as string);
        return json({ machine, source: savedSource, connection, tokens: [] });
      }
      if (url.endsWith("/tokens") && options?.method === "POST")
        return json({ token: "synthetic-device-token" });
    });
    render(<CompanyPanel session={session} onSessionEnded={vi.fn()} />);
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Настроить источник: Харвестер 04",
      }),
    );
    const permission = await screen.findByRole("checkbox", {
      name: /Доступ к указанному источнику разрешён/,
    });
    expect(
      screen.queryByRole("button", { name: "Выдать токен устройства" }),
    ).not.toBeInTheDocument();
    await userEvent.click(permission);
    expect(
      screen.queryByRole("button", { name: "Выдать токен устройства" }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Сохранить описание источника" }),
    );
    fireEvent.change(
      await screen.findByLabelText("Ваш пароль для выдачи токена"),
      { target: { value: "synthetic-password" } },
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Выдать токен устройства" }),
    );
    expect(await screen.findByLabelText("Токен устройства")).toHaveValue(
      "synthetic-device-token",
    );
    expect(screen.queryByText(/Активных токенов: 0/)).not.toBeInTheDocument();
  });

  it("requires saving each new one-time secret rather than inheriting the previous confirmation", async () => {
    const onDone = vi.fn();
    const view = render(
      <SecretNotice
        title="Сохраните код"
        value="synthetic-first"
        onDone={onDone}
      />,
    );
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Код сохранён в безопасном месте" }),
    );
    expect(
      screen.getByRole("button", { name: "Сохранил, продолжить" }),
    ).toBeEnabled();
    view.rerender(
      <SecretNotice
        title="Сохраните код"
        value="synthetic-replacement"
        onDone={onDone}
      />,
    );
    expect(
      screen.getByRole("checkbox", { name: "Код сохранён в безопасном месте" }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("button", { name: "Сохранил, продолжить" }),
    ).toBeDisabled();
  });
});
