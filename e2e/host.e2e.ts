import { expect, test } from "@playwright/test";

// WP0.6 acceptance: two tabs show each other's nodes live.
test("two tabs see each other's nodes; observe mode lends none; closing withdraws", async ({
  browser,
}) => {
  const a = await browser.newPage();
  const b = await browser.newPage();
  await a.goto("/");
  await b.goto("/");
  await expect(a.locator("#machine")).toHaveText(/live/);
  await expect(b.locator("#machine")).toHaveText(/live/);
  // Each tab spawned one node on arrival; both dashboards converge on two nodes across two hosts.
  await expect(a.locator("#counts")).toHaveText("2 nodes · 2 hosts", { timeout: 15_000 });
  await expect(b.locator("#counts")).toHaveText("2 nodes · 2 hosts");
  await expect(a.locator("#nodes tbody tr")).toHaveCount(2);
  await expect(a.locator("#mine .row")).toHaveCount(1);
  await expect(a.locator("#mine .row")).toContainText("idle");

  // Spawn one more in tab A; tab B sees three.
  await a.click("#spawn1");
  await expect(b.locator("#counts")).toHaveText("3 nodes · 2 hosts");
  await expect(a.locator("#mine .row")).toHaveCount(2);

  // Close all of A's nodes; B sees only its own.
  await a.click("#killMine");
  await expect(b.locator("#counts")).toHaveText("1 nodes · 1 hosts");
  await expect(a.locator("#mine")).toContainText("No nodes in this tab");

  // Observe-only tab lends no CPU.
  const c = await browser.newPage();
  await c.goto("/?observe");
  await expect(c.locator("#machine")).toHaveText(/live/);
  await expect(c.locator("#mine")).toContainText("Observe-only");
  await expect(c.locator("#counts")).toHaveText("1 nodes · 1 hosts");

  // Closing tab B removes its node from everyone's view.
  await b.close();
  await expect(c.locator("#counts")).toHaveText("0 nodes · 0 hosts");
  await a.close();
  await c.close();
});

test("the health route stays private and the fallback page never shows once the bundle exists", async ({
  page,
  baseURL,
}) => {
  const res = await page.request.get(`${baseURL}/health`);
  // Locally the public listener answers 404; behind CloudFront the missing key is a 403 from S3.
  expect([403, 404]).toContain(res.status());
  await page.goto("/");
  await expect(page.locator("h1")).toHaveText("TABFRAME");
});
