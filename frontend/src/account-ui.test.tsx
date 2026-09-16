import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { Failure } from "./account-ui";
import { ApiError, FRONTEND_BUILD_ID } from "./api";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.history.replaceState({}, "", "/");
});

it("focuses a new error so feedback cannot remain above a long form", () => {
  const { rerender } = render(<Failure error={null} />);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  rerender(<Failure error={new Error("Ошибка действия")} />);
  expect(screen.getByRole("alert")).toHaveFocus();
});

it("shows safe support diagnostics for the failing endpoint and frontend build", async () => {
  window.history.replaceState(
    {},
    "",
    "/login?secret=synthetic-page-query#synthetic-page-fragment",
  );
  const error = new ApiError(
    429,
    "Учебный парк занят.",
    "demo_capacity_reached",
    "synthetic-request-id",
    "/api/auth/demo?secret=synthetic-api-query#synthetic-api-fragment",
  );
  render(<Failure error={error} />);
  await userEvent.click(screen.getByText("Сведения для диагностики"));
  const diagnostics = screen.getByRole("alert").querySelector("details")!;
  expect(diagnostics).toHaveTextContent("Запрос API: /api/auth/demo");
  expect(diagnostics).toHaveTextContent("Ответ API: 429");
  expect(diagnostics).toHaveTextContent(
    `Время ошибки (UTC): ${error.occurredAt}`,
  );
  expect(diagnostics).toHaveTextContent(
    `Сборка интерфейса: ${FRONTEND_BUILD_ID}`,
  );
  expect(diagnostics).toHaveTextContent(
    "Технический код: demo_capacity_reached",
  );
  expect(diagnostics).toHaveTextContent("Номер запроса: synthetic-request-id");
  expect(diagnostics).not.toHaveTextContent(/synthetic-page|synthetic-api/);
  expect(diagnostics).not.toHaveTextContent(/версия backend|версия сервера/i);
});

it("does not invent a request endpoint for a client-side error", async () => {
  render(
    <Failure
      error={new ApiError(401, "Сеанс не подтверждён.", "session_not_retained")}
    />,
  );
  await userEvent.click(screen.getByText("Сведения для диагностики"));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Запрос API: не зафиксирован",
  );
});
