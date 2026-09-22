import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";

import { chromium } from "@playwright/test";

const packageName = "space.taskyon.constellation";
const sdk = process.env.ANDROID_HOME;
if (!sdk) throw new Error("ANDROID_HOME is required.");
const adbPath = `${sdk}/platform-tools/adb`;
const adbEnvironment = { ...process.env };
delete adbEnvironment.ADB_SERVER_SOCKET;

const adb = (args) => execFileSync(adbPath, args, {
  encoding: "utf8",
  env: adbEnvironment,
  stdio: ["ignore", "pipe", "pipe"],
});
const wait = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

const waitFor = async (check, label, timeout = 60_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await wait(250);
  }
  throw new Error(`Timed out waiting for ${label}.`);
};

const startWebServer = async () => {
  const child = spawn("yarn", ["dev", "--host", "127.0.0.1", "--port", "4173"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "ignore",
  });
  await waitFor(async () => {
    try {
      return (await fetch("http://127.0.0.1:4173/")).ok;
    } catch {
      return false;
    }
  }, "the local Constellation server");
  return child;
};

const waitForCdpPage = async (port) => {
  let selected;
  await waitFor(async () => {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      selected = pages.find((candidate) => candidate.type === "page");
      return Boolean(selected?.webSocketDebuggerUrl);
    } catch {
      return false;
    }
  }, "the Android WebView debug page", 30_000);
  return selected;
};

const connectCdp = async () => {
  const pid = adb(["shell", "pidof", packageName]).trim().split(/\s+/)[0];
  if (!pid) throw new Error("Constellation is not running on Android.");
  const port = 9222;
  adb(["forward", `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`]);
  const page = await waitForCdpPage(port);
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(String(data));
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  return createCdpClient(socket, pending, () => ++nextId);
};

const createCdpClient = (socket, pending, nextId) => ({
  evaluate: (expression) => new Promise((resolve, reject) => {
    const id = nextId();
    pending.set(id, {
      resolve: (response) => {
        if (response.exceptionDetails) reject(new Error(response.exceptionDetails.text));
        else resolve(response.result.value);
      },
      reject,
    });
    socket.send(JSON.stringify({
      id,
      method: "Runtime.evaluate",
      params: { expression, awaitPromise: true, returnByValue: true, userGesture: true },
    }));
  }),
  close: () => socket.close(),
});

const clickButton = (cdp, label) => cdp.evaluate(`(() => {
  const button = [...document.querySelectorAll("button")]
    .find((candidate) => candidate.textContent?.includes(${JSON.stringify(label)}));
  if (!button) return false;
  button.click();
  return true;
})()`);

const androidTextIncludes = (cdp, text) => cdp.evaluate(
  `document.body?.innerText?.includes(${JSON.stringify(text)}) === true`,
);

const describeInvitationAddresses = (shareUrl) => {
  const fragment = new URL(shareUrl).hash.slice("#share=".length);
  const capability = JSON.parse(Buffer.from(fragment, "base64url").toString("utf8"));
  return capability.addresses.map((address) =>
    address.replaceAll(/\/p2p\/[^/]+/g, "/p2p/<peer>"),
  );
};

const runShareFlow = async (cdp, browser) => {
  assert.equal(await clickButton(cdp, "Share location"), true);
  assert.equal(await clickButton(cdp, "Create private link"), true);
  let shareUrl;
  await waitFor(async () => {
    shareUrl = await cdp.evaluate(
      'document.querySelector("input[aria-label=\\"Share link\\"]")?.value',
    );
    return typeof shareUrl === "string" && shareUrl.includes("#share=");
  }, "the Android share link", 30_000);
  adb(["emu", "geo", "fix", "-70.0001", "40.0001"]);
  await wait(1_000);

  const viewer = await browser.newPage();
  const invitation = new URL(shareUrl);
  await viewer.goto(`http://127.0.0.1:4173/${invitation.hash}`);
  await viewer.getByRole("button", { name: "View location" }).click();
  try {
    await viewer.getByText("Viewing a shared location").waitFor({ timeout: 30_000 });
  } catch (error) {
    const browserState = {
      p2pOnline: await viewer.getByText("P2P online").isVisible(),
      invitationVisible: await viewer
        .getByText("Someone shared their location with you")
        .isVisible(),
      locationVisible: await viewer
        .getByText("Viewing a shared location")
        .isVisible(),
    };
    const androidState = {
      p2pOnline: await androidTextIncludes(cdp, "P2P online"),
      activeShare: await androidTextIncludes(cdp, "1 active share"),
      connectedViewer: await androidTextIncludes(cdp, "1 connected"),
    };
    throw new Error(
      `No location reached the browser. Address forms: ${JSON.stringify(describeInvitationAddresses(shareUrl))}; Browser state: ${JSON.stringify(browserState)}; Android state: ${JSON.stringify(androidState)}`,
      { cause: error },
    );
  }
  await waitFor(() => androidTextIncludes(cdp, "1 connected"), "Android viewer presence", 30_000);
  assert.equal(await clickButton(cdp, "Stop sharing"), true);
  await viewer.getByText("Location sharing ended.").waitFor({ timeout: 15_000 });
  await viewer.close();
};

const main = async () => {
  assert.equal(adb(["devices"]).split("\n").filter((line) => /\sdevice$/.test(line)).length, 1);
  let server;
  let cdp;
  let browser;
  try {
    adb(["emu", "geo", "fix", "-70.0000", "40.0000"]);
    adb(["shell", "pm", "grant", packageName, "android.permission.ACCESS_FINE_LOCATION"]);
    adb(["shell", "am", "force-stop", packageName]);
    adb(["shell", "am", "start", "-n", `${packageName}/.MainActivity`]);
    server = await startWebServer();
    cdp = await connectCdp();
    browser = await chromium.launch();
    await runShareFlow(cdp, browser);
    console.log("Android-to-browser P2P location sharing passed.");
  } finally {
    await browser?.close();
    cdp?.close();
    server?.kill("SIGTERM");
    adb(["shell", "am", "force-stop", packageName]);
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
