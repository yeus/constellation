import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'

import { chromium } from '@playwright/test'
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys'

import { browserProcessEnvironment } from './browser-environment.mjs'
import { redactAndroidTestError } from './android-test-privacy.mjs'

const packageName = 'space.taskyon.constellation'
const sdk = process.env.ANDROID_HOME
if (!sdk) throw new Error('ANDROID_HOME is required.')
const adbPath = `${sdk}/platform-tools/adb`
const adbEnvironment = { ...process.env }
delete adbEnvironment.ADB_SERVER_SOCKET

const adbFor = (serial, args) =>
  execFileSync(adbPath, [...(serial ? ['-s', serial] : []), ...args], {
    encoding: 'utf8',
    env: adbEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
const adb = (args) => adbFor(process.env.ANDROID_SERIAL, args)
const backgroundRuntimeCreations = (serial) =>
  adbFor(serial, ['logcat', '-d', '-s', 'ConstellationRuntime:I', '*:S'])
    .split('\n')
    .filter((line) => line.includes('background-runtime-created')).length
const grantIfSupported = (permission) => {
  try {
    adb(['shell', 'pm', 'grant', packageName, permission])
  } catch {
    // Android versions before the permission was introduced reject the grant.
  }
}
const wait = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })

const waitFor = async (check, label, timeout = 60_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await wait(250)
  }
  throw new Error(`Timed out waiting for ${label}.`)
}

const startWebServer = async (mode = 'dev') => {
  const command =
    mode === 'preview'
      ? ['preview', '--outDir', 'dist-tauri', '--host', '127.0.0.1', '--port', '4173']
      : ['dev', '--host', '127.0.0.1', '--port', '4173']
  const child = spawn('yarn', command, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'ignore',
  })
  await waitFor(async () => {
    try {
      return (await fetch('http://127.0.0.1:4173/')).ok
    } catch {
      return false
    }
  }, 'the local Constellation server')
  return child
}

const startLocalRelay = async () => {
  const child = spawn(process.execPath, ['scripts/e2e-relay.mjs'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'ignore',
  })
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error('The local P2P relay exited before startup.')
    try {
      return (await fetch('http://127.0.0.1:9113/health')).ok
    } catch {
      return false
    }
  }, 'the local P2P relay')
  return child
}

const waitForCdpPage = async (port) => {
  let selected
  await waitFor(
    async () => {
      try {
        const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
        const candidate = pages.find((page) => page.type === 'page' && /^https?:/.test(page.url))
        if (!candidate?.webSocketDebuggerUrl) return false
        await wait(500)
        const nextPages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
        selected = nextPages.find((page) => page.id === candidate.id && page.url === candidate.url)
        return Boolean(selected?.webSocketDebuggerUrl)
      } catch {
        return false
      }
    },
    'the Android WebView debug page',
    30_000,
  )
  return selected
}

const connectCdp = async (serial = process.env.ANDROID_SERIAL, port = 9222) => {
  let pid
  await waitFor(
    () => {
      try {
        pid = adbFor(serial, ['shell', 'pidof', packageName]).trim().split(/\s+/)[0]
        return Boolean(pid)
      } catch {
        return false
      }
    },
    'the Android app process',
    30_000,
  )
  adbFor(serial, ['forward', `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`])
  const page = await waitForCdpPage(port)
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  const pending = new Map()
  const persistenceTrace = []
  const ipcTrace = []
  let nextId = 0
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(String(data))
    if (message.method === 'Runtime.consoleAPICalled') {
      for (const argument of message.params?.args ?? []) {
        const marker = argument.value
        if (
          typeof marker === 'string' &&
          /^\[constellation-persist\] (follow-save-queued|native-save-start|native-save-complete)$/.test(
            marker,
          )
        ) {
          persistenceTrace.push(marker.slice('[constellation-persist] '.length))
          if (persistenceTrace.length > 32) persistenceTrace.shift()
        }
        if (marker === '[constellation-ipc] native-save-eval-received') {
          ipcTrace.push('native-save-eval-received')
          if (ipcTrace.length > 32) ipcTrace.shift()
        }
        const frameworkMarker =
          typeof marker === 'string'
            ? marker.match(
                /^\[constellation-tauri\] (callback-(?:eval-(?:entered|returned|threw)|known-(?:true|false)))$/,
              )?.[1]
            : undefined
        if (frameworkMarker) {
          ipcTrace.push(frameworkMarker)
          if (ipcTrace.length > 32) ipcTrace.shift()
        }
        if (typeof marker === 'string' && marker.startsWith("[TAURI] Couldn't find callback id")) {
          ipcTrace.push('callback-not-found')
          if (ipcTrace.length > 32) ipcTrace.shift()
        }
      }
    }
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.error) request.reject(new Error(message.error.message))
    else request.resolve(message.result)
  })
  socket.addEventListener('close', () => {
    for (const request of pending.values()) {
      request.reject(new Error('Android WebView debugger disconnected.'))
    }
    pending.clear()
  })
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  socket.send(JSON.stringify({ id: ++nextId, method: 'Runtime.enable' }))
  return createCdpClient(
    socket,
    pending,
    () => ++nextId,
    () => [...persistenceTrace],
    () => [...ipcTrace],
  )
}

const startWithSharedText = (shareUrl, serial = process.env.ANDROID_SERIAL) => {
  try {
    return adbFor(serial, [
      'shell',
      'am',
      'start',
      '-n',
      `${packageName}/.MainActivity`,
      '-a',
      'android.intent.action.SEND',
      '-t',
      'text/plain',
      '--es',
      'android.intent.extra.TEXT',
      shareUrl,
    ])
  } catch {
    throw new Error('Android could not receive the synthetic share invitation.')
  }
}

const createCdpClient = (socket, pending, nextId, persistenceTrace, ipcTrace) => {
  const command = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId()
      const timeout = setTimeout(() => {
        pending.delete(id)
        reject(new Error('Android WebView debugger did not answer within 30 seconds.'))
      }, 30_000)
      pending.set(id, {
        resolve: (response) => {
          clearTimeout(timeout)
          resolve(response)
        },
        reject: (error) => {
          clearTimeout(timeout)
          reject(error)
        },
      })
      try {
        socket.send(
          JSON.stringify({
            id,
            method,
            params,
          }),
        )
      } catch (error) {
        pending.get(id)?.reject(error)
        pending.delete(id)
      }
    })
  return {
    persistenceTrace,
    ipcTrace,
    evaluate: async (expression) => {
      const response = await command('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      })
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.text)
      return response.result.value
    },
    tap: async (x, y) => {
      await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
      await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    },
    close: () => socket.close(),
  }
}

const clickButton = (cdp, label) =>
  cdp.evaluate(`(() => {
  const button = [...document.querySelectorAll("button")]
    .find((candidate) => candidate.textContent?.includes(${JSON.stringify(label)}));
  if (!button) return false;
  button.click();
  return true;
})()`)

const tapAndroidButton = async (cdp, label) => {
  const center = await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(label)});
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  })()`)
  if (!center) return false
  await cdp.tap(center.x, center.y)
  return true
}

const clickAriaButton = (cdp, label) =>
  cdp.evaluate(`(() => {
    const button = document.querySelector('button[aria-label=${JSON.stringify(label)}]');
    if (!button) return false;
    button.click();
    return true;
  })()`)

const androidTextIncludes = (cdp, text) =>
  cdp.evaluate(`document.body?.innerText?.includes(${JSON.stringify(text)}) === true`)

const receivedUpdateCount = async (viewer) => {
  const text = await viewer.getByText(/Updates this session:/).innerText()
  return Number(text.match(/Updates this session:\s*(\d+)/)?.[1] ?? 0)
}

const androidButtonCount = (cdp, label) =>
  cdp.evaluate(`([...document.querySelectorAll('button')]
    .filter((button) => button.textContent?.trim() === ${JSON.stringify(label)})).length`)

const fillAndroidInput = (cdp, label, value) =>
  cdp.evaluate(`(() => {
    const input = document.querySelector('input[aria-label=${JSON.stringify(label)}]');
    if (!input) return false;
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)

const closeAndroidDialog = (cdp) =>
  cdp.evaluate(`(() => {
    const button = document.querySelector('[role="dialog"] button[aria-label="Close"]');
    if (!button) return false;
    button.click();
    return true;
  })()`)

const readAndroidShareLink = async (cdp) => {
  let url
  await waitFor(
    async () => {
      url = await cdp.evaluate(
        'document.querySelector("input[aria-label=\\"Share link\\"]")?.value',
      )
      return typeof url === 'string' && url.includes('#share=')
    },
    'the Android share link',
    90_000,
  )
  return url
}

const createAndroidStarShare = async (cdp, name) => {
  if (!(await androidTextIncludes(cdp, 'Share location'))) {
    assert.equal(await clickAriaButton(cdp, 'Show sharing actions'), true)
  }
  assert.equal(await clickButton(cdp, 'Share location'), true)
  assert.equal(await fillAndroidInput(cdp, 'Share a name', name), true)
  assert.equal(await clickButton(cdp, 'In background'), true)
  assert.equal(await clickButton(cdp, '10'), true)
  assert.equal(
    await cdp.evaluate(`([...document.querySelectorAll('button')].some((button) =>
      button.textContent?.trim() === '10' && button.getAttribute('aria-pressed') === 'true'))`),
    true,
    'select ten Star viewers on Android',
  )
  assert.equal(await clickButton(cdp, 'Create private link'), true)
  let url
  try {
    url = await readAndroidShareLink(cdp)
  } catch (error) {
    const state = await cdp.evaluate(`(() => ({
      online: document.body?.innerText?.includes('P2P online') === true,
      shareDialog: Boolean(document.querySelector('[aria-labelledby="share-title"]')),
      connecting: document.body?.innerText?.includes('Connecting to the P2P network') === true,
      unreachable: document.body?.innerText?.includes('No reachable P2P address') === true,
      locationDenied: document.body?.innerText?.includes('Location permission denied') === true,
      locationWaiting: document.body?.innerText?.includes('Waiting for your location') === true,
      backgroundStarting: document.body?.innerText?.includes('Starting private P2P sharing') === true,
    }))()`)
    throw new Error(`Android Star link unavailable: ${JSON.stringify(state)}`, { cause: error })
  }
  assert.equal(await closeAndroidDialog(cdp), true)
  return url
}

const followOnAndroid = async (
  cdp,
  serial,
  url,
  expectedCount,
  method = 'shared-text',
  save = true,
) => {
  if (method === 'paste') {
    assert.equal(await clickAriaButton(cdp, 'Open menu'), true, 'open Android link menu')
    assert.equal(await clickButton(cdp, 'Follow a link'), true, 'open Android paste dialog')
    assert.equal(
      await fillAndroidInput(cdp, 'Paste location link', url),
      true,
      'fill Android pasted link',
    )
    assert.equal(await clickButton(cdp, 'View location'), true, 'submit Android pasted link')
  } else {
    startWithSharedText(url, serial)
  }
  try {
    await waitFor(
      () => androidTextIncludes(cdp, 'Someone shared their location with you'),
      'the Android invitation approval',
    )
  } catch (error) {
    const state = await cdp.evaluate(`(() => ({
      online: document.body?.innerText?.includes('P2P online') === true,
      following: document.body?.innerText?.includes('Seeing 1') === true,
      followDialog: Boolean(document.querySelector('[aria-labelledby="follow-title"]')),
      nicknamePrompt: Boolean(document.querySelector('[aria-label="Keep following"]')),
      invalidLink: document.body?.innerText?.includes('not a valid location link') === true,
      invitationPending: document.body?.innerText?.includes('Someone shared their location with you') === true,
    }))()`)
    throw new Error(`Android invitation did not appear: ${JSON.stringify(state)}`, { cause: error })
  }
  assert.equal(await clickButton(cdp, 'View location'), true, 'approve Android link')
  try {
    await waitFor(
      () => androidTextIncludes(cdp, `Seeing ${expectedCount}`),
      'the Android follow',
      120_000,
    )
  } catch (error) {
    const state = await cdp.evaluate(`(() => ({
      online: document.body?.innerText?.includes('P2P online') === true,
      connecting: document.body?.innerText?.includes('Connecting…') === true,
      invitation: document.body?.innerText?.includes('Someone shared their location with you') === true,
      noAddress: document.body?.innerText?.includes('No share address was reachable') === true,
      invalidLink: document.body?.innerText?.includes('invalid or expired') === true,
      connectionError: document.body?.innerText?.includes('Connection error') === true,
    }))()`)
    throw new Error(`Android follow did not connect: ${JSON.stringify(state)}`, {
      cause: error,
    })
  }
  try {
    await waitFor(
      () => androidTextIncludes(cdp, 'Save location'),
      'Android nickname prompt',
      10_000,
    )
  } catch {
    const state = await cdp.evaluate(`(() => ({
      protectedStorageUnavailable: document.body?.innerText?.includes('Protected storage is unavailable') === true,
      previewOnly: document.body?.innerText?.includes('preview only') === true,
      saved: document.body?.innerText?.includes('Saved') === true,
    }))()`)
    throw new Error(`Android nickname prompt absent: ${JSON.stringify(state)}`)
  }
  if (!save) {
    assert.equal(
      await cdp.evaluate(`(() => {
        const dialog = document.querySelector('[aria-label="Keep following"]');
        const backdrop = dialog?.parentElement;
        if (!backdrop?.classList.contains('sheet-backdrop')) return false;
        backdrop.click();
        return true;
      })()`),
      true,
      'dismiss nickname dialog while keeping the temporary preview',
    )
    return false
  }
  assert.equal(
    await tapAndroidButton(cdp, 'Save location'),
    true,
    'save Android location nickname with a touch',
  )
  try {
    await waitFor(
      () => androidTextIncludes(cdp, 'Not now'),
      'the optional Android share-back prompt',
      15_000,
    )
  } catch (error) {
    const state = await cdp.evaluate(`(() => ({
      nicknamePrompt: Boolean(document.querySelector('[aria-label="Keep following"]')),
      shareBackPrompt: Boolean(document.querySelector('[aria-label="Share back invitation"]')),
      protectedStorageUnavailable: document.body?.innerText?.includes('Protected storage is unavailable') === true,
      saveFailed: document.body?.innerText?.includes('Could not save this location') === true,
      protectedSaveFailed: document.body?.innerText?.includes('Protected location state could not be saved') === true,
      storageTooLarge: document.body?.innerText?.includes('too large') === true,
      saved: document.body?.innerText?.includes('Saved') === true,
      connected: document.body?.innerText?.includes('Connected') === true,
      seeingTwo: document.body?.innerText?.includes('Seeing 2') === true,
      visibility: document.visibilityState,
      focused: document.hasFocus(),
      ipcPresent: typeof window.__TAURI_INTERNALS__?.ipc === 'function',
      pendingCallbacks: window.__TAURI_INTERNALS__?.callbacks?.size ?? -1,
    }))()`)
    const nativeTrace = adbFor(serial, ['logcat', '-d', '-s', 'ConstellationPersist:I', '*:S'])
      .split('\n')
      .map((line) => line.match(/native-save-(?:invoked|committed|resolved|failed)/)?.[0])
      .filter(Boolean)
      .slice(-32)
    const evalTrace = adbFor(serial, ['logcat', '-d', '-t', '3000'])
      .split('\n')
      .map((line) => line.match(/constellation-ipc-eval-(?:accepted|failed|missing-window)/)?.[0])
      .filter(Boolean)
      .slice(-32)
    const commandTrace = adbFor(serial, ['logcat', '-d', '-t', '3000'])
      .split('\n')
      .map((line) => line.match(/constellation-ipc-save-(?:entered|plugin-returned)/)?.[0])
      .filter(Boolean)
      .slice(-32)
    const frameworkTrace = adbFor(serial, ['logcat', '-d', '-t', '3000'])
      .split('\n')
      .map(
        (line) =>
          line.match(
            /constellation-tauri-(?:request-received|responder-entered|response-formatted-(?:true|false)|response-eval-accepted-(?:true|false))/,
          )?.[0],
      )
      .filter(Boolean)
      .slice(-32)
    const statusSizes = adbFor(serial, ['logcat', '-d', '-t', '3000'])
      .split('\n')
      .map((line) => Number(line.match(/constellation-ipc-status-bytes-(\d+)/)?.[1]))
      .filter((size) => Number.isFinite(size) && size > 0)
      .slice(-16)
    const bridge = await cdp.evaluate(`(async () => {
      const invoke = window.__TAURI_INTERNALS__?.invoke;
      if (!invoke) return { status: 'unavailable', savedFollows: 'unavailable' };
      const probe = (command) => Promise.race([
        invoke(command).then((value) => ({ outcome: 'returned', value }), () => ({ outcome: 'error' })),
        new Promise((resolve) => setTimeout(() => resolve({ outcome: 'timeout' }), 3_000)),
      ]);
      const status = await probe('android_background_share_status');
      const stored = await probe('android_load_private_state');
      let savedFollows = stored.outcome;
      if (stored.outcome === 'returned') {
        try { savedFollows = JSON.parse(stored.value.state).followed.length; }
        catch { savedFollows = 'invalid'; }
      }
      return { status: status.outcome, savedFollows };
    })()`)
    const directIpc = await cdp.evaluate(`(async () => {
      const api = window.__TAURI_INTERNALS__;
      if (!api?.postMessage || !api?.transformCallback) return { outcome: 'unavailable' };
      let callback;
      let error;
      const response = new Promise((resolve) => {
        callback = api.transformCallback(() => resolve('returned'), true);
        error = api.transformCallback(() => resolve('error'), true);
        api.postMessage({
          cmd: 'android_background_share_status',
          callback,
          error,
          payload: {},
          options: {},
        });
      });
      const outcome = await Promise.race([
        response,
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 3000)),
      ]);
      const registered = api.callbacks.has(callback);
      if (outcome === 'timeout' && registered) api.runCallback(callback, {});
      api.unregisterCallback(error);
      return { outcome, callbackRegistered: registered, callbackRunnable: !api.callbacks.has(callback) };
    })()`)
    throw new Error(
      `Android share-back prompt absent after saving: ${JSON.stringify(state)}; JS save trace: ${JSON.stringify(cdp.persistenceTrace())}; Kotlin save trace: ${JSON.stringify(nativeTrace)}; Rust command trace: ${JSON.stringify(commandTrace)}; framework trace: ${JSON.stringify(frameworkTrace)}; Rust eval trace: ${JSON.stringify(evalTrace)}; WebView eval trace: ${JSON.stringify(cdp.ipcTrace())}; status response bytes: ${JSON.stringify(statusSizes)}; invoke probe: ${JSON.stringify(bridge)}; direct IPC probe: ${JSON.stringify(directIpc)}`,
      {
        cause: error,
      },
    )
  }
  await waitFor(
    () => cdp.ipcTrace().length >= expectedCount,
    'Rust-to-WebView diagnostic echo after Android save',
    10_000,
  )
  assert.equal(await clickButton(cdp, 'Not now'), true, 'dismiss the Android share-back prompt')
  return true
}

const createBrowserStarShare = async (page, name) => {
  if (!(await page.getByRole('button', { name: 'Share location' }).isVisible())) {
    await page.getByRole('button', { name: 'Show sharing actions' }).click()
  }
  await page.getByRole('button', { name: 'Share location' }).click()
  await page.getByRole('textbox', { name: 'Share a name' }).fill(name)
  await page.getByRole('dialog').getByRole('button', { name: '10', exact: true }).click()
  await page.getByRole('button', { name: 'Create private link' }).click()
  const url = await page.getByLabel('Share link').inputValue()
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
  return url
}

const followInBrowser = async (page, url, expectedCount) => {
  await page.getByRole('button', { name: 'Open menu' }).click()
  await page.getByRole('button', { name: 'Follow a link' }).click()
  await page.getByLabel('Paste location link').fill(url)
  await page.getByRole('dialog').getByRole('button', { name: 'View location' }).click()
  await page.getByRole('button', { name: 'Keep following' }).waitFor({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Keep following' }).click()
  await page.getByRole('button', { name: 'Save location' }).click()
  await page.getByRole('button', { name: 'Not now' }).click()
  await page.getByRole('button', { name: `Seeing ${expectedCount}` }).waitFor()
}

const verifyAndroidTwoLocations = async (cdp, label) => {
  assert.equal(await clickButton(cdp, 'Seeing 2'), true)
  await waitFor(
    async () => (await androidButtonCount(cdp, 'Show on map')) === 2,
    'both received locations on Android',
    75_000,
  )
  assert.equal(await closeAndroidDialog(cdp), true)
  assert.equal(await clickButton(cdp, 'Sharing 1'), true)
  try {
    await waitFor(
      () => androidTextIncludes(cdp, '2 connected'),
      'two viewers of the Android share',
      75_000,
    )
  } catch (error) {
    const state = await cdp.evaluate(`(() => ({
      shareDialog: Boolean(document.querySelector('[aria-labelledby="shares-title"]')),
      zeroViewers: document.body?.innerText?.includes('0 connected') === true,
      oneViewer: document.body?.innerText?.includes('1 connected') === true,
      twoViewers: document.body?.innerText?.includes('2 connected') === true,
      online: document.body?.innerText?.includes('P2P online') === true,
    }))()`)
    throw new Error(`${label} viewer presence did not reach two: ${JSON.stringify(state)}`, {
      cause: error,
    })
  }
  assert.equal(await closeAndroidDialog(cdp), true)
}

const sourceHasViewerCount = async (cdp, count) => {
  assert.equal(await clickButton(cdp, 'Sharing 1'), true)
  try {
    await waitFor(
      () => androidTextIncludes(cdp, `${count} connected`),
      'source viewer count',
      10_000,
    )
    return true
  } catch {
    return false
  } finally {
    await closeAndroidDialog(cdp)
  }
}

const currentSourceViewerCount = async (cdp) => {
  assert.equal(await clickButton(cdp, 'Sharing 1'), true)
  const count = await cdp.evaluate(`(() => {
    const text = document.querySelector('.share-list-item span')?.textContent ?? '';
    return Number(text.match(/(\\d+) connected/)?.[1] ?? -1);
  })()`)
  assert.equal(await closeAndroidDialog(cdp), true)
  return count
}

const androidFollowStatus = async (cdp, name) => {
  assert.equal(await clickButton(cdp, 'Seeing 2'), true)
  const status = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('.follow-item')]
      .find((candidate) => candidate.querySelector('strong')?.textContent?.trim() === ${JSON.stringify(name)});
    const text = row?.innerText ?? '';
    return {
      found: Boolean(row),
      connected: text.includes('Connected ·'),
      stale: text.includes('Stale / disconnected'),
      saved: text.includes('Saved'),
    };
  })()`)
  assert.equal(await closeAndroidDialog(cdp), true)
  return status
}

const browserFollowStatus = async (page, name) => {
  await page.getByRole('button', { name: 'Seeing 2' }).click()
  const row = page.locator('.follow-item').filter({ hasText: name })
  const text = (await row.count()) === 1 ? await row.innerText() : ''
  await page
    .getByRole('dialog', { name: 'Following' })
    .getByRole('button', { name: 'Close' })
    .click()
  return {
    found: Boolean(text),
    connected: text.includes('Connected ·'),
    stale: text.includes('Stale / disconnected'),
    saved: text.includes('Saved'),
  }
}

const sourceConnectionRoles = async (cdp) => {
  assert.equal(await closeAndroidDialog(cdp), true)
  assert.equal(await clickAriaButton(cdp, 'Open menu'), true)
  assert.equal(await clickButton(cdp, 'P2P diagnostics'), true)
  const roles = await cdp.evaluate(`(() => {
    const dialog = document.querySelector('[aria-labelledby="network-title"]');
    const heading = [...(dialog?.querySelectorAll('h3') ?? [])]
      .find((node) => node.textContent?.startsWith('Android background peer'));
    const list = heading?.nextElementSibling?.nextElementSibling;
    if (list?.tagName !== 'UL') return [];
    return [...list.querySelectorAll('li')].map((item) => {
      const label = item.textContent?.trim() ?? '';
      if (label.startsWith('viewer')) return 'viewer';
      if (label.startsWith('source')) return 'source';
      return 'other';
    });
  })()`)
  assert.equal(await closeAndroidDialog(cdp), true)
  assert.equal(await clickButton(cdp, 'Sharing 1'), true)
  return roles
}

const sourceSessionEvents = async (cdp) => {
  assert.equal(await closeAndroidDialog(cdp), true)
  assert.equal(await clickAriaButton(cdp, 'Open menu'), true)
  assert.equal(await clickButton(cdp, 'P2P diagnostics'), true)
  const events = await cdp.evaluate(`(() => {
    const dialog = document.querySelector('[aria-labelledby="network-title"]');
    return [...(dialog?.querySelectorAll('p') ?? [])]
      .filter((item) => /Recent (background )?sessions:/.test(item.textContent ?? ''))
      .map((item) => item.textContent?.replace(/\\s+/g, ' ').trim() ?? '');
  })()`)
  assert.equal(await closeAndroidDialog(cdp), true)
  assert.equal(await clickButton(cdp, 'Sharing 1'), true)
  return events
}

const sourceNativeStatus = async (cdp) =>
  await cdp.evaluate(`(async () => {
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (!invoke) return { outcome: 'unavailable' };
    return await Promise.race([
      invoke('android_background_share_status').then((status) => ({
        outcome: 'returned',
        viewerCount: status.shares?.reduce((sum, share) => sum + share.viewerCount, 0) ?? -1,
        events: status.diagnostics?.sessionEvents?.slice(-8).map((event) => event.event) ?? [],
      }), () => ({ outcome: 'error' })),
      new Promise((resolve) => setTimeout(() => resolve({ outcome: 'timeout' }), 3_000)),
    ]);
  })()`)

const browserStopEffect = async (page, cdp, name) => {
  await page.getByRole('button', { name: 'Seeing 2' }).click()
  await page
    .locator('.follow-item')
    .filter({ hasText: name })
    .getByRole('button', { name: 'Stop following' })
    .click()
  await wait(5_000)
  return {
    zeroViewers: await androidTextIncludes(cdp, '0 connected'),
    oneViewer: await androidTextIncludes(cdp, '1 connected'),
  }
}

const probeAndroidBrowserFanout = async (browser, source, url) => {
  const context = await browser.newContext()
  try {
    const viewer = await context.newPage()
    try {
      await viewer.goto(`http://127.0.0.1:4173/${new URL(url).hash}`, {
        waitUntil: 'domcontentloaded',
        timeout: 90_000,
      })
    } catch {
      throw new Error('Temporary browser viewer could not open the local share preview.')
    }
    await viewer.getByRole('button', { name: 'Keep following' }).waitFor({ timeout: 30_000 })
    assert.equal(
      await sourceHasViewerCount(source, 2),
      true,
      'Android source should admit two browser viewers',
    )
    await wait(12_000)
    assert.equal(await currentSourceViewerCount(source), 2, 'both browser viewers stay connected')
    await wait(33_000)
    assert.equal(
      await currentSourceViewerCount(source),
      2,
      'both browser viewers survive the Android source heartbeat timeout',
    )
  } finally {
    await context.close()
  }
  assert.equal(await sourceHasViewerCount(source, 1), true, 'temporary browser viewer leaves')
}

const notificationViewerCounts = (serial) => {
  try {
    return [
      ...adbFor(serial, ['shell', 'dumpsys', 'notification']).matchAll(
        /(\d+) connected across 1 links/g,
      ),
    ]
      .map((match) => Number(match[1]))
      .slice(-5)
  } catch {
    return []
  }
}

const verifyAndroidPeerPresence = async (source, serial, label, name, other, desktop) => {
  try {
    await verifyAndroidTwoLocations(source, label)
  } catch (error) {
    const browserState = await browserFollowStatus(desktop, name).catch(() => ({
      unavailable: true,
    }))
    const otherPhoneState = await androidFollowStatus(other, name).catch(() => ({
      unavailable: true,
    }))
    const sourceRoles = await sourceConnectionRoles(source).catch(() => ['unavailable'])
    const sessionEvents = await sourceSessionEvents(source).catch(() => 'unavailable')
    const nativeStatus = await sourceNativeStatus(source).catch(() => ({ outcome: 'unavailable' }))
    const notificationCounts = notificationViewerCounts(serial)
    const browserStop = await browserStopEffect(desktop, source, name).catch(() => ({
      unavailable: true,
    }))
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; browser viewer: ${JSON.stringify(browserState)}; other phone viewer: ${JSON.stringify(otherPhoneState)}; source roles: ${JSON.stringify(sourceRoles)}; source session events: ${sessionEvents}; native status: ${JSON.stringify(nativeStatus)}; notification viewer counts: ${JSON.stringify(notificationCounts)}; after browser stops: ${JSON.stringify(browserStop)}`,
      { cause: error },
    )
  }
}

const runThreeWayFlow = async (firstSerial, secondSerial) => {
  let server
  let relay
  let browser
  let first
  let second
  try {
    relay = await startLocalRelay()
    server = await startWebServer('preview')
    for (const [serial, longitude] of [
      [firstSerial, '-70.0001'],
      [secondSerial, '-70.1001'],
    ]) {
      adbFor(serial, ['logcat', '-c'])
      adbFor(serial, ['reverse', 'tcp:9111', 'tcp:9111'])
      adbFor(serial, ['emu', 'geo', 'fix', longitude, '40.0001'])
      for (const permission of [
        'android.permission.ACCESS_FINE_LOCATION',
        'android.permission.ACCESS_BACKGROUND_LOCATION',
        'android.permission.POST_NOTIFICATIONS',
      ]) {
        try {
          adbFor(serial, ['shell', 'pm', 'grant', packageName, permission])
        } catch {
          // Android versions without the permission reject the grant.
        }
      }
      adbFor(serial, ['shell', 'am', 'start', '-n', `${packageName}/.MainActivity`])
    }
    first = await connectCdp(firstSerial, 9222)
    second = await connectCdp(secondSerial, 9223)
    browser = await chromium.launch({ env: browserProcessEnvironment(process.env) })
    const context = await browser.newContext({
      geolocation: { latitude: 40.2001, longitude: -70.2001 },
      permissions: ['geolocation'],
    })
    const desktop = await context.newPage()
    await desktop.goto('http://127.0.0.1:4173/', {
      waitUntil: 'domcontentloaded',
      timeout: 90_000,
    })
    await desktop.getByRole('button', { name: 'Share location' }).waitFor({ timeout: 90_000 })
    console.log('Three-way peers started.')

    const firstLink = await createAndroidStarShare(first, 'Synthetic phone A')
    console.log('First Android link ready.')
    const secondLink = await createAndroidStarShare(second, 'Synthetic phone B')
    console.log('Second Android link ready.')
    for (const serial of [firstSerial, secondSerial]) {
      assert.equal(backgroundRuntimeCreations(serial), 1, 'one Android background P2P runtime')
    }
    const desktopLink = await createBrowserStarShare(desktop, 'Synthetic desktop')
    console.log('Desktop link ready.')

    await followInBrowser(desktop, firstLink, 1)
    await followInBrowser(desktop, secondLink, 2)
    console.log('Desktop peer accepted two links.')
    await wait(1_500)
    console.log(
      `Android source counts after desktop follows: ${await currentSourceViewerCount(first)}, ${await currentSourceViewerCount(second)}`,
    )
    if (process.argv.includes('--probe-browser-fanout')) {
      await probeAndroidBrowserFanout(browser, first, firstLink)
      console.log('Android source held two browser viewers and released the temporary viewer.')
    }
    assert.equal(await followOnAndroid(first, firstSerial, desktopLink, 1), true)
    console.log('First Android peer accepted the desktop link.')
    assert.equal(await followOnAndroid(second, secondSerial, desktopLink, 1), true)
    console.log('Second Android peer accepted the desktop link.')
    console.log('Both Android peers accepted the desktop link.')
    await wait(1_500)
    console.log(
      `Android source counts after return follows: ${await currentSourceViewerCount(first)}, ${await currentSourceViewerCount(second)}`,
    )
    const previewSecondLinks = process.argv.includes('--preview-second-link')
    const firstSavedSecond = await followOnAndroid(
      first,
      firstSerial,
      secondLink,
      2,
      'paste',
      !previewSecondLinks,
    )
    console.log('First Android peer accepted the other Android link.')
    console.log(
      `Second Android source briefly had two viewers: ${await sourceHasViewerCount(second, 2)}`,
    )
    const secondSavedFirst = await followOnAndroid(
      second,
      secondSerial,
      firstLink,
      2,
      'paste',
      !previewSecondLinks,
    )
    console.log('Second Android peer accepted the other Android link.')
    console.log(
      `First Android source briefly had two viewers: ${await sourceHasViewerCount(first, 2)}`,
    )
    console.log('Both Android peers accepted the other Android link.')
    for (const serial of [firstSerial, secondSerial]) {
      assert.equal(backgroundRuntimeCreations(serial), 1, 'background peer was not duplicated')
    }
    if (!previewSecondLinks) {
      assert.equal(firstSavedSecond, true, 'first Android nickname confirmation')
      assert.equal(secondSavedFirst, true, 'second Android nickname confirmation')
    }

    await verifyAndroidPeerPresence(
      first,
      firstSerial,
      'First Android',
      'Synthetic phone A',
      second,
      desktop,
    )
    console.log('First Android peer received both locations and saw two viewers.')
    await verifyAndroidPeerPresence(
      second,
      secondSerial,
      'Second Android',
      'Synthetic phone B',
      first,
      desktop,
    )
    console.log('Second Android peer received both locations and saw two viewers.')
    await desktop.getByRole('button', { name: 'Seeing 2' }).click()
    await desktop
      .getByRole('dialog', { name: 'Following' })
      .getByRole('button', { name: 'Show on map' })
      .first()
      .waitFor({ timeout: 75_000 })
    await waitFor(
      async () =>
        (await desktop
          .getByRole('dialog', { name: 'Following' })
          .getByRole('button', { name: 'Show on map' })
          .count()) === 2,
      'both received locations on desktop',
      75_000,
    )
    await desktop
      .getByRole('dialog', { name: 'Following' })
      .getByRole('button', { name: 'Close' })
      .click()
    await desktop.getByRole('button', { name: 'Sharing 1' }).click()
    await desktop
      .getByRole('dialog', { name: 'Active shares' })
      .getByText('2 connected')
      .waitFor({ timeout: 75_000 })
    console.log('Two Android peers and a desktop browser exchanged all three Star shares.')
  } finally {
    first?.close()
    second?.close()
    await browser?.close()
    server?.kill('SIGTERM')
    relay?.kill('SIGTERM')
    for (const serial of [firstSerial, secondSerial]) {
      try {
        adbFor(serial, ['shell', 'am', 'force-stop', packageName])
        adbFor(serial, ['reverse', '--remove', 'tcp:9111'])
      } catch {
        // Managed emulators may already be stopping after a failed test.
      }
    }
  }
}

const describeInvitationAddresses = (shareUrl) => {
  const fragment = new URL(shareUrl).hash.slice('#share='.length)
  const capability = JSON.parse(Buffer.from(fragment, 'base64url').toString('utf8'))
  return capability.addresses.map((address) => address.replaceAll(/\/p2p\/[^/]+/g, '/p2p/<peer>'))
}

const runShareFlow = async (cdp, browser) => {
  console.log('[android-test] creating background share')
  assert.equal(await clickButton(cdp, 'Share location'), true)
  assert.equal(await clickButton(cdp, 'In background'), true)
  assert.equal(await clickButton(cdp, 'Create private link'), true)
  let shareUrl
  try {
    await waitFor(
      async () => {
        shareUrl = await cdp.evaluate(
          'document.querySelector("input[aria-label=\\"Share link\\"]")?.value',
        )
        return typeof shareUrl === 'string' && shareUrl.includes('#share=')
      },
      'the Android share link',
      30_000,
    )
  } catch (error) {
    const state = await cdp.evaluate(`(() => ({
      backgroundSelected: [...document.querySelectorAll('button')]
        .some((button) => button.textContent?.includes('In background') && button.getAttribute('aria-pressed') === 'true'),
      shareDialogVisible: Boolean(document.querySelector('[aria-labelledby="share-title"]')),
      connecting: document.body?.innerText?.includes('Connecting to the P2P network') === true,
      noReachablePeer: document.body?.innerText?.includes('No reachable P2P address') === true,
      permissionDenied: document.body?.innerText?.includes('Location permission denied') === true,
      backgroundStarting: document.body?.innerText?.includes('Starting private P2P sharing') === true,
    }))()`)
    throw new Error(`Android share link unavailable. UI state: ${JSON.stringify(state)}`, {
      cause: error,
    })
  }
  adb(['emu', 'geo', 'fix', '-70.0001', '40.0001'])
  await wait(1_000)
  adb(['shell', 'input', 'keyevent', 'KEYCODE_HOME'])
  console.log('[android-test] waiting for browser viewer')
  await waitFor(
    async () =>
      adb(['shell', 'dumpsys', 'activity', 'services', packageName]).includes(
        'LocationShareService',
      ),
    'the Android foreground location service',
  )

  const viewerContext = await browser.newContext({
    geolocation: { latitude: 40.0002, longitude: -70.0002 },
    permissions: ['geolocation'],
  })
  const viewer = await viewerContext.newPage()
  const invitation = new URL(shareUrl)
  await viewer.goto(`http://127.0.0.1:4173/${invitation.hash}`, {
    waitUntil: 'domcontentloaded',
    timeout: 90_000,
  })
  try {
    await viewer.getByRole('button', { name: 'Keep following' }).waitFor({ timeout: 30_000 })
    await viewer.getByRole('button', { name: 'Open menu' }).click()
    await viewer.getByRole('button', { name: 'Following (1)' }).click()
    await viewer.getByRole('button', { name: 'Show on map' }).waitFor({ timeout: 30_000 })
  } catch (error) {
    const browserState = {
      p2pOnline: await viewer.getByText('P2P online').isVisible(),
      invitationVisible: await viewer
        .getByText('Someone shared their location with you')
        .isVisible(),
      previewVisible: await viewer.getByRole('button', { name: 'Keep following' }).isVisible(),
      locationVisible: await viewer.getByRole('button', { name: 'Show on map' }).isVisible(),
    }
    const androidState = {
      p2pOnline: await androidTextIncludes(cdp, 'P2P online'),
      activeShare: await androidTextIncludes(cdp, '1 active share'),
      connectedViewer: await androidTextIncludes(cdp, '1 connected'),
    }
    throw new Error(
      `No location reached the browser. Address forms: ${JSON.stringify(describeInvitationAddresses(shareUrl))}; Browser state: ${JSON.stringify(browserState)}; Android state: ${JSON.stringify(androidState)}`,
      { cause: error },
    )
  }
  await viewer.getByRole('button', { name: 'Show on map' }).click()
  await viewer.getByRole('button', { name: 'Open menu' }).click()
  await viewer.getByRole('button', { name: 'Following (1)' }).click()
  const updatesBeforeLock = await receivedUpdateCount(viewer)
  console.log('[android-test] checking locked-screen update')
  adb(['shell', 'input', 'keyevent', 'KEYCODE_SLEEP'])
  try {
    adb(['emu', 'geo', 'fix', '-70.0101', '40.0101'])
    await waitFor(
      async () => (await receivedUpdateCount(viewer)) > updatesBeforeLock,
      'a location update while the Android screen is locked',
      45_000,
    )
  } finally {
    adb(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'])
    adb(['shell', 'input', 'keyevent', 'KEYCODE_MENU'])
  }
  await viewer
    .getByRole('dialog', { name: 'Following' })
    .getByRole('button', { name: 'Close' })
    .click()
  await viewer.getByRole('button', { name: 'Keep following' }).click()
  await viewer.getByRole('button', { name: 'Save location' }).click()
  await viewer.getByRole('button', { name: 'Share mine back' }).click()
  console.log('[android-test] checking return offer')
  await viewer.getByRole('button', { name: 'Create private link' }).click()
  adb(['shell', 'am', 'start', '-n', `${packageName}/.MainActivity`])
  await waitFor(
    () => androidTextIncludes(cdp, 'A connected viewer offered a private location link'),
    'the private return offer in Android',
    30_000,
  )
  assert.equal(await clickButton(cdp, 'View return location'), true)
  await waitFor(
    () => androidTextIncludes(cdp, 'Someone shared their location with you'),
    'the Android return-link approval',
  )
  assert.equal(await clickButton(cdp, 'View location'), true)
  await waitFor(() => androidTextIncludes(cdp, 'Seeing 1'), 'Android return viewer', 30_000)
  assert.equal(await clickButton(cdp, 'Seeing 1'), true)
  await waitFor(() => androidTextIncludes(cdp, 'Show on map'), 'the return location', 30_000)
  assert.equal(await clickButton(cdp, 'Sharing 1'), true)
  await waitFor(() => androidTextIncludes(cdp, '1 connected'), 'Android viewer presence', 30_000)
  cdp.close()
  console.log('[android-test] checking process restart')
  adb(['shell', 'am', 'force-stop', packageName])
  adb(['shell', 'am', 'start', '-n', `${packageName}/.MainActivity`])
  cdp = await connectCdp()
  await waitFor(() => androidTextIncludes(cdp, 'Sharing 1'), 'the restored Android share')
  assert.equal(await clickButton(cdp, 'Sharing 1'), true)
  try {
    await waitFor(
      () => androidTextIncludes(cdp, '1 connected'),
      'the viewer reconnecting after Android process restart',
      75_000,
    )
  } catch (error) {
    const state = {
      androidOnline: await androidTextIncludes(cdp, 'P2P online'),
      androidShare: await androidTextIncludes(cdp, 'Sharing 1'),
      androidNoViewer: await androidTextIncludes(cdp, '0 connected'),
      viewerOnline: await viewer.getByText('P2P online').isVisible(),
      serviceRunning: adb(['shell', 'dumpsys', 'activity', 'services', packageName]).includes(
        'LocationShareService',
      ),
    }
    throw new Error(`Android viewer reconnect failed: ${JSON.stringify(state)}`, { cause: error })
  }
  assert.equal(await clickButton(cdp, 'Revoke link'), true)
  await viewer.getByText('Location sharing ended.').waitFor({ timeout: 15_000 })
  await viewerContext.close()

  startWithSharedText(shareUrl)
  console.log('[android-test] checking shared-text intake')
  await waitFor(
    () => androidTextIncludes(cdp, 'Someone shared their location with you'),
    'the warm-start shared-text approval',
  )
  cdp.close()
  adb(['shell', 'am', 'force-stop', packageName])
  startWithSharedText(shareUrl)
  cdp = await connectCdp()
  await waitFor(
    () => androidTextIncludes(cdp, 'Someone shared their location with you'),
    'the cold-start shared-text approval',
  )
  return cdp
}

const main = async () => {
  const serials = process.env.ANDROID_SERIALS?.split(',')
  if (serials?.length === 2) {
    await runThreeWayFlow(serials[0], serials[1])
    return
  }
  if (process.env.ANDROID_SERIAL) {
    assert.equal(adb(['get-state']).trim(), 'device')
  } else {
    assert.equal(
      adb(['devices'])
        .split('\n')
        .filter((line) => /\sdevice$/.test(line)).length,
      1,
    )
  }
  if (process.argv.includes('--native-store-smoke')) {
    let cdp
    try {
      adb(['shell', 'am', 'start', '-n', `${packageName}/.MainActivity`])
      cdp = await connectCdp()
      await waitFor(() => androidTextIncludes(cdp, 'Share location'), 'Android app startup')
      const privateKey = Buffer.from(
        privateKeyToProtobuf(await generateKeyPair('Ed25519')),
      ).toString('base64url')
      const results = await cdp.evaluate(`(async () => {
        const state = ${JSON.stringify({ version: 1, privateKey, shares: [], followed: [], viewerLabels: [] })};
        const invoke = window.__TAURI_INTERNALS__?.invoke;
        if (!invoke) return ['unavailable'];
        const probe = (command, args) => Promise.race([
          invoke(command, args).then(() => 'returned', () => 'error'),
          new Promise((resolve) => setTimeout(() => resolve('timeout'), 5_000)),
        ]);
        return [
          await probe('android_save_private_state', { state: JSON.stringify(state) }),
          await probe('android_save_private_state', { state: JSON.stringify(state) }),
          await probe('android_load_private_state'),
        ];
      })()`)
      assert.deepEqual(results, ['returned', 'returned', 'returned'])
    } finally {
      cdp?.close()
      adb(['shell', 'am', 'force-stop', packageName])
    }
    return
  }
  if (process.argv.includes('--native-location-smoke')) {
    let cdp
    let nextFix
    try {
      adb(['emu', 'geo', 'fix', '-70.0000', '40.0000'])
      grantIfSupported('android.permission.ACCESS_FINE_LOCATION')
      adb(['shell', 'am', 'force-stop', packageName])
      adb(['shell', 'am', 'start', '-n', `${packageName}/.MainActivity`])
      cdp = await connectCdp()
      await waitFor(() => androidTextIncludes(cdp, 'Share location'), 'Android app startup')
      nextFix = setTimeout(() => {
        adb(['emu', 'geo', 'fix', '-70.0001', '40.0001'])
      }, 2_000)
      const result = await cdp.evaluate(`(async () => {
        const api = window.__TAURI_INTERNALS__;
        if (!api?.invoke || !api?.transformCallback) return { error: 'bridge unavailable' };
        const invoke = api.invoke;
        const permission = await invoke('android_location_permission');
        const position = await Promise.race([
          invoke('android_current_location', { options: { timeout: 15000, maximumAge: 0 } }),
          new Promise((resolve) => setTimeout(() => resolve(null), 20000)),
        ]);
        let complete;
        const received = new Promise((resolve) => { complete = resolve; });
        const callbackId = api.transformCallback((raw) => {
          if (raw?.message?.position?.coords) complete(true);
        });
        let watchId;
        try {
          const started = await invoke('android_start_location_watch', {
            options: { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
            channel: '__CHANNEL__:' + callbackId,
          });
          watchId = started.watchId;
          const watch = await Promise.race([
            received,
            new Promise((resolve) => setTimeout(() => resolve(false), 10000)),
          ]);
          return {
            grant: permission.grant,
            enabled: permission.servicesEnabled,
            position: Boolean(position?.coords && Number.isFinite(position.coords.accuracy)),
            watch,
          };
        } finally {
          if (watchId !== undefined) await invoke('android_stop_location_watch', { watchId });
          api.unregisterCallback(callbackId);
        }
      })()`)
      assert.deepEqual(result, { grant: 'fine', enabled: true, position: true, watch: true })
    } finally {
      if (nextFix) clearTimeout(nextFix)
      cdp?.close()
      adb(['shell', 'am', 'force-stop', packageName])
    }
    return
  }
  let server
  let cdp
  let browser
  try {
    adb(['emu', 'geo', 'fix', '-70.0000', '40.0000'])
    grantIfSupported('android.permission.ACCESS_FINE_LOCATION')
    grantIfSupported('android.permission.ACCESS_BACKGROUND_LOCATION')
    grantIfSupported('android.permission.POST_NOTIFICATIONS')
    adb(['shell', 'am', 'force-stop', packageName])
    adb(['shell', 'am', 'start', '-n', `${packageName}/.MainActivity`])
    server = await startWebServer()
    cdp = await connectCdp()
    browser = await chromium.launch({
      env: browserProcessEnvironment(process.env),
    })
    cdp = await runShareFlow(cdp, browser)
    console.log('Android P2P sharing, process recovery, and shared-text intake passed.')
  } finally {
    await browser?.close()
    cdp?.close()
    server?.kill('SIGTERM')
    adb(['shell', 'am', 'force-stop', packageName])
  }
}

main().catch((error) => {
  console.error(
    redactAndroidTestError(error instanceof Error ? (error.stack ?? error.message) : String(error)),
  )
  process.exitCode = 1
})
