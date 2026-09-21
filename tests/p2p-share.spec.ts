import { expect, test } from "@playwright/test";

import { parseShareInvitation } from "../src/sharing/shareLink.ts";

test("shares a browser location over an authenticated P2P stream", async ({
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(60_000);
  test.skip(testInfo.project.name !== "desktop");
  if (!baseURL) throw new Error("The test requires a configured base URL.");

  const sourceContext = await browser.newContext({
    baseURL,
    geolocation: { latitude: 48.1372, longitude: 11.5756 },
    permissions: ["geolocation"],
  });
  const viewerContext = await browser.newContext({ baseURL });
  const source = await sourceContext.newPage();
  const viewer = await viewerContext.newPage();

  try {
    await source.goto("/");
    await expect.poll(() => source.evaluate(() => new Promise<boolean>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        () => resolve(true),
        () => resolve(false),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 5_000 },
      );
    }))).toBe(true);
    await source.getByRole("button", { name: "Share location" }).click();
    await source.getByRole("button", { name: "Create private link" }).click();
    const shareUrl = await source.getByLabel("Share link").inputValue({
      timeout: 30_000,
    });
    const capability = parseShareInvitation(shareUrl);
    expect(capability.addresses.length).toBeGreaterThan(0);
    expect(capability.addresses.length).toBeLessThanOrEqual(4);
    expect(
      capability.addresses.every((address) =>
        address.startsWith("/dns4/relay.taskyon.space/"),
      ),
    ).toBe(true);
    await sourceContext.setGeolocation({ latitude: 48.1373, longitude: 11.5757 });
    await expect(source.getByText("1 active share")).toBeVisible({
      timeout: 15_000,
    });

    await viewer.goto(shareUrl);
    await expect(viewer.getByText("Someone shared their location with you")).toBeVisible();
    await viewer.getByRole("button", { name: "View location" }).click();

    await expect(viewer.getByText("Viewing a shared location")).toBeVisible({
      timeout: 30_000,
    });
    await expect(source.getByText("1 connected")).toBeVisible({ timeout: 30_000 });
    await source.getByRole("button", { name: "Stop sharing" }).click();
    await expect(viewer.getByText("Location sharing ended.")).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await viewerContext.close();
    await sourceContext.close();
  }
});
