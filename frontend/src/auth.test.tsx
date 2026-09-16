import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthPortal } from "./AuthPortal";

const session = {
  organization: {
    id: "synthetic-company",
    name: "Учебная проверка",
    account: "test-company",
  },
  user: { id: "synthetic-admin", login: "admin", role: "admin" as const },
  demo: false,
};

function json(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("individual access portal", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        if (String(input) === "/api/auth/options")
          return json({ demo_enabled: true });
        return json(session);
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("offers three distinct paths without presenting login as registration", async () => {
    render(<AuthPortal onSuccess={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "Я администратор компании" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Войти в компанию" }),
    ).toBeVisible();
    expect(
      await screen.findByRole("button", { name: "Посмотреть демо" }),
    ).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Войти в компанию" }),
    );
    expect(
      screen.getByText(/Вход по индивидуальному доступу, не регистрация/),
    ).toBeVisible();
    expect(screen.getByLabelText("Служебный логин")).toBeVisible();
    expect(
      screen.queryByLabelText("Название компании"),
    ).not.toBeInTheDocument();
  });

  it("confirms the browser session before opening demo", async () => {
    const demoSession = { ...session, demo: true };
    vi.mocked(fetch).mockImplementation((input) =>
      String(input) === "/api/auth/options"
        ? json({ demo_enabled: true })
        : json(demoSession),
    );
    const success = vi.fn();
    render(<AuthPortal onSuccess={success} />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Посмотреть демо" }),
      ).toBeEnabled(),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Посмотреть демо" }),
    );
    await waitFor(() => expect(success).toHaveBeenCalledWith(demoSession));
    expect(
      vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/auth/me"),
    ).toBe(true);
  });

  it("does not call a successful login usable when the cookie is not retained", async () => {
    vi.mocked(fetch).mockImplementation((input) => {
      if (String(input) === "/api/auth/options")
        return json({ demo_enabled: true });
      if (String(input) === "/api/auth/me")
        return json({ detail: "authentication required" }, 401);
      return json({ ...session, demo: true });
    });
    const success = vi.fn();
    render(<AuthPortal onSuccess={success} />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Посмотреть демо" }),
      ).toBeEnabled(),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Посмотреть демо" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "браузер не подтвердил сеанс",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "не отключайте защиту cookies",
    );
    expect(success).not.toHaveBeenCalled();
  });

  it("reports non-JSON API responses without displaying their body or guessing nginx", async () => {
    vi.mocked(fetch).mockImplementation((input) =>
      String(input) === "/api/auth/options"
        ? json({ demo_enabled: true })
        : Promise.resolve(
            new Response("<html>private error details</html>", {
              status: 405,
              headers: { "Content-Type": "text/html" },
            }),
          ),
    );
    render(<AuthPortal onSuccess={vi.fn()} />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Посмотреть демо" }),
      ).toBeEnabled(),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Посмотреть демо" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "не в формате API",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("405");
    expect(document.body).not.toHaveTextContent("private error details");
  });

  it("keeps demo visible with an explicit unavailable state when disabled", async () => {
    vi.mocked(fetch).mockImplementation(() => json({ demo_enabled: false }));
    render(<AuthPortal onSuccess={vi.fn()} />);
    expect(
      await screen.findByText("Учебный парк отключён на этом сервере."),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Посмотреть демо" }),
    ).toBeDisabled();
  });

  it("registers an individual admin, shows the recovery key once and requires acknowledgement", async () => {
    const success = vi.fn();
    vi.mocked(fetch).mockImplementation((input) => {
      if (String(input) === "/api/auth/options")
        return json({ demo_enabled: true });
      if (String(input) === "/api/auth/register")
        return json({
          ...session,
          recovery_code: "synthetic-one-use-recovery-code",
        });
      return json(session);
    });
    render(<AuthPortal onSuccess={success} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Я администратор компании" }),
    );
    fireEvent.change(screen.getByLabelText("Название компании"), {
      target: { value: "Учебная проверка" },
    });
    fireEvent.change(screen.getByLabelText("Код компании"), {
      target: { value: "test-company" },
    });
    fireEvent.change(screen.getByLabelText("Служебный логин"), {
      target: { value: "admin" },
    });
    fireEvent.change(screen.getByLabelText("Новый пароль"), {
      target: { value: "synthetic-test-password" },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Создать компанию и аккаунт" }),
    );
    expect(
      await screen.findByLabelText("Код: показывается один раз"),
    ).toHaveValue("synthetic-one-use-recovery-code");
    expect(success).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Сохранил, продолжить" }),
    ).toBeDisabled();
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Код сохранён в безопасном месте" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Сохранил, продолжить" }),
    );
    await waitFor(() => expect(success).toHaveBeenCalledWith(session));
    const call = vi
      .mocked(fetch)
      .mock.calls.find(([url]) => url === "/api/auth/register");
    expect(JSON.parse(call![1]!.body as string)).toEqual({
      organization_name: "Учебная проверка",
      account: "test-company",
      login: "admin",
      password: "synthetic-test-password",
    });
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("preserves the issued recovery code when subsequent session verification fails", async () => {
    vi.mocked(fetch).mockImplementation((input) => {
      if (String(input) === "/api/auth/options")
        return json({ demo_enabled: true });
      if (String(input) === "/api/auth/me")
        return json({ detail: "authentication required" }, 401);
      return json({ ...session, recovery_code: "synthetic-recovery-retained" });
    });
    render(<AuthPortal onSuccess={vi.fn()} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Я администратор компании" }),
    );
    fireEvent.change(screen.getByLabelText("Название компании"), {
      target: { value: "Синтетическая" },
    });
    fireEvent.change(screen.getByLabelText("Код компании"), {
      target: { value: "synthetic" },
    });
    fireEvent.change(screen.getByLabelText("Служебный логин"), {
      target: { value: "admin" },
    });
    fireEvent.change(screen.getByLabelText("Новый пароль"), {
      target: { value: "synthetic-test-password" },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Создать компанию и аккаунт" }),
    );
    await screen.findByLabelText("Код: показывается один раз");
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Код сохранён в безопасном месте" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Сохранил, продолжить" }),
    );
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Код: показывается один раз")).toHaveValue(
      "synthetic-recovery-retained",
    );
  });
});
