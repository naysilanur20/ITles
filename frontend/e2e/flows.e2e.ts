import { randomUUID } from "node:crypto";
import {
  expect,
  test as base,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";

type Company = {
  account: string;
  password: string;
  name: string;
  context: BrowserContext;
  page: Page;
};
type Companies = { create: (ui?: boolean) => Promise<Company> };

const test = base.extend<{ companies: Companies; endOwnSession: void }>({
  endOwnSession: [
    async ({ context }, use) => {
      await use();
      expect(
        (await context.request.post("/api/auth/logout", { data: {} })).status(),
      ).toBe(200);
    },
    { auto: true },
  ],
  companies: async ({ browser, baseURL, playwright }, use) => {
    const created: Company[] = [];
    await use({
      create: async (ui = false) => {
        const account = `e2e-${randomUUID()}`;
        const context = await browser.newContext({
          baseURL,
          locale: "ru-RU",
          timezoneId: "UTC",
        });
        const company = {
          account,
          password: randomUUID(),
          name: `Синтетическая компания ${account}`,
          context,
          page: await context.newPage(),
        };
        created.push(company);
        if (ui) {
          await company.page.goto("/");
          await company.page
            .getByRole("button", {
              name: "Я администратор компании",
              exact: true,
            })
            .click();
          await company.page
            .getByLabel("Название компании", { exact: true })
            .fill(company.name);
          await company.page
            .getByLabel("Код компании", { exact: true })
            .fill(account);
          await company.page
            .getByLabel("Служебный логин", { exact: true })
            .fill("admin");
          await company.page
            .getByLabel("Новый пароль", { exact: true })
            .fill(company.password);
          await company.page
            .getByRole("button", { name: "Создать компанию и аккаунт" })
            .click();
          await expect(
            company.page.getByRole("heading", {
              name: "Сохраните код восстановления",
            }),
          ).toBeVisible();
        } else {
          const response = await context.request.post("/api/auth/register", {
            data: {
              organization_name: company.name,
              account,
              login: "admin",
              password: company.password,
            },
          });
          expect(response.status()).toBe(200);
        }
        return company;
      },
    });
    for (const company of created) {
      // Only generated companies are cleaned; never touch shared demo sessions.
      const cleanup = await playwright.request.newContext({ baseURL });
      try {
        const login = await cleanup.post("/api/auth/login", {
          data: {
            account: company.account,
            login: "admin",
            password: company.password,
          },
        });
        expect
          .soft(login.status(), "Private E2E company cleanup must authenticate")
          .toBe(200);
        if (login.ok()) {
          const machines = await json(cleanup, "/api/machines");
          for (const machine of machines.machines)
            expect
              .soft(
                (
                  await cleanup.delete(
                    `/api/admin/machines/${machine.id}/tokens`,
                  )
                ).status(),
              )
              .toBe(200);
          const users = await json(cleanup, "/api/admin/users");
          for (const user of users.users)
            if (user.role === "user")
              expect
                .soft(
                  (
                    await cleanup.delete(`/api/admin/users/${user.id}`)
                  ).status(),
                )
                .toBe(200);
          expect
            .soft(
              (
                await cleanup.post("/api/auth/logout-all", { data: {} })
              ).status(),
            )
            .toBe(200);
        }
      } finally {
        await cleanup.dispose();
        await company.context.close();
      }
    }
  },
});

async function json(api: APIRequestContext, path: string) {
  const response = await api.get(path);
  expect(response.status()).toBe(200);
  return response.json();
}

async function preserveSecret(
  page: Page,
  label = "Код: показывается один раз",
) {
  const secret = await page
    .getByRole("textbox", { name: label, exact: true })
    .inputValue();
  expect(secret.length > 20).toBe(true);
  const proceed = page.getByRole("button", {
    name: "Сохранил, продолжить",
    exact: true,
  });
  await expect(proceed).toBeDisabled();
  await page
    .getByRole("checkbox", { name: "Код сохранён в безопасном месте" })
    .check();
  await expect(proceed).toBeEnabled();
  await proceed.click();
  await expect(
    page.getByRole("textbox", { name: label, exact: true }),
  ).toHaveCount(0);
  return secret;
}

async function loginUI(
  page: Page,
  company: Company,
  login = "admin",
  password = company.password,
) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Войти в компанию", exact: true })
    .click();
  await page.getByLabel("Код компании", { exact: true }).fill(company.account);
  await page.getByLabel("Служебный логин", { exact: true }).fill(login);
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Выйти", exact: true }),
  ).toBeVisible();
}

async function companyPanel(page: Page) {
  await page.getByRole("button", { name: "Компания", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Машины и подключение", exact: true }),
  ).toBeVisible();
}

async function logoutUI(page: Page) {
  const session = (await page.context().cookies()).find(
    (cookie) => cookie.name === "itles_session",
  );
  if (!session) throw new Error("Logout must start with a session cookie");
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/auth/logout" &&
        response.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Выйти", exact: true }).click(),
  ]);
  expect(response.status()).toBe(200);
  await expect(
    page.getByRole("button", { name: "Войти в компанию", exact: true }),
  ).toBeVisible();
  // Replay the original cookie to verify server revocation, not just cookie removal.
  expect(
    (
      await page.context().request.get("/api/auth/me", {
        headers: { Cookie: `${session.name}=${session.value}` },
      })
    ).status(),
  ).toBe(401);
}

async function machineAPI(company: Company, name = "Синтетическая машина") {
  const response = await company.context.request.post("/api/admin/machines", {
    data: { name, model: "Test rig; no OEM" },
  });
  expect(response.status()).toBe(200);
  return (await response.json()).machine;
}

function batch(machineId: string, production = false) {
  const occurred_at = new Date(Date.now() - 60_000).toISOString();
  return {
    schema_version: 1,
    batch_id: randomUUID(),
    events: [
      {
        kind: "telemetry",
        event_id: randomUUID(),
        machine_id: machineId,
        occurred_at,
        measurements: [{ key: "fuel_level_pct", value: 0, unit: "%" }],
        position: { latitude: 61.2, longitude: 34.4 },
      },
      ...(production
        ? [
            {
              kind: "production",
              event_id: randomUUID(),
              machine_id: machineId,
              occurred_at,
              volume_m3: "1.25",
              basis: "under_bark",
              source: "operator_export",
              method: "manual_ledger",
              method_version: "e2e-synthetic-v1",
            },
          ]
        : []),
    ],
  };
}

async function tokenAPI(company: Company, id: string) {
  const api = company.context.request;
  expect(
    (
      await api.put(`/api/admin/machines/${id}/source`, {
        data: {
          source_kind: "normalized_json",
          permission_confirmed: true,
          model: "Synthetic rig",
          computer: "Fixture",
          software_version: "e2e-v1",
          export_description: "Generated test input, not OEM data",
        },
      })
    ).status(),
  ).toBe(200);
  const response = await api.post(`/api/admin/machines/${id}/tokens`, {
    data: { password: company.password },
  });
  expect(response.status()).toBe(200);
  return (await response.json()).token as string;
}

test("UI registration preserves recovery code, logout/login and machine/source survive reload", async ({
  companies,
}) => {
  const company = await companies.create(true);
  const { page } = company;
  await preserveSecret(page);
  await companyPanel(page);
  await expect(
    page.getByText(
      "Машин пока нет. Добавьте первую ниже, затем опишите доступный источник.",
    ),
  ).toBeVisible();
  await page
    .getByLabel("Название машины", { exact: true })
    .fill("Учебный стенд 01");
  await page
    .getByLabel("Модель машины", { exact: true })
    .fill("Synthetic model");
  await page
    .getByRole("button", { name: "Добавить машину", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Учебный стенд 01: источник данных" }),
  ).toBeVisible();
  await expect(
    page.getByText("Машина добавлена", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Бортовой компьютер", { exact: true })
    .fill("Fixture computer");
  await page.getByLabel("Версия бортового ПО", { exact: true }).fill("0.0-e2e");
  await page
    .getByLabel("Доступный способ передачи")
    .selectOption("unsupported");
  await page
    .getByLabel("Экспорт, API или интерфейс", { exact: true })
    .fill("Нет OEM-файла; нужен образец от поставщика");
  await page
    .getByRole("button", { name: "Сохранить описание источника" })
    .click();
  await expect(
    page.getByText("Источник ещё не настроен", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Для этого источника адаптера пока нет",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Выдать токен устройства", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await companyPanel(page);
  await page
    .getByRole("button", {
      name: "Настроить источник: Учебный стенд 01",
      exact: true,
    })
    .click();
  await expect(
    page.getByLabel("Бортовой компьютер", { exact: true }),
  ).toHaveValue("Fixture computer");
  await expect(
    page.getByLabel("Версия бортового ПО", { exact: true }),
  ).toHaveValue("0.0-e2e");
  await expect(page.getByLabel("Доступный способ передачи")).toHaveValue(
    "unsupported",
  );
  let releaseLogout!: () => void;
  const logoutGate = new Promise<void>((resolve) => {
    releaseLogout = resolve;
  });
  const logoutRequested = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === "/api/auth/logout" &&
      request.method() === "POST",
  );
  await page.route(
    "**/api/auth/logout",
    async (route) => {
      await logoutGate;
      await route.continue();
    },
    { times: 1 },
  );
  const loggingOut = logoutUI(page);
  try {
    await logoutRequested;
    await expect(
      page.getByRole("button", { name: "Выйти", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Войти в компанию", exact: true }),
    ).toHaveCount(0);
    expect((await company.context.request.get("/api/auth/me")).status()).toBe(
      200,
    );
  } finally {
    releaseLogout();
    await loggingOut;
  }
  expect((await company.context.request.get("/api/auth/me")).status()).toBe(
    401,
  );
  await loginUI(page, company);
  await companyPanel(page);
  await expect(
    page.getByRole("button", {
      name: "Настроить источник: Учебный стенд 01",
      exact: true,
    }),
  ).toBeVisible();
});

test("UI invitation activates read-only access; session termination and revocation are enforced by API", async ({
  companies,
  browser,
  baseURL,
}) => {
  const company = await companies.create();
  await machineAPI(company);
  const { page } = company;
  await page.goto("/");
  await companyPanel(page);
  await page.getByRole("button", { name: "Пользователи", exact: true }).click();
  await page.getByLabel("Логин нового пользователя").fill("dispatcher-e2e");
  await page
    .getByRole("button", { name: "Выдать доступ", exact: true })
    .click();
  const code = await preserveSecret(page);
  const employee = await browser.newContext({ baseURL });
  try {
    const employeePage = await employee.newPage();
    const password = randomUUID();
    await employeePage.goto("/");
    await employeePage
      .getByRole("button", { name: "Войти в компанию", exact: true })
      .click();
    await employeePage
      .getByRole("button", { name: "У меня есть код активации" })
      .click();
    await employeePage
      .getByLabel("Код компании", { exact: true })
      .fill(company.account);
    await employeePage
      .getByLabel("Служебный логин", { exact: true })
      .fill("dispatcher-e2e");
    await employeePage.getByLabel("Код активации", { exact: true }).fill(code);
    await employeePage
      .getByLabel("Новый пароль", { exact: true })
      .fill(password);
    await employeePage
      .getByRole("button", { name: "Активировать доступ", exact: true })
      .click();
    await expect(
      employeePage.getByRole("button", { name: "Выйти", exact: true }),
    ).toBeVisible();
    await expect(
      employeePage.getByRole("button", { name: "Компания", exact: true }),
    ).toHaveCount(0);
    expect((await json(employee.request, "/api/auth/me")).user.role).toBe(
      "user",
    );
    expect(
      (await json(employee.request, "/api/machines")).machines,
    ).toHaveLength(1);
    expect((await employee.request.get("/api/admin/users")).status()).toBe(403);
    expect(
      (
        await employee.request.post("/api/admin/machines", {
          data: { name: "Forbidden machine" },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await employee.request.post("/api/admin/users", {
          data: { login: "forbidden" },
        })
      ).status(),
    ).toBe(403);
    const row = page
      .getByRole("listitem")
      .filter({ has: page.getByText("dispatcher-e2e", { exact: true }) });
    await row
      .getByRole("button", { name: "Завершить сеансы", exact: true })
      .click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Сеансы dispatcher-e2e завершены" }),
    ).toBeVisible();
    expect((await employee.request.get("/api/auth/me")).status()).toBe(401);
    await loginUI(employeePage, company, "dispatcher-e2e", password);
    await row
      .getByRole("button", { name: "Отозвать доступ", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Подтвердить отзыв", exact: true })
      .click();
    await expect(
      page.getByText("Доступ отозван", { exact: true }),
    ).toBeVisible();
    expect((await employee.request.get("/api/auth/me")).status()).toBe(401);
    expect(
      (
        await employee.request.post("/api/auth/login", {
          data: { account: company.account, login: "dispatcher-e2e", password },
        })
      ).status(),
    ).toBe(401);
    await employeePage.reload();
    await expect(
      employeePage.getByRole("button", {
        name: "Войти в компанию",
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    await employee.close();
  }
});

test("source token receives a real synthetic HTTP batch, keeps zero and requires explicit review", async ({
  companies,
  playwright,
  baseURL,
}) => {
  const company = await companies.create();
  const machine = await machineAPI(company);
  const { page } = company;
  await page.goto("/");
  await companyPanel(page);
  await page
    .getByRole("button", {
      name: `Настроить источник: ${machine.name}`,
      exact: true,
    })
    .click();
  await page
    .getByLabel("Доступный способ передачи")
    .selectOption("normalized_json");
  await page
    .getByRole("checkbox", {
      name: "Доступ к указанному источнику разрешён владельцем техники",
    })
    .check();
  await page
    .getByRole("button", { name: "Сохранить описание источника" })
    .click();
  await expect(
    page.getByText("Источник ещё не настроен", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Ваш пароль для выдачи токена", { exact: true })
    .fill(company.password);
  await page
    .getByRole("button", { name: "Выдать токен устройства", exact: true })
    .click();
  const token = await preserveSecret(page, "Токен устройства");
  await expect(
    page.getByText("Ожидается первое сообщение", { exact: true }),
  ).toBeVisible();
  const device = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
  try {
    expect((await device.get("/api/machines")).status()).toBe(401);
    const payload = batch(machine.id, true);
    const ingested = await device.post("/api/ingest", { data: payload });
    expect(ingested.status()).toBe(200);
    expect(await ingested.json()).toMatchObject({
      accepted: 2,
      duplicates: 0,
      rejected: 0,
    });
    await page
      .getByRole("button", { name: "Проверить поступление", exact: true })
      .click();
    await expect(
      page.getByText("Данные требуют проверки", { exact: true }),
    ).toBeVisible();
    const detail = await json(
      company.context.request,
      `/api/machines/${machine.id}`,
    );
    expect(
      detail.metrics.find(
        (metric: { key: string }) => metric.key === "fuel_level_pct",
      ).value,
    ).toBe(0);
    expect(detail.position.latitude).toBe(61.2);
    const review = page.getByRole("button", {
      name: "Отметить сравнение с источником",
      exact: true,
    });
    await expect(review).toBeDisabled();
    await page
      .getByRole("checkbox", { name: /Я сравнил время, единицы и значения/ })
      .check();
    await review.click();
    await expect(
      page.getByText("Сообщение принято", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Открыть показания машины", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: machine.name, exact: true }),
    ).toBeVisible();
    const fuel = page.locator(".metric").filter({ hasText: "Уровень топлива" });
    await expect.soft(fuel.locator("strong")).toHaveText("0%");
    await page.getByRole("button", { name: "Обновить", exact: true }).click();
    await expect(fuel.locator("strong")).toHaveText("0%");
    await companyPanel(page);
    await page
      .getByRole("button", {
        name: `Настроить источник: ${machine.name}`,
        exact: true,
      })
      .click();
    await page
      .getByLabel("Ваш пароль для выдачи токена", { exact: true })
      .fill(company.password);
    await page
      .getByRole("button", { name: "Заменить токен устройства", exact: true })
      .click();
    const replacement = await preserveSecret(page, "Токен устройства");
    expect(replacement === token).toBe(false);
    expect(
      (await device.post("/api/ingest", { data: batch(machine.id) })).status(),
    ).toBe(401);
    const replay = await device.post("/api/ingest", {
      headers: { Authorization: `Bearer ${replacement}` },
      data: payload,
    });
    expect(replay.status()).toBe(200);
    expect(await replay.json()).toMatchObject({
      accepted: 0,
      duplicates: 2,
      rejected: 0,
    });
    await page
      .getByRole("button", { name: "Отозвать токены машины", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Подтвердить отзыв токенов", exact: true })
      .click();
    await expect(
      page.getByText("Активных токенов: 0.", { exact: false }),
    ).toBeVisible();
    expect(
      (
        await device.post("/api/ingest", {
          headers: { Authorization: `Bearer ${replacement}` },
          data: batch(machine.id),
        })
      ).status(),
    ).toBe(401);
  } finally {
    await device.dispose();
  }
});

test("two private companies cannot read or mutate each other's IDs, event journal or CSV", async ({
  companies,
  playwright,
  baseURL,
}) => {
  const a = await companies.create();
  const b = await companies.create();
  const ma = await machineAPI(a, "Private machine A");
  const mb = await machineAPI(b, "Private machine B");
  const tokenA = await tokenAPI(a, ma.id);
  const tokenB = await tokenAPI(b, mb.id);
  const device = await playwright.request.newContext({ baseURL });
  try {
    for (const [machine, token] of [
      [ma, tokenA],
      [mb, tokenB],
    ] as const) {
      expect(
        (
          await device.post("/api/ingest", {
            headers: { Authorization: `Bearer ${token}` },
            data: batch(machine.id, true),
          })
        ).status(),
      ).toBe(200);
    }
    expect(
      (
        await device.post("/api/ingest", {
          headers: { Authorization: `Bearer ${tokenA}` },
          data: batch(mb.id),
        })
      ).status(),
    ).toBe(403);
    for (const [company, own, other, otherCompany] of [
      [a, ma, mb, b],
      [b, mb, ma, a],
    ] as const) {
      const api = company.context.request;
      expect(
        (await json(api, "/api/machines")).machines.map(
          (m: { id: string }) => m.id,
        ),
      ).toEqual([own.id]);
      expect(
        (await json(api, "/api/fleet")).machines.map(
          (m: { id: string }) => m.id,
        ),
      ).toEqual([own.id]);
      expect((await api.get(`/api/machines/${other.id}`)).status()).toBe(404);
      expect(
        (await api.get(`/api/admin/machines/${other.id}/source`)).status(),
      ).toBe(404);
      expect(
        (
          await api.put(`/api/admin/machines/${other.id}/source`, {
            data: { source_kind: "unsupported", permission_confirmed: false },
          })
        ).status(),
      ).toBe(404);
      expect(
        (
          await api.post(`/api/admin/machines/${other.id}/tokens`, {
            data: { password: company.password },
          })
        ).status(),
      ).toBe(404);
      expect(
        (await api.delete(`/api/admin/machines/${other.id}/tokens`)).status(),
      ).toBe(404);
      expect(
        (
          await api.post(`/api/admin/machines/${other.id}/review`, {
            data: { message_count: 2 },
          })
        ).status(),
      ).toBe(404);
      const otherAdmin = (
        await json(otherCompany.context.request, "/api/auth/me")
      ).user.id;
      expect(
        (await api.delete(`/api/admin/users/${otherAdmin}`)).status(),
      ).toBe(404);
      const ledger = await api.get("/api/exports/ledger.csv");
      expect(ledger.status()).toBe(200);
      expect(ledger.headers()["content-type"]).toContain("text/csv");
      const csv = await ledger.text();
      expect(csv).toContain(own.id);
      expect(csv).not.toContain(other.id);
      expect(csv).toContain("e2e-synthetic-v1");
      const ownDetail = await json(api, `/api/machines/${own.id}`);
      expect(ownDetail.production).toHaveLength(1);
      expect(ownDetail.production[0].method_version).toBe("e2e-synthetic-v1");
      expect(JSON.stringify(await json(api, "/api/quality"))).not.toContain(
        other.id,
      );
    }
  } finally {
    await device.dispose();
  }
});

test("demo clean entry and reentry, fixed dates, map, empty/invalid periods and CSV download", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Посмотреть демо", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Выйти", exact: true }),
  ).toBeVisible();
  expect((await json(context.request, "/api/auth/me")).demo).toBe(true);
  await expect(page.getByText(/Вымышленные/).first()).toBeVisible();
  const start = page.getByLabel("Дата начала периода", { exact: true });
  const end = page.getByLabel("Дата окончания периода", { exact: true });
  await expect(start).toHaveValue("2026-09-14");
  await expect(end).toHaveValue("2026-09-15");
  await page.getByRole("button", { name: "Карта", exact: true }).click();
  await expect(
    page.getByLabel("Карта последних известных координат", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Выработка", exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("link", { name: "Скачать журнал CSV", exact: true })
    .click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("itles-ledger.csv");
  const stream = await download.createReadStream();
  const parts: Buffer[] = [];
  for await (const part of stream!) parts.push(part);
  const csv = Buffer.concat(parts).toString("utf8");
  expect(csv).toContain("method_version");
  expect(csv.split("\n").length).toBeGreaterThan(2);
  await end.fill("2026-09-13");
  await expect(
    page.getByRole("alert").filter({ hasText: /дата окончания/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Скачать журнал CSV", exact: true }),
  ).toHaveCount(0);
  expect(
    (
      await context.request.get("/api/fleet?start=2026-09-14&end=2026-09-13")
    ).status(),
  ).toBe(422);
  await start.fill("2020-01-01");
  await end.fill("2020-01-02");
  await expect(
    page.getByText(/За выбранный период событий выработки нет/),
  ).toBeVisible();
  await logoutUI(page);
  expect((await context.request.get("/api/auth/me")).status()).toBe(401);
  await page
    .getByRole("button", { name: "Посмотреть демо", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Выйти", exact: true }),
  ).toBeVisible();
  expect((await json(context.request, "/api/auth/me")).demo).toBe(true);
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Получаем журнал и состояние машин" }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const menu = page.getByRole("button", { name: "Открыть меню", exact: true });
  await menu.focus();
  await page.keyboard.press("Enter");
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(menu).toBeFocused();
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await menu.click();
  await logoutUI(page);
});

test("disabled demo and unavailable API are labelled honestly; mobile keyboard/focus smoke", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.route("**/api/auth/options", (route) =>
    route.fulfill({
      json: { demo_enabled: false, registration_enabled: true },
    }),
  );
  await page.goto("/");
  await expect(
    page.getByText("Учебный парк отключён на этом сервере.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Посмотреть демо", exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const admin = page.getByRole("button", {
    name: "Я администратор компании",
    exact: true,
  });
  await admin.focus();
  await expect(admin).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Создать компанию", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    page.getByLabel("Название компании", { exact: true }),
  ).toBeFocused();
  const focus = await page
    .getByLabel("Название компании", { exact: true })
    .evaluate((node) => {
      const style = getComputedStyle(node);
      return (
        (style.outlineStyle !== "none" &&
          Number.parseFloat(style.outlineWidth) > 0) ||
        style.boxShadow !== "none"
      );
    });
  expect(focus).toBe(true);
  await page.unroute("**/api/auth/options");
  await page.route("**/api/auth/options", (route) => route.abort("failed"));
  await page.goto("/");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Проверить доступность снова" }),
  ).toBeVisible();
  await expect(
    page.getByText("Учебный парк отключён на этом сервере.", { exact: true }),
  ).toHaveCount(0);
});

test("demo API failure displays actionable diagnostics and permits an honest retry", async ({
  page,
}) => {
  await page.route("**/api/auth/options", (route) =>
    route.fulfill({ json: { demo_enabled: true, registration_enabled: true } }),
  );
  await page.route("**/api/auth/demo", (route) =>
    route.fulfill({
      status: 405,
      contentType: "text/html",
      body: "<!doctype html><h1>Method Not Allowed</h1>",
    }),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Посмотреть демо", exact: true })
    .click();
  const error = page.getByRole("alert");
  await expect(error).toBeVisible();
  await expect(error).toBeFocused();
  await error.getByText("Сведения для диагностики", { exact: true }).click();
  await expect(error).toContainText("Запрос API: /api/auth/demo");
  await expect(error).toContainText("Ответ API: 405");
  await expect(error).toContainText(new URL(page.url()).origin);
  await expect(error).toContainText("Сборка интерфейса:");
  await expect(error).not.toContainText("Method Not Allowed");
  await page.unroute("**/api/auth/demo");
  await page.route("**/api/auth/demo", (route) =>
    route.fulfill({ status: 404, json: { detail: "demo is disabled" } }),
  );
  await page
    .getByRole("button", { name: "Посмотреть демо", exact: true })
    .click();
  await expect(error).toContainText("Учебный парк отключён на этом сервере.");
});
