/* Screenshots of the running app, so UI work can be checked rather than guessed.

   Needs a browser once:  npx playwright install chromium
   Then, with the app running on :8000

     node screenshot.mjs ./shots
     SHOT_EMAIL=... SHOT_PASSWORD=... node screenshot.mjs ./shots

   Credentials come from the environment; the defaults are the demo clinic that
   seed_demo.py creates, which exists only in development. */

import { chromium } from "playwright";

const BASE = process.env.SHOT_BASE ?? "http://127.0.0.1:8000";
const OUT = process.argv[2] ?? "./shots";
const EMAIL = process.env.SHOT_EMAIL ?? "dr.mehta@clinic.example.com";
const PASSWORD = process.env.SHOT_PASSWORD ?? "alignerdemo123";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.fill('input[type="email"]', EMAIL);
await page.fill('input[type="password"]', PASSWORD);
await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 20000 });
await page.waitForLoadState("networkidle");

async function shot(name, path, prep) {
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
  if (prep) await prep(page);
  // Long enough for the page's entrance animation to settle.
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  console.log(`  ${name}.png`);
}

await shot("01-home", "/");
await shot("02-catalogue", "/catalogue");
await shot("03-catalogue-modal", "/catalogue", async (p) => {
  await p.locator(".product-card button.btn-primary").first().click();
  await p.waitForSelector(".modal", { timeout: 5000 });
});
await shot("04-cases", "/orders");

await browser.close();
console.log("done");
