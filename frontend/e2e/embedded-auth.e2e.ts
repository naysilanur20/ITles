import { expect, test, type Page } from "@playwright/test";

async function embeddedApp(page: Page, baseURL: string) {
  const parent = new URL("/embedded-preview-test", baseURL);
  parent.hostname =
    new URL(baseURL).hostname === "localhost" ? "127.0.0.1" : "localhost";
  // A route-fulfilled parent needs permission to load the private loopback app.
  await page
    .context()
    .grantPermissions(["local-network-access"], { origin: parent.origin });
  await page.route(parent.href, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<iframe title="ИТлес Preview" src="${baseURL}/" style="width:100%;height:900px"></iframe>`,
    }),
  );
  await page.goto(parent.href);
  return page.frameLocator("iframe");
}

test("cross-site embedding cannot retain the Strict session cookie", async ({
  page,
  context,
  baseURL,
}) => {
  const app = await embeddedApp(page, baseURL!);
  await expect(
    app.getByRole("heading", { name: "Мониторинг харвестеров" }),
  ).toBeVisible();
  const frame = page.frames().find((frame) => frame.url() === `${baseURL}/`)!;
  const statuses = await frame.evaluate(async () => {
    const login = await fetch("/api/auth/demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      credentials: "same-origin",
    });
    const me = await fetch("/api/auth/me", { credentials: "same-origin" });
    return [login.status, me.status];
  });
  expect(statuses).toEqual([200, 401]);
  expect(
    (await context.cookies()).some((cookie) => cookie.name === "itles_session"),
  ).toBe(false);
});

test("embedded entry opens a standalone tab before any authentication mutation", async ({
  page,
  context,
  baseURL,
}) => {
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/auth/")) {
      mutations.push(request.url());
    }
  });
  const app = await embeddedApp(page, baseURL!);
  await expect(
    app.getByText("Ключ и регистрация для демо не нужны."),
  ).toBeVisible();
  await expect(
    app.getByRole("button", { name: "Посмотреть демо", exact: true }),
  ).toHaveCount(0);
  const newTab = context.waitForEvent("page");
  await app
    .getByRole("link", { name: "Открыть ИТлес в новой вкладке" })
    .click();
  const standalone = await newTab;
  await standalone.waitForLoadState();
  expect(new URL(standalone.url()).origin).toBe(new URL(baseURL!).origin);
  expect(await standalone.evaluate(() => window.opener === null)).toBe(true);
  await standalone
    .getByRole("button", { name: "Посмотреть демо", exact: true })
    .click();
  await expect(
    standalone.getByRole("heading", { name: "Парк", exact: true }),
  ).toBeVisible();
  expect((await standalone.request.get("/api/auth/me")).status()).toBe(200);
  await standalone.reload();
  await expect(
    standalone.getByRole("heading", { name: "Парк", exact: true }),
  ).toBeVisible();
  expect(mutations).toEqual([]);
  const logout = standalone.waitForResponse(
    (response) =>
      response.url().endsWith("/api/auth/logout") &&
      response.request().method() === "POST",
  );
  await standalone.getByRole("button", { name: "Выйти", exact: true }).click();
  expect((await logout).status()).toBe(200);
  await expect(
    standalone.getByRole("button", { name: "Посмотреть демо", exact: true }),
  ).toBeVisible();
  expect((await standalone.request.get("/api/auth/me")).status()).toBe(401);
});
