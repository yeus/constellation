import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'

import { chromium } from '@playwright/test'
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys'

import { compileAndroidWebViewExpression } from './android-cdp-source.mjs'
import { browserProcessEnvironment } from './browser-environment.mjs'
import { redactAndroidTestError, summarizeAndroidNativeCrash } from './android-test-privacy.mjs'

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

const startCaptivePortalResponder = async (port) => {
  const requests = []
  const server = createServer((_request, response) => {
    requests.push(true)
    response.writeHead(302, {
      Location: 'http://portal.invalid/',
      'Content-Length': '0',
      Connection: 'close',
    })
    response.end()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return { server, requests }
}

const waitForCdpPage = async (port) => {
  let selected
  await waitFor(
    async () => {
      try {
        const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
        const candidate = pages.find(
          (page) =>
            page.type === 'page' &&
            /^https?:/.test(page.url) &&
            page.url !== 'https://constellation.invalid/runtime.html',
        )
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

const connectCdp = async (serial = process.env.ANDROID_SERIAL, port = 9222, attempt = 0) => {
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
  const handshakeId = ++nextId
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(handshakeId)
      reject(new Error('Android WebView debugger handshake timed out.'))
    }, 5_000)
    pending.set(handshakeId, {
      resolve: () => {
        clearTimeout(timeout)
        resolve()
      },
      reject: (error) => {
        clearTimeout(timeout)
        reject(error)
      },
    })
    socket.send(
      JSON.stringify({
        id: handshakeId,
        method: 'Runtime.evaluate',
        params: { expression: 'document.readyState', returnByValue: true },
      }),
    )
  }).catch(async (error) => {
    socket.close()
    if (attempt >= 5) throw error
    await wait(500)
    return undefined
  })
  if (socket.readyState !== WebSocket.OPEN) return connectCdp(serial, port, attempt + 1)
  return createCdpClient(
    socket,
    pending,
    () => ++nextId,
    () => [...persistenceTrace],
    () => [...ipcTrace],
    serial,
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

const createCdpClient = (socket, pending, nextId, persistenceTrace, ipcTrace, serial) => {
  const command = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId()
      const timeout = setTimeout(() => {
        pending.delete(id)
        const operation = [
          'android_start_background_share',
          'android_background_share_status',
          'android_load_private_state',
          'android_current_location',
          'document.readyState',
          'document.querySelector',
          'document.body',
        ].find((name) => params.expression?.includes(name))
        let activity = 'unavailable'
        let rendererExit = false
        let fatalNative = false
        let exceptions = []
        let crash = {}
        try {
          const resumed = adbFor(serial, ['shell', 'dumpsys', 'activity', 'activities'])
            .split('\n')
            .filter((line) => line.includes('ResumedActivity'))
            .join('\n')
          activity = resumed.includes(packageName)
            ? 'app'
            : resumed.includes('settings')
              ? 'settings'
              : resumed.includes('launcher')
                ? 'launcher'
                : resumed.includes('permission') || resumed.includes('packageinstaller')
                  ? 'permission'
                  : resumed.includes('null')
                    ? 'none'
                    : 'other'
          const logs = adbFor(serial, ['logcat', '-d', '-t', '10000'])
          rendererExit = /onRenderProcessGone|Render process.*crash|renderer.*crash/i.test(logs)
          fatalNative = /Fatal signal/.test(logs)
          const crashLogs = adbFor(serial, ['logcat', '-b', 'crash', '-d', '-t', '500'])
          crash = summarizeAndroidNativeCrash(crashLogs, packageName)
          exceptions = [
            ...new Set(
              logs.match(/(?:java|android|org|com)\.[A-Za-z0-9_.$]+(?:Exception|Error)/g) ?? [],
            ),
          ].slice(-8)
        } catch {
          /* Diagnostic failure must not mask the debugger failure. */
        }
        reject(
          new Error(
            `Android WebView debugger did not answer ${method} (${operation ?? 'command'}) within 30 seconds; IPC markers: ${JSON.stringify(ipcTrace())}; activity: ${activity}; rendererExit: ${rendererExit}; fatalNative: ${fatalNative}; exceptionClasses: ${JSON.stringify(exceptions)}; crash: ${JSON.stringify(crash)}.`,
          ),
        )
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
      const compatibleExpression = await compileAndroidWebViewExpression(expression)
      const response = await command('Runtime.evaluate', {
        expression: compatibleExpression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      })
      if (response.exceptionDetails) {
        const description =
          response.exceptionDetails.exception?.description ?? response.exceptionDetails.text
        throw new Error(description)
      }
      return response.result.value
    },
    tap: async (x, y) => {
      await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
      await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    },
    installOnNewDocument: async (source) => {
      await command('Page.enable', {})
      return command('Page.addScriptToEvaluateOnNewDocument', { source })
    },
    reload: () => command('Page.reload', { ignoreCache: true }),
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
  await waitFor(
    () =>
      cdp.evaluate(`([...document.querySelectorAll('button')].some((button) =>
        button.textContent?.includes('Create private link') && !button.disabled))`),
    'enabled Android Create private link action',
    30_000,
  )
  assert.equal(await clickButton(cdp, 'Create private link'), true)
  let url
  try {
    url = await readAndroidShareLink(cdp)
  } catch (error) {
    const state = await cdp.evaluate(`(async () => {
      const invoke = window.__TAURI_INTERNALS__?.invoke;
      const nativeStatus = invoke ? await invoke('android_background_share_status').catch((error) => ({ error: String(error) })) : undefined;
      const createButton = [...document.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Create private link'));
      return {
        foregroundOnline: document.body?.innerText?.includes('P2P online') === true,
        shareDialog: Boolean(document.querySelector('[aria-labelledby="share-title"]')),
        createDisabled: createButton?.disabled,
        toast: document.querySelector('.toast')?.textContent?.trim() || '',
        connecting: document.body?.innerText?.includes('Connecting to the P2P network') === true,
        unreachable: document.body?.innerText?.includes('No reachable P2P address') === true,
        locationDenied: document.body?.innerText?.includes('Location permission denied') === true,
        locationWaiting: document.body?.innerText?.includes('Waiting for your location') === true,
        backgroundStarting: document.body?.innerText?.includes('Starting private P2P sharing') === true,
        nativeState: nativeStatus?.state,
        nativePeerStatus: nativeStatus?.peerStatus,
        nativeMessage: nativeStatus?.message,
        nativeShareCount: nativeStatus?.shares?.length,
      };
    })()`)
    throw new Error(`Android Star link unavailable: ${JSON.stringify(state)}`, { cause: error })
  }
  assert.equal(await closeAndroidDialog(cdp), true)
  return url
}

const createBackgroundShareForSmoke = async (cdp) => {
  await waitFor(() => androidTextIncludes(cdp, 'Share location'), 'Android app startup')
  assert.equal(await clickButton(cdp, 'Share location'), true)
  assert.equal(await clickButton(cdp, 'In background'), true)
  assert.equal(await clickButton(cdp, 'Device accuracy'), true)
  assert.equal(await clickButton(cdp, 'Create private link'), true)
  const url = await readAndroidShareLink(cdp)
  await closeAndroidDialog(cdp)
  return url
}

const assertNotificationStopAction = async () => {
  await waitFor(() => {
    const dump = adb(['shell', 'dumpsys', 'notification', '--noredact'])
    return (
      dump.includes('pkg=space.taskyon.constellation') &&
      dump.includes('id=4107') &&
      dump.includes('actions=1') &&
      dump.includes('"Stop sharing"') &&
      dump.includes('startService') &&
      dump.includes('1 link') &&
      dump.includes('exact') &&
      dump.includes('next ends in')
    )
  }, 'Android notification sharing summary and Stop sharing PendingIntent')
}

const sharingNotificationPresent = () =>
  adb(['shell', 'cmd', 'notification', 'list'])
    .split(/\r?\n/)
    .some((key) => {
      const [, owner, id] = key.trim().split('|')
      return owner === packageName && id === '4107'
    })

const notificationStopActionCenter = async (sharing = true) => {
  const actionLabel = sharing ? 'Stop sharing' : 'Stop notices'
  const titleLabel = sharing
    ? 'Constellation is sharing your location'
    : 'Constellation is sending ended-link notices'
  adb(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'])
  adb(['shell', 'wm', 'dismiss-keyguard'])
  await wait(500)
  adb(['shell', 'cmd', 'statusbar', 'expand-notifications'])
  const dumpPath = '/sdcard/constellation-notification.xml'
  const center = (node) => {
    const bounds = node && node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
    return bounds
      ? {
          x: (Number(bounds[1]) + Number(bounds[3])) / 2,
          y: (Number(bounds[2]) + Number(bounds[4])) / 2,
        }
      : undefined
  }
  try {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await wait(350)
      adb(['shell', 'uiautomator', 'dump', dumpPath])
      const xml = adb(['shell', 'cat', dumpPath])
      const actionNode = xml.match(
        new RegExp(`<node\\b[^>]*(?:text|content-desc)="[^"]*${actionLabel}[^"]*"[^>]*\\/>`),
      )?.[0]
      const action = center(actionNode)
      if (action) return action

      const titleNode = xml.match(
        new RegExp(`<node\\b[^>]*(?:text|content-desc)="${titleLabel}"[^>]*\\/>`),
      )?.[0]
      const title = center(titleNode)
      if (!title) continue
      const expandNodes = [
        ...xml.matchAll(
          /<node\b[^>]*resource-id="[^"]*(?:alternate_expand_target|expand_button_icon|expand_button)[^"]*"[^>]*\/>/g,
        ),
      ]
        .map((match) => ({ node: match[0], point: center(match[0]) }))
        .filter(({ point }) => point)
        .sort((left, right) => Math.abs(left.point.y - title.y) - Math.abs(right.point.y - title.y))
      const nearest = expandNodes[0]?.point
      if (nearest) {
        adb(['shell', 'input', 'tap', String(Math.round(nearest.x)), String(Math.round(nearest.y))])
      } else {
        adb([
          'shell',
          'input',
          'swipe',
          String(Math.round(title.x)),
          String(Math.round(title.y)),
          String(Math.round(title.x)),
          String(Math.round(title.y + 180)),
          '250',
        ])
      }
    }
    throw new Error(
      `Android notification did not render the ${actionLabel} action after expanding the Constellation notification.`,
    )
  } finally {
    try {
      adb(['shell', 'rm', '-f', dumpPath])
    } catch {
      // Best-effort diagnostic cleanup.
    }
  }
}

const revokePermission = (permission) => {
  try {
    adb(['shell', 'pm', 'revoke', packageName, permission])
  } catch {
    // Some platform versions reject revocation for permissions they do not expose.
  }
}

const setPermissionFlags = (permission, operation) => {
  try {
    adb(['shell', 'pm', operation, packageName, permission, 'user-set,user-fixed'])
  } catch {
    // Older platform versions may not expose all flag operations.
  }
}

const runNotificationStopSmoke = async () => {
  try {
    adb(['shell', 'pm', 'clear', packageName])
    adb(['shell', 'am', 'force-stop', packageName])
    adb(['emu', 'geo', 'fix', '-70.0000', '40.0000'])
    grantIfSupported('android.permission.ACCESS_FINE_LOCATION')
    grantIfSupported('android.permission.ACCESS_BACKGROUND_LOCATION')
    grantIfSupported('android.permission.POST_NOTIFICATIONS')
    adb(['shell', 'am', 'start', '-n', `${packageName}/.MainActivity`])
    await wait(1_000)

    const cdp = await connectCdp()
    try {
      await createBackgroundShareForSmoke(cdp)
    } finally {
      cdp.close()
    }
    adb(['shell', 'input', 'keyevent', 'KEYCODE_HOME'])
    adb(['shell', 'input', 'keyevent', 'KEYCODE_HOME'])

    await waitFor(
      () =>
        adb(['shell', 'dumpsys', 'activity', 'services', packageName]).includes(
          'LocationShareService',
        ),
      'the Android foreground sharing service',
    )
    await assertNotificationStopAction()
    const { x, y } = await notificationStopActionCenter()
    adb(['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))])
    await waitFor(
      () =>
        !adb(['shell', 'dumpsys', 'activity', 'services', packageName]).includes(
          'LocationShareService',
        ),
      'notification Stop sharing action to stop the service',
      20_000,
    )
    await waitFor(
      () => !sharingNotificationPresent(),
      'notification Stop sharing action to remove the foreground notification',
      20_000,
    )
  } finally {
    try {
      adb(['shell', 'cmd', 'statusbar', 'collapse'])
    } catch {
      // Best-effort UI cleanup.
    }
    adb(['shell', 'am', 'force-stop', packageName])
  }
}

const runPermissionDenialSmoke = async () => {
  let cdp
  const permissions = [
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.ACCESS_COARSE_LOCATION',
    'android.permission.ACCESS_BACKGROUND_LOCATION',
  ]
  try {
    adb(['shell', 'pm', 'clear', packageName])
    for (const permission of permissions) {
      revokePermission(permission)
      setPermissionFlags(permission, 'set-permission-flags')
    }
    grantIfSupported('android.permission.POST_NOTIFICATIONS')
    adb(['shell', 'am', 'start', '-n', `${packageName}/.MainActivity`])
    cdp = await connectCdp()
    await waitFor(() => androidTextIncludes(cdp, 'Share location'), 'Android app startup')
    assert.equal(await clickButton(cdp, 'Share location'), true)
    assert.equal(await clickButton(cdp, 'In background'), true)
    assert.equal(await clickButton(cdp, 'Create private link'), true)
    await waitFor(
      () => androidTextIncludes(cdp, 'Location permission denied'),
      'location denial guidance',
      15_000,
    )
    assert.equal(
      adb(['shell', 'dumpsys', 'activity', 'services', packageName]).includes(
        'LocationShareService',
      ),
      false,
      'permission denial must not start the background location service',
    )
  } finally {
    for (const permission of permissions) {
      setPermissionFlags(permission, 'clear-permission-flags')
    }
    cdp?.close()
    adb(['shell', 'am', 'force-stop', packageName])
  }
}

const startDirectBackgroundShare = async (
  cdp,
  expiresAt = null,
  {
    publication = 'background',
    visible = true,
    name = 'Emulator policy smoke',
    expectedShareCount = 1,
    battery = 'balanced',
    network = 'always',
  } = {},
) => {
  const started = await cdp.evaluate(`(async () => {
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (!invoke) return 'bridge unavailable';
    const status = await invoke('android_start_background_share', {
      request: {
        precision: 'exact',
        viewerCapacity: 1,
        name: ${JSON.stringify(name)},
        publication: ${JSON.stringify(publication)},
        battery: ${JSON.stringify(battery)},
        network: ${JSON.stringify(network)},
        visible: ${visible ? 'true' : 'false'},
        expiresAt: ${expiresAt === null ? 'null' : String(expiresAt)},
        shareBaseUrl: 'https://constellation.taskyon.space/',
      },
    });
    return status.state;
  })()`)
  assert.notEqual(started, 'bridge unavailable')
  assert.notEqual(started, 'error', 'a new create must not acknowledge the previous failure')
  await waitFor(
    () =>
      adb(['shell', 'dumpsys', 'activity', 'services', packageName]).includes(
        'LocationShareService',
      ),
    'Android foreground sharing service to start',
    15_000,
  )

  let result
  let lastStatus
  try {
    await waitFor(
      async () => {
        const serialized = await cdp.evaluate(`(async () => {
          const invoke = window.__TAURI_INTERNALS__?.invoke;
          if (!invoke) return JSON.stringify({ error: 'bridge unavailable' });
          const status = await invoke('android_background_share_status');
          const share = status.shares?.find((candidate) => candidate.name === ${JSON.stringify(name)});
          return JSON.stringify({
            state: status.state,
            peerStatus: status.peerStatus ?? '',
            message: status.message ?? '',
            shareCount: status.shares?.length ?? 0,
            shareNames: (status.shares ?? []).map((entry) => entry.name ?? ''),
            share: share ? {
              shareId: share.shareId,
              url: share.url,
              expiresAt: share.expiresAt ?? null,
              name: share.name ?? '',
              publication: share.publication ?? '',
              battery: share.battery ?? '',
              network: share.network ?? '',
              peerStatus: status.peerStatus ?? '',
            } : null,
          });
        })()`)
        if (!serialized || typeof serialized !== 'string') return false
        const candidate = JSON.parse(serialized)
        lastStatus = {
          state: candidate.state,
          peerStatus: candidate.peerStatus,
          message: candidate.message,
          shareCount: candidate.shareCount,
          shareNames: candidate.shareNames,
        }
        if (candidate.state === 'error') {
          throw new Error(candidate.message || 'native background share failed')
        }
        if (!candidate.share || candidate.shareCount < expectedShareCount) return false
        if (
          typeof candidate.share.shareId !== 'string' ||
          typeof candidate.share.url !== 'string'
        ) {
          return false
        }
        result = candidate.share
        return true
      },
      'Android native background share status',
      45_000,
    )
  } catch (error) {
    let lifecycle = ''
    try {
      lifecycle = adb([
        'logcat',
        '-d',
        '-v',
        'brief',
        '-s',
        'ConstellationLifecycle:I',
        'ConstellationRuntime:I',
        'ConstellationStatus:I',
        '*:S',
      ])
        .trim()
        .split(/\r?\n/)
        .slice(-16)
        .join(' | ')
    } catch {
      // Best-effort synthetic-emulator diagnostics.
    }
    throw new Error(
      `Android native background share did not become ready; last status: ${JSON.stringify(lastStatus)}; lifecycle: ${lifecycle}`,
      { cause: error },
    )
  }
  return result
}

const readBackgroundStatus = async (cdp) => {
  const serialized = await cdp.evaluate(`(async () => {
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (!invoke) return JSON.stringify({ error: 'bridge unavailable' });
    const status = await invoke('android_background_share_status');
    return JSON.stringify({
      state: status.state,
      peerStatus: status.peerStatus ?? '',
      message: status.message ?? '',
      endNotificationCount: status.endNotificationCount ?? 0,
      returnOfferCount: status.returnOffers?.length ?? 0,
      capturedAt: status.location?.observation?.capturedAt ?? null,
      oldSharing: (status.oldSharing ?? []).map((share) => ({
        shareId: share.shareId,
        reason: share.reason,
      })),
      shares: (status.shares ?? []).map((share) => ({
        shareId: share.shareId,
        expiresAt: share.expiresAt ?? null,
        name: share.name ?? '',
        publication: share.publication ?? '',
      })),
    });
  })()`)
  assert.equal(typeof serialized, 'string')
  const status = JSON.parse(serialized)
  if (status.error) throw new Error(status.error)
  return status
}

const directTransportKinds = new Set(['WebRTC', 'WebRTC over relay', 'WebSocket', 'WebTransport'])

const readBackgroundTransportSummary = async (cdp) => {
  const serialized = await cdp.evaluate(`(async () => {
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (!invoke) return JSON.stringify({ error: 'bridge unavailable' });
    const status = await invoke('android_background_share_status');
    return JSON.stringify({
      state: status.state,
      peerStatus: status.peerStatus ?? '',
      activeShares: status.shares?.length ?? 0,
      endedReasons: (status.oldSharing ?? []).map((share) => share.reason),
      locationStatus: status.location?.status ?? '',
      locationAgeMs: status.location?.observation?.capturedAt
        ? Date.now() - status.location.observation.capturedAt
        : null,
      viewerCount: (status.shares ?? []).reduce(
        (sum, share) => sum + (share.viewerCount ?? 0),
        0,
      ),
      connections: (status.diagnostics?.connections ?? []).map((connection) => ({
        role: connection.role,
        transport: connection.transport,
        direction: connection.direction,
        status: connection.status,
      })),
      sessionEvents: (status.diagnostics?.sessionEvents ?? [])
        .slice(-5)
        .map((event) => event.event),
    });
  })()`)
  assert.equal(typeof serialized, 'string')
  const summary = JSON.parse(serialized)
  if (summary.error) throw new Error(summary.error)
  return summary
}

const readPolicyStatus = async (cdp) => {
  const serialized = await cdp.evaluate(`(async () => {
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (!invoke) return JSON.stringify({ error: 'bridge unavailable' });
    const status = await invoke('android_background_share_status');
    const observation = status.location?.observation;
    return JSON.stringify({
      state: status.state,
      pauseReason: status.pauseReason ?? null,
      sampling: status.sampling ?? null,
      shares: (status.shares ?? []).map((share) => ({
        shareId: share.shareId,
        battery: share.battery ?? '',
        network: share.network ?? '',
        paused: share.paused ?? null,
        lastUpdateAt: share.lastUpdateAt ?? null,
        expiresAt: share.expiresAt ?? null,
      })),
      capturedAt: observation?.capturedAt ?? null,
      sequence: observation?.sequence ?? null,
    });
  })()`)
  assert.equal(typeof serialized, 'string')
  const summary = JSON.parse(serialized)
  if (summary.error) throw new Error(summary.error)
  return summary
}

const setupNativeBackgroundSmoke = async () => {
  adb(['shell', 'pm', 'clear', packageName])
  adb(['shell', 'am', 'force-stop', packageName])
  await waitFor(
    () =>
      !adb(['shell', 'dumpsys', 'activity', 'services', packageName]).includes(
        'LocationShareService',
      ),
    'clean Android background-share service state',
    10_000,
  )
  adb(['emu', 'geo', 'fix', '-70.0000', '40.0000'])
  grantIfSupported('android.permission.ACCESS_FINE_LOCATION')
  grantIfSupported('android.permission.ACCESS_BACKGROUND_LOCATION')
  grantIfSupported('android.permission.POST_NOTIFICATIONS')
  adb(['shell', 'am', 'start', '-n', `${packageName}/.MainActivity`])
  const cdp = await connectCdp()
  await waitFor(() => androidTextIncludes(cdp, 'Share location'), 'Android app startup')
  return cdp
}

const verifyEndedNotices = async (cdp, reasons) => {
  const ended = await readBackgroundStatus(cdp)
  assert.equal(ended.state, 'stopped')
  assert.equal(ended.shares.length, 0)
  assert.equal(ended.endNotificationCount, reasons.length)
  assert.deepEqual(ended.oldSharing.map((entry) => entry.reason).sort(), [...reasons].sort())
  assert.equal(sharingNotificationPresent(), true, 'ended-link notices must remain visible')
  adb(['emu', 'geo', 'fix', '-70.0201', '40.0201'])
  await wait(1_500)
  assert.equal(
    (await readBackgroundStatus(cdp)).capturedAt,
    ended.capturedAt,
    'ended-link notices must not keep collecting locations',
  )
  const { x, y } = await notificationStopActionCenter(false)
  adb(['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))])
  await waitFor(
    () =>
      !adb(['shell', 'dumpsys', 'activity', 'services', packageName]).includes(
        'LocationShareService',
      ) && !sharingNotificationPresent(),
    'Stop notices to stop the service and remove the active notification',
    20_000,
  )
}

const runExpirySmoke = async () => {
  let cdp
  try {
    cdp = await setupNativeBackgroundSmoke()
    const expiresAt = Date.now() + 20_000
    const share = await startDirectBackgroundShare(cdp, expiresAt)
    assert.equal(share.expiresAt, expiresAt)
    adb(['shell', 'input', 'keyevent', 'KEYCODE_HOME'])
    await waitFor(
      async () => {
        const status = await readBackgroundStatus(cdp)
        return (
          status.shares.length === 0 &&
          status.oldSharing.some(
            (entry) => entry.shareId === share.shareId && entry.reason === 'expired',
          )
        )
      },
      'the final expired share to leave active sharing and enter history',
      50_000,
    )
    await verifyEndedNotices(cdp, ['expired'])
  } finally {
    cdp?.close()
    adb(['shell', 'am', 'force-stop', packageName])
  }
}

const REBOOT_STATE_PREFIX = '[constellation-reboot-state] '

const runRebootPrepareSmoke = async () => {
  let cdp
  try {
    cdp = await setupNativeBackgroundSmoke()
    // The finite fixture must outlive the managed cold-boot deadline.
    const expiresAt = Date.now() + 15 * 60_000
    const share = await startDirectBackgroundShare(cdp, expiresAt)
    assert.equal(share.expiresAt, expiresAt)
    console.log(
      `${REBOOT_STATE_PREFIX}${JSON.stringify({ shareId: share.shareId, expiresAt: share.expiresAt })}`,
    )
  } finally {
    cdp?.close()
  }
}

const runRebootVerifySmoke = async () => {
  const expectedShareId = process.env.EXPECTED_REBOOT_SHARE_ID
  const expectedExpiresAt = Number(process.env.EXPECTED_REBOOT_EXPIRES_AT)
  if (!expectedShareId || !Number.isFinite(expectedExpiresAt)) {
    throw new Error('Expected reboot share identity and expiry are required.')
  }
  assert.equal(
    adb(['shell', 'dumpsys', 'activity', 'services', packageName]).includes('LocationShareService'),
    false,
    'power-cycle must not silently resume location publication before the app returns',
  )

  let cdp
  try {
    adb(['shell', 'am', 'start', '-n', `${packageName}/.MainActivity`])
    for (let attempt = 0; attempt < 8 && !cdp; attempt += 1) {
      let candidate
      try {
        candidate = await connectCdp()
        const responsive = await Promise.race([
          candidate.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`),
          wait(5_000).then(() => false),
        ])
        if (responsive) {
          cdp = candidate
          break
        }
      } catch {
        // A cold boot can expose a stale WebView target before the new Activity settles.
      }
      candidate?.close()
      await wait(1_000)
    }
    if (!cdp) throw new Error('Tauri bridge did not stabilize after Android power-cycle.')

    let restored
    await waitFor(
      async () => {
        const status = await readBackgroundStatus(cdp)
        const candidate = status.shares[0]
        if (!candidate) return false
        restored = { ...candidate, state: status.state }
        return true
      },
      'the share to restore after power-cycle',
      30_000,
    )
    assert.equal(restored.shareId, expectedShareId)
    assert.equal(restored.expiresAt, expectedExpiresAt)
    assert.equal(restored.state, 'sharing')
    await waitFor(
      () =>
        adb(['shell', 'dumpsys', 'activity', 'services', packageName]).includes(
          'LocationShareService',
        ),
      'background sharing service after app-open power-cycle recovery',
      20_000,
    )
    await cdp.evaluate(
      `window.__TAURI_INTERNALS__.invoke('android_stop_background_share', { shareId: ${JSON.stringify(expectedShareId)} })`,
    )
  } finally {
    cdp?.close()
    try {
      adb(['shell', 'am', 'force-stop', packageName])
    } catch {
      // Power-cycle smoke cleanup is best-effort.
    }
  }
}

const runServiceRestartSmoke = async () => {
  let cdp
  const processPid = () => {
    try {
      return adb(['shell', 'pidof', packageName]).trim().split(/\s+/)[0] ?? ''
    } catch {
      return ''
    }
  }
  try {
    cdp = await setupNativeBackgroundSmoke()
    const expiresAt = Date.now() + 180_000
    const share = await startDirectBackgroundShare(cdp, expiresAt)
    assert.equal(share.expiresAt, expiresAt)
    adb(['shell', 'input', 'keyevent', 'KEYCODE_HOME'])
    const originalPid = processPid()
    assert.match(originalPid, /^\d+$/)
    assert.equal(
      adb(['shell', 'dumpsys', 'activity', 'services', packageName]).includes(
        'LocationShareService',
      ),
      true,
      'background service must be running before synthetic process death',
    )
    cdp.close()
    cdp = undefined

    adb(['shell', 'cmd', 'activity', 'crash', packageName])
    let restartedPid = ''
    await waitFor(
      () => {
        restartedPid = processPid()
        return (
          /^\d+$/.test(restartedPid) &&
          restartedPid !== originalPid &&
          adb(['shell', 'dumpsys', 'activity', 'services', packageName]).includes(
            'LocationShareService',
          )
        )
      },
      'START_STICKY background service recovery after process death',
      45_000,
    )
    await wait(2_000)
    assert.equal(
      processPid(),
      restartedPid,
      'sticky recovery process should remain alive after restart',
    )
    assert.equal(
      adb(['shell', 'dumpsys', 'activity', 'services', packageName]).includes(
        'LocationShareService',
      ),
      true,
      'sticky-recovered background service should remain running before the Activity returns',
    )
    const resumedActivity = adb(['shell', 'dumpsys', 'activity', 'activities'])
      .split(/\r?\n/)
      .filter((line) => line.includes('ResumedActivity'))
      .join('\n')
    assert.equal(
      resumedActivity.includes(packageName),
      false,
      'service-only recovery must not require reopening the Constellation Activity',
    )

    adb(['shell', 'am', 'start', '-n', `${packageName}/.MainActivity`])
    for (let attempt = 0; attempt < 8 && !cdp; attempt += 1) {
      let candidate
      try {
        candidate = await connectCdp()
        const responsive = await Promise.race([
          candidate.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`),
          wait(5_000).then(() => false),
        ])
        if (responsive) {
          cdp = candidate
          break
        }
      } catch {
        // Process recovery can briefly leave a stale WebView target behind.
      }
      candidate?.close()
      await wait(1_000)
    }
    if (!cdp) throw new Error('Tauri bridge did not stabilize after service-only process recovery.')

    const restoredSerialized = await cdp.evaluate(`(async () => {
      const invoke = window.__TAURI_INTERNALS__?.invoke;
      if (!invoke) return JSON.stringify({ error: 'bridge unavailable' });
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const status = await invoke('android_background_share_status');
        const candidate = status.shares?.[0];
        if (candidate) {
          return JSON.stringify({
            shareId: candidate.shareId,
            expiresAt: candidate.expiresAt ?? null,
            state: status.state,
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return JSON.stringify({ error: 'share did not restore after service-only process recovery' });
    })()`)
    assert.equal(typeof restoredSerialized, 'string')
    const restored = JSON.parse(restoredSerialized)
    if (restored.error) throw new Error(restored.error)
    assert.equal(restored.shareId, share.shareId)
    assert.equal(restored.expiresAt, expiresAt)
    assert.equal(restored.state, 'sharing')
    await cdp.evaluate(
      `window.__TAURI_INTERNALS__.invoke('android_stop_background_share', { shareId: ${JSON.stringify(share.shareId)} })`,
    )
  } finally {
    cdp?.close()
    try {
      adb(['shell', 'am', 'force-stop', packageName])
    } catch {
      // Service-restart smoke cleanup is best-effort.
    }
  }
}

const runForegroundOnlySmoke = async () => {
  let cdp
  try {
    cdp = await setupNativeBackgroundSmoke()
    const share = await startDirectBackgroundShare(cdp, Date.now() + 180_000, {
      publication: 'foreground',
      name: 'Foreground-only emulator smoke',
    })
    assert.equal(share.publication, 'foreground')
    adb(['shell', 'input', 'keyevent', 'KEYCODE_HOME'])
    await waitFor(
      async () => (await readBackgroundStatus(cdp)).state === 'paused',
      'foreground-only share to pause while Constellation is hidden',
      20_000,
    )
    await waitFor(
      () =>
        !adb(['shell', 'dumpsys', 'activity', 'services', packageName]).includes(
          'LocationShareService',
        ),
      'foreground-only service to stop while hidden',
      20_000,
    )
    assert.equal(
      sharingNotificationPresent(),
      false,
      'foreground-only pause must remove the ongoing sharing notification',
    )

    adb(['shell', 'am', 'start', '-n', `${packageName}/.MainActivity`])
    await waitFor(
      async () => {
        const status = await readBackgroundStatus(cdp)
        return (
          status.state === 'sharing' &&
          status.shares.length === 1 &&
          status.shares[0].shareId === share.shareId &&
          status.shares[0].publication === 'foreground'
        )
      },
      'foreground-only share to resume with the same identity',
      45_000,
    )
    await cdp.evaluate(
      `window.__TAURI_INTERNALS__.invoke('android_stop_background_share', { shareId: ${JSON.stringify(share.shareId)} })`,
    )
  } finally {
    cdp?.close()
    adb(['shell', 'am', 'force-stop', packageName])
  }
}

const runMultipleSourceLinksSmoke = async () => {
  let cdp
  try {
    cdp = await setupNativeBackgroundSmoke()
    const first = await startDirectBackgroundShare(cdp, null, {
      name: 'Independent Android link A',
      expectedShareCount: 1,
    })
    const second = await startDirectBackgroundShare(cdp, null, {
      name: 'Independent Android link B',
      expectedShareCount: 2,
    })
    assert.notEqual(first.shareId, second.shareId)
    let status = await readBackgroundStatus(cdp)
    assert.equal(status.state, 'sharing')
    assert.deepEqual(
      new Set(status.shares.map(({ shareId }) => shareId)),
      new Set([first.shareId, second.shareId]),
    )
    await waitFor(
      () => androidTextIncludes(cdp, 'Sharing 2'),
      'Android dock to render two active shares',
      15_000,
    )
    const openedShares = await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('.connection-dock .dock-side')]
        .find((candidate) => candidate.textContent?.includes('Sharing 2'));
      if (!button) return false;
      button.click();
      return true;
    })()`)
    assert.equal(openedShares, true)
    await waitFor(() => androidTextIncludes(cdp, 'Active shares'), 'Android active-share list')
    const listState = await cdp.evaluate(`(() => {
      const dialog = document.querySelector('[aria-labelledby="shares-title"]');
      if (!dialog) return null;
      const articles = [...dialog.querySelectorAll('article')].map((article) => ({
        text: article.textContent ?? '',
        buttons: [...article.querySelectorAll('button')].map((button) => button.textContent?.trim() ?? ''),
      }));
      return { articles };
    })()`)
    assert.equal(listState?.articles?.length, 2)
    for (const name of ['Independent Android link A', 'Independent Android link B']) {
      const article = listState.articles.find(({ text }) => text.includes(name))
      assert.ok(article, `active-share list should include ${name}`)
      assert.match(article.text, /0 connected/)
      assert.ok(article.buttons.includes('Show link / QR'))
      assert.ok(article.buttons.includes('Revoke link'))
    }
    const reopened = await cdp.evaluate(`(() => {
      const article = [...document.querySelectorAll('.share-list-item')]
        .find((candidate) => candidate.textContent?.includes('Independent Android link A'));
      const button = article && [...article.querySelectorAll('button')]
        .find((candidate) => candidate.textContent?.includes('Show link / QR'));
      if (!button) return false;
      button.click();
      return true;
    })()`)
    assert.equal(reopened, true)
    await waitFor(() => androidTextIncludes(cdp, 'Share this QR code'), 'reopened Android share QR')
    const reopenedUrl = await cdp.evaluate(
      `document.querySelector('input[aria-label="Share link"]')?.value ?? ''`,
    )
    assert.equal(reopenedUrl, first.url)
    const closedReadyShare = await cdp.evaluate(`(() => {
      const button = document.querySelector('.share-ready button[aria-label="Close"]');
      if (!button) return false;
      button.click();
      return true;
    })()`)
    assert.equal(closedReadyShare, true)

    await cdp.evaluate(
      `window.__TAURI_INTERNALS__.invoke('android_stop_background_share', { shareId: ${JSON.stringify(first.shareId)} })`,
    )
    await waitFor(
      async () => {
        status = await readBackgroundStatus(cdp)
        return status.shares.length === 1 && status.shares[0].shareId === second.shareId
      },
      'second Android source link to remain after independently revoking the first',
      30_000,
    )
    assert.equal(
      adb(['shell', 'dumpsys', 'activity', 'services', packageName]).includes(
        'LocationShareService',
      ),
      true,
      'revoking one of two source links must keep the service running for the other',
    )

    await cdp.evaluate(
      `window.__TAURI_INTERNALS__.invoke('android_stop_background_share', { shareId: ${JSON.stringify(second.shareId)} })`,
    )
    await waitFor(
      async () => (await readBackgroundStatus(cdp)).shares.length === 0,
      'the final Android source link to leave active sharing',
      30_000,
    )
    await verifyEndedNotices(cdp, ['revoked', 'revoked'])
  } finally {
    cdp?.close()
    adb(['shell', 'am', 'force-stop', packageName])
  }
}

const setAirplaneMode = (enabled) => {
  try {
    adb(['shell', 'cmd', 'connectivity', 'airplane-mode', enabled ? 'enable' : 'disable'])
  } catch {
    adb(['shell', 'settings', 'put', 'global', 'airplane_mode_on', enabled ? '1' : '0'])
    adb([
      'shell',
      'am',
      'broadcast',
      '-a',
      'android.intent.action.AIRPLANE_MODE',
      '--ez',
      'state',
      enabled ? 'true' : 'false',
    ])
  }
}

const firstSavedWifiNetworkId = () => {
  try {
    const output = adb(['shell', 'cmd', 'netpolicy', 'list', 'wifi-networks'])
    const line = output
      .split(/\r?\n/)
      .map((value) => value.trim())
      .find((value) => value && !value.startsWith('Network policy manager'))
    return line ? line.split(';')[0].trim() : undefined
  } catch {
    return undefined
  }
}

const runPowerNetworkSmoke = async () => {
  let cdp
  let share
  try {
    cdp = await setupNativeBackgroundSmoke()
    console.log('[android-test] policy share created')
    share = await startDirectBackgroundShare(cdp, null)
    cdp.close()
    cdp = undefined
    await waitFor(
      () => {
        try {
          adb(['shell', 'input', 'keyevent', 'KEYCODE_HOME'])
          return true
        } catch {
          return false
        }
      },
      'ADB HOME transition before power/network smoke',
      15_000,
    )

    try {
      adb(['shell', 'dumpsys', 'battery', 'unplug'])
      adb(['shell', 'cmd', 'power', 'set-mode', '1'])
      adb(['shell', 'dumpsys', 'deviceidle', 'force-idle'])
      console.log('[android-test] device forced idle')
      await wait(3_000)
      assert.equal(
        adb(['shell', 'dumpsys', 'activity', 'services', packageName]).includes(
          'LocationShareService',
        ),
        true,
        'Doze/power saver must preserve the explicit active background share',
      )
    } finally {
      try {
        adb(['shell', 'dumpsys', 'deviceidle', 'unforce'])
      } catch {
        // Best-effort cleanup on emulator builds that do not expose this control.
      }
      try {
        adb(['shell', 'cmd', 'power', 'set-mode', '0'])
      } catch {
        // Best-effort cleanup on emulator builds that do not expose this control.
      }
      try {
        adb(['shell', 'dumpsys', 'battery', 'reset'])
      } catch {
        // Best-effort cleanup on emulator builds that do not expose this control.
      }
    }

    const meteredNetworkId = firstSavedWifiNetworkId()
    let meteredOverrideApplied = false
    try {
      if (meteredNetworkId) {
        try {
          adb(['shell', 'cmd', 'netpolicy', 'set', 'metered-network', meteredNetworkId, 'true'])
          meteredOverrideApplied = true
        } catch {
          console.log(
            `[android-test] emulator rejected metered override for ${meteredNetworkId}; using Data Saver only`,
          )
        }
      }
      adb(['shell', 'cmd', 'netpolicy', 'set', 'restrict-background', 'true'])
      console.log(
        meteredOverrideApplied
          ? `[android-test] enabled metered network ${meteredNetworkId} and Data Saver`
          : '[android-test] enabled Data Saver background-network restriction',
      )
      await wait(2_000)
      assert.equal(
        adb(['shell', 'dumpsys', 'activity', 'services', packageName]).includes(
          'LocationShareService',
        ),
        true,
        'metered/Data Saver policy must not silently revoke the explicit active share',
      )
    } finally {
      try {
        adb(['shell', 'cmd', 'netpolicy', 'set', 'restrict-background', 'false'])
      } catch {
        // Best-effort cleanup on emulator builds that do not expose this control.
      }
      if (meteredOverrideApplied && meteredNetworkId) {
        try {
          adb([
            'shell',
            'cmd',
            'netpolicy',
            'set',
            'metered-network',
            meteredNetworkId,
            'undefined',
          ])
        } catch {
          // Best-effort cleanup on emulator builds that do not expose this control.
        }
      }
    }

    console.log('[android-test] enabling airplane mode')
    setAirplaneMode(true)
    await wait(3_000)
    assert.equal(
      adb(['shell', 'dumpsys', 'activity', 'services', packageName]).includes(
        'LocationShareService',
      ),
      true,
      'network loss must not silently revoke the active share',
    )
    console.log('[android-test] disabling airplane mode')
    setAirplaneMode(false)
    await wait(5_000)

    adb(['shell', 'am', 'start', '-n', `${packageName}/.MainActivity`])
    cdp = undefined
    for (let attempt = 0; attempt < 4 && !cdp; attempt += 1) {
      let candidate
      try {
        candidate = await connectCdp()
        await wait(750)
        if (await candidate.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) {
          cdp = candidate
          break
        }
      } catch {
        // Activity restart may replace the WebView once before it settles.
      }
      candidate?.close()
      await wait(1_000)
    }
    if (!cdp) throw new Error('Tauri bridge did not stabilize after network recovery.')
    const restoredSerialized = await cdp.evaluate(`(async () => {
      const invoke = window.__TAURI_INTERNALS__?.invoke;
      if (!invoke) return JSON.stringify({ error: 'bridge unavailable' });
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const status = await invoke('android_background_share_status');
        const candidate = status.shares?.[0];
        if (candidate) {
          return JSON.stringify({
            shareId: candidate.shareId,
            expiresAt: candidate.expiresAt ?? null,
            state: status.state,
            peerStatus: status.peerStatus ?? '',
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return JSON.stringify({ error: 'share did not survive network recovery' });
    })()`)
    assert.equal(typeof restoredSerialized, 'string')
    const restored = JSON.parse(restoredSerialized)
    if (restored.error) throw new Error(restored.error)
    assert.equal(restored.shareId, share.shareId)
    assert.equal(restored.expiresAt, null)
    assert.equal(restored.state, 'sharing')
    await cdp.evaluate(
      `window.__TAURI_INTERNALS__.invoke('android_stop_background_share', { shareId: ${JSON.stringify(share.shareId)} })`,
    )
  } finally {
    try {
      setAirplaneMode(false)
    } catch {
      // Best-effort cleanup after network emulation.
    }
    try {
      adb(['shell', 'dumpsys', 'deviceidle', 'unforce'])
    } catch {
      // Best-effort cleanup after power emulation.
    }
    try {
      adb(['shell', 'cmd', 'power', 'set-mode', '0'])
    } catch {
      // Best-effort cleanup after power emulation.
    }
    try {
      adb(['shell', 'dumpsys', 'battery', 'reset'])
    } catch {
      // Best-effort cleanup after battery emulation.
    }
    cdp?.close()
    try {
      adb(['shell', 'am', 'force-stop', packageName])
    } catch {
      // Network/power emulation can transiently disrupt ADB during cleanup.
    }
  }
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

const verifyAndroidFollowingControls = async (cdp) => {
  assert.equal(await clickButton(cdp, 'Seeing 2'), true)
  await waitFor(
    async () => (await androidButtonCount(cdp, 'Show on map')) === 2,
    'two viewable Android follows before control acceptance',
    30_000,
  )
  const originalName = await cdp.evaluate(
    `document.querySelector('.follow-item strong')?.textContent?.trim() ?? ''`,
  )
  assert.ok(originalName)
  const edited = await cdp.evaluate(`(() => {
    const row = document.querySelector('.follow-item');
    const button = row?.querySelector('.nickname-button');
    if (!button) return false;
    button.click();
    return true;
  })()`)
  assert.equal(edited, true)
  const changedName = 'Android UI acceptance alias'
  const changed = await cdp.evaluate(`(() => {
    const input = document.querySelector('.follow-item input[aria-label="Your nickname"]');
    if (!input) return false;
    input.value = ${JSON.stringify('Android UI acceptance alias')};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const row = input.closest('.follow-item');
    const save = [...(row?.querySelectorAll('button') ?? [])]
      .find((button) => button.textContent?.trim() === 'Save');
    if (!save) return false;
    save.click();
    return true;
  })()`)
  assert.equal(changed, true)
  await waitFor(() => androidTextIncludes(cdp, changedName), 'edited Android follow nickname')

  const color = await cdp.evaluate(`(() => {
    const row = document.querySelector('.follow-item');
    const button = row?.querySelector('.follow-item__colors button[aria-pressed="false"]');
    if (!button) return '';
    const label = button.getAttribute('aria-label') ?? '';
    button.click();
    return label;
  })()`)
  assert.match(color, /^Use #[0-9a-f]{6} color$/i)
  await waitFor(
    async () =>
      await cdp.evaluate(`(() => {
        const row = document.querySelector('.follow-item');
        const button = [...(row?.querySelectorAll('.follow-item__colors button') ?? [])]
          .find((candidate) => candidate.getAttribute('aria-label') === ${JSON.stringify(color)});
        return button?.getAttribute('aria-pressed') === 'true';
      })()`),
    'selected Android follow color',
  )

  const restoreEdit = await cdp.evaluate(`(() => {
    const row = document.querySelector('.follow-item');
    const edit = row?.querySelector('.nickname-button');
    if (!edit) return false;
    edit.click();
    return true;
  })()`)
  assert.equal(restoreEdit, true)
  await waitFor(
    async () =>
      await cdp.evaluate(
        `Boolean(document.querySelector('.follow-item input[aria-label="Your nickname"]'))`,
      ),
    'Android nickname editor to reopen',
  )
  const restored = await cdp.evaluate(`(() => {
    const input = document.querySelector('.follow-item input[aria-label="Your nickname"]');
    if (!input) return false;
    input.value = ${JSON.stringify(originalName)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const row = input.closest('.follow-item');
    const save = [...(row?.querySelectorAll('button') ?? [])]
      .find((button) => button.textContent?.trim() === 'Save');
    if (!save) return false;
    save.click();
    return true;
  })()`)
  assert.equal(restored, true)
  await waitFor(() => androidTextIncludes(cdp, originalName), 'restored Android follow nickname')

  const focused = await cdp.evaluate(`(() => {
    const row = document.querySelector('.follow-item');
    const button = [...(row?.querySelectorAll('button') ?? [])]
      .find((candidate) => candidate.textContent?.trim() === 'Show on map');
    if (!button) return false;
    button.click();
    return true;
  })()`)
  assert.equal(focused, true)
  await waitFor(
    async () =>
      !(await cdp.evaluate(
        `Boolean(document.querySelector('[aria-labelledby="following-title"]'))`,
      )),
    'single Android follow map focus',
  )

  assert.equal(await clickButton(cdp, 'Seeing 2'), true)
  const focusedAll = await cdp.evaluate(`(() => {
    const dialog = document.querySelector('[aria-labelledby="following-title"]');
    const button = [...(dialog?.querySelectorAll('button') ?? [])]
      .find((candidate) => candidate.textContent?.trim() === 'Show all on map');
    if (!button) return false;
    button.click();
    return true;
  })()`)
  assert.equal(focusedAll, true)
  await waitFor(
    async () =>
      !(await cdp.evaluate(
        `Boolean(document.querySelector('[aria-labelledby="following-title"]'))`,
      )),
    'all Android follows map focus',
  )
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
    await verifyAndroidFollowingControls(first)
    console.log('First Android follow nickname, color and map-focus controls passed.')
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

    if (!previewSecondLinks) {
      first.close()
      adbFor(firstSerial, ['shell', 'am', 'force-stop', packageName])
      adbFor(firstSerial, ['shell', 'am', 'start', '-n', `${packageName}/.MainActivity`])
      first = await connectCdp(firstSerial, 9222)
      await waitFor(
        () => androidTextIncludes(first, 'Seeing 2'),
        'saved Android follows after restart',
      )
      assert.equal(await clickButton(first, 'Seeing 2'), true)
      const restoredFollows = await first.evaluate(`([...document.querySelectorAll('.follow-item')]
        .map((item) => ({
          name: item.querySelector('strong')?.textContent?.trim(),
          saved: item.textContent?.includes('Saved') === true,
        })))`)
      assert.deepEqual(restoredFollows.map((follow) => follow.name).sort(), [
        'Synthetic desktop',
        'Synthetic phone B',
      ])
      assert.equal(
        restoredFollows.every((follow) => follow.saved),
        true,
      )
      await waitFor(
        async () => (await androidButtonCount(first, 'Show on map')) === 2,
        'both saved Android follows reconnecting after restart',
        75_000,
      )
      console.log('Android protected follows and both received locations survived restart.')
    }
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

const runDirectTransportSmoke = async () => {
  let cdp
  let server
  let relay
  let browser
  let viewerContext
  let share
  try {
    relay = await startLocalRelay()
    server = await startWebServer()
    adb(['reverse', 'tcp:9111', 'tcp:9111'])
    cdp = await setupNativeBackgroundSmoke()
    share = await startDirectBackgroundShare(cdp, null, { name: 'Direct transport smoke' })
    adb(['shell', 'input', 'keyevent', 'KEYCODE_HOME'])
    await waitFor(
      () =>
        adb(['shell', 'dumpsys', 'activity', 'services', packageName]).includes(
          'LocationShareService',
        ),
      'the Android foreground service for the direct-transport smoke',
    )

    browser = await chromium.launch({ env: browserProcessEnvironment(process.env) })
    viewerContext = await browser.newContext({
      geolocation: { latitude: 40.0002, longitude: -70.0002 },
      permissions: ['geolocation'],
    })
    const viewer = await viewerContext.newPage()
    await viewer.goto('http://127.0.0.1:4173/', { waitUntil: 'domcontentloaded' })
    const directInvitation = await viewer.evaluate(async (url) => {
      const { webRtcShareInvitation } = await import('../tests/fixtures/share-probe.ts')
      return webRtcShareInvitation(url)
    }, share.url)
    await viewer.goto(`http://127.0.0.1:4173/${new URL(directInvitation).hash}`, {
      waitUntil: 'domcontentloaded',
      timeout: 90_000,
    })
    try {
      await viewer.getByRole('button', { name: 'Keep following' }).waitFor({ timeout: 30_000 })
    } catch (error) {
      const viewerState = await viewer.evaluate(() => {
        const text = document.body.innerText
        return {
          connecting: text.includes('Connecting'),
          ended: text.includes('ended'),
          unavailable: text.includes('unavailable'),
          failed: text.includes('failed'),
          unreachable: text.includes('reachable'),
        }
      })
      const native = await readBackgroundTransportSummary(cdp)
      throw new Error(
        `WebRTC invitation failed before preview: ${JSON.stringify({ viewerState, native })}`,
        { cause: error },
      )
    }
    await viewer.getByRole('button', { name: 'Keep following' }).click()
    await viewer.getByRole('button', { name: 'Save location' }).click()
    await viewer.getByRole('button', { name: 'Not now' }).click()
    await viewer.getByRole('button', { name: 'Open menu' }).click()
    await viewer.getByRole('button', { name: 'Following (1)' }).click()
    await viewer.getByRole('button', { name: 'Show on map' }).waitFor({ timeout: 30_000 })

    let observed = await readBackgroundTransportSummary(cdp)
    try {
      await waitFor(
        async () => {
          observed = await readBackgroundTransportSummary(cdp)
          return observed.connections.some(
            (connection) =>
              connection.role === 'viewer' && directTransportKinds.has(connection.transport),
          )
        },
        'a classified direct Android transport for the browser viewer',
        30_000,
      )
    } catch (error) {
      throw new Error(
        `Android never classified a direct transport for the browser viewer: ${JSON.stringify(observed)}`,
        { cause: error },
      )
    }
    console.log(
      `[android-test] direct Android transport classified: ${JSON.stringify(observed.connections)}`,
    )

    const updatesBeforeRelayLoss = await receivedUpdateCount(viewer)
    relay.kill('SIGTERM')
    relay = undefined
    await waitFor(
      async () => {
        try {
          return !(await fetch('http://127.0.0.1:9113/health')).ok
        } catch {
          return true
        }
      },
      'the local relay to stop',
      15_000,
    )
    adb(['emu', 'geo', 'fix', '-70.0202', '40.0202'])
    try {
      await waitFor(
        async () => (await receivedUpdateCount(viewer)) > updatesBeforeRelayLoss,
        'a location update over the direct transport after relay shutdown',
        45_000,
      )
    } catch (error) {
      const afterLoss = await readBackgroundTransportSummary(cdp)
      throw new Error(
        `No location update reached the browser after relay shutdown: ${JSON.stringify(afterLoss)}`,
        { cause: error },
      )
    }
    console.log('[android-test] sharing continued after the local relay shut down.')
  } finally {
    await viewerContext?.close().catch(() => undefined)
    await browser?.close()
    server?.kill('SIGTERM')
    relay?.kill('SIGTERM')
    if (share) {
      try {
        await cdp?.evaluate(
          `window.__TAURI_INTERNALS__?.invoke('android_stop_background_share', { shareId: ${JSON.stringify(share.shareId)} })`,
        )
      } catch {
        // The smoke may have lost the debugger during relay-loss recovery.
      }
    }
    try {
      adb(['reverse', '--remove', 'tcp:9111'])
    } catch {
      // Best-effort cleanup.
    }
    cdp?.close()
    adb(['shell', 'am', 'force-stop', packageName])
  }
}

const runCaptiveTransportSmoke = async () => {
  let cdp
  let relay
  let responder
  try {
    const captive = await startCaptivePortalResponder(9112)
    responder = captive.server
    try {
      adb(['reverse', '--remove', 'tcp:9111'])
    } catch {
      // No reverse mapping existed yet.
    }
    adb(['reverse', 'tcp:9111', 'tcp:9112'])
    cdp = await setupNativeBackgroundSmoke()
    assert.equal(await clickButton(cdp, 'Share location'), true)
    assert.equal(await clickButton(cdp, 'Create private link'), true)
    let blocked
    try {
      await waitFor(
        async () => {
          blocked = await readBackgroundStatus(cdp)
          const serviceRunning = adb([
            'shell',
            'dumpsys',
            'activity',
            'services',
            packageName,
          ]).includes('LocationShareService')
          return !serviceRunning && blocked.shares.length === 0 && blocked.state === 'error'
        },
        'the captive/blocked-relay fail-closed state',
        60_000,
      )
    } catch (error) {
      const status = await readBackgroundStatus(cdp)
      const states = adb(['logcat', '-d', '-s', 'ConstellationStatus:I', '*:S'])
        .split('\n')
        .map((line) => line.match(/stored=(starting|sharing|stopped|error|paused)/)?.[1])
        .filter(Boolean)
        .slice(-12)
      throw new Error(
        `Blocked relay status failed: ${JSON.stringify({
          state: status.state,
          peerStatus: status.peerStatus,
          shares: status.shares.length,
          requests: captive.requests.length,
          failureVisible: status.message === 'No reachable P2P address is available.',
          states,
        })}`,
        { cause: error },
      )
    }
    assert.ok(captive.requests.length > 0, 'the captive responder must see the relay attempt')
    assert.equal(blocked.message, 'No reachable P2P address is available.')
    assert.equal(
      (await readBackgroundStatus(cdp)).state,
      'error',
      'stopping a failed service must preserve its failure status',
    )
    console.log(
      `[android-test] captive/blocked relay failed closed: ${JSON.stringify({ state: blocked.state, message: blocked.message })}`,
    )
    await closeAndroidDialog(cdp)

    try {
      adb(['reverse', '--remove', 'tcp:9111'])
    } catch {
      // The captive mapping is already gone.
    }
    relay = await startLocalRelay()
    adb(['reverse', 'tcp:9111', 'tcp:9111'])
    const share = await startDirectBackgroundShare(cdp, null, { name: 'Captive recovery smoke' })
    assert.match(share.url, /#share=/)
    await waitFor(
      () =>
        adb(['shell', 'dumpsys', 'activity', 'services', packageName]).includes(
          'LocationShareService',
        ),
      'background sharing after the relay recovered',
      30_000,
    )
    console.log('[android-test] sharing recovered once the real relay was reachable.')

    adb(['reverse', '--remove', 'tcp:9111'])
    adb(['reverse', 'tcp:9111', 'tcp:9112'])
    await assert.rejects(
      startDirectBackgroundShare(cdp, null, {
        name: 'Blocked second share',
        expectedShareCount: 2,
      }),
      /Android native background share did not become ready/,
    )
    const failedSecond = await readBackgroundStatus(cdp)
    assert.equal(failedSecond.state, 'error')
    assert.equal(failedSecond.message, 'No reachable P2P address is available.')
    assert.deepEqual(
      failedSecond.shares.map((entry) => entry.shareId),
      [share.shareId],
    )

    adb(['reverse', '--remove', 'tcp:9111'])
    adb(['reverse', 'tcp:9111', 'tcp:9111'])
    const second = await startDirectBackgroundShare(cdp, null, {
      name: 'Active share retry smoke',
      expectedShareCount: 2,
    })
    const recovered = await readBackgroundStatus(cdp)
    assert.equal(recovered.shares.length, 2)
    assert.deepEqual(
      recovered.shares.map((entry) => entry.shareId).sort(),
      [share.shareId, second.shareId].sort(),
    )
    console.log(
      '[android-test] failed second creation retried once while preserving the first link.',
    )

    for (const active of [share, second]) {
      await cdp.evaluate(
        `window.__TAURI_INTERNALS__.invoke('android_stop_background_share', { shareId: ${JSON.stringify(active.shareId)} })`,
      )
    }
    await waitFor(
      async () => {
        const status = await readBackgroundStatus(cdp)
        return status.shares.length === 0 && status.endNotificationCount === 2
      },
      'both revoked links to retain their end notifications',
      30_000,
    )
    adb(['reverse', '--remove', 'tcp:9111'])
    adb(['reverse', 'tcp:9111', 'tcp:9112'])
    await assert.rejects(
      startDirectBackgroundShare(cdp, null, { name: 'Blocked create with notices' }),
      /Android native background share did not become ready/,
    )
    const noticeFailure = await readBackgroundStatus(cdp)
    assert.equal(
      noticeFailure.endNotificationCount,
      2,
      'creation failure must preserve end notices',
    )
    assert.equal(noticeFailure.oldSharing.length, 2, 'creation failure must preserve ended history')
    assert.equal(
      adb(['shell', 'dumpsys', 'activity', 'services', packageName]).includes(
        'LocationShareService',
      ),
      true,
      'creation failure must keep the revocation notice endpoints running',
    )
    console.log('[android-test] creation failure preserved both revocation notice endpoints.')
  } finally {
    responder?.close()
    relay?.kill('SIGTERM')
    try {
      adb(['reverse', '--remove', 'tcp:9111'])
    } catch {
      // Best-effort cleanup.
    }
    cdp?.close()
    adb(['shell', 'am', 'force-stop', packageName])
  }
}

const runMeteredPolicySmoke = async () => {
  let cdp
  let relay
  let alwaysShare
  let saverShare
  let foregroundShare
  try {
    relay = await startLocalRelay()
    adb(['reverse', 'tcp:9111', 'tcp:9111'])
    cdp = await setupNativeBackgroundSmoke()

    const wifiNetworkId = firstSavedWifiNetworkId()
    assert.ok(wifiNetworkId, 'the emulator must expose a synthetic Wi-Fi network')
    const setWifiMetered = (metered) => {
      try {
        adb(['shell', 'cmd', 'netpolicy', 'set', 'metered-network', wifiNetworkId, String(metered)])
      } catch {
        // The synthetic emulator returns a nonzero exit even when the value applies.
      }
    }
    const notificationDump = () => adb(['shell', 'dumpsys', 'notification', '--noredact'])
    const shareById = (status, shareId) => status.shares.find((share) => share.shareId === shareId)
    const waitForShare = async (label, check, timeout = 30_000) => {
      try {
        await waitFor(async () => check(await readPolicyStatus(cdp)), label, timeout)
      } catch (error) {
        const status = await readPolicyStatus(cdp).catch(() => undefined)
        throw new Error(`${label}: ${JSON.stringify(status)}`, { cause: error })
      }
    }

    alwaysShare = await startDirectBackgroundShare(cdp, null, {
      name: 'Always policy smoke A',
      battery: 'balanced',
      network: 'always',
    })
    saverShare = await startDirectBackgroundShare(cdp, null, {
      name: 'Metered policy smoke B',
      battery: 'saver',
      network: 'pause-when-metered',
      expectedShareCount: 2,
    })
    assert.equal(alwaysShare.battery, 'balanced')
    assert.equal(saverShare.battery, 'saver')
    assert.equal(saverShare.network, 'pause-when-metered')
    await waitForShare(
      'the strictest balanced sampling while the always link is active',
      (status) => status.sampling === 'balanced',
    )

    try {
      setWifiMetered(false)
      await waitForShare('the unmetered baseline', (status) => status.pauseReason === null)

      setWifiMetered(true)
      await waitForShare(
        'the per-link metered pause',
        (status) =>
          shareById(status, saverShare.shareId)?.paused === 'metered' &&
          shareById(status, alwaysShare.shareId)?.paused === null,
      )
      const meteredStatus = await readPolicyStatus(cdp)
      const pausedSaver = shareById(meteredStatus, saverShare.shareId)
      const alwaysBefore = shareById(meteredStatus, alwaysShare.shareId)
      assert.equal(meteredStatus.sampling, 'balanced', 'the always link keeps balanced sampling')
      assert.ok(
        notificationDump().includes('1 of 2 links paused on metered network'),
        'the notification must report the partial pause honestly',
      )
      adb(['emu', 'geo', 'fix', '-70.0301', '40.0301'])
      await waitForShare(
        'the always link to keep publishing while the metered link is paused',
        (status) => {
          const always = shareById(status, alwaysShare.shareId)
          const saver = shareById(status, saverShare.shareId)
          return (
            always?.paused === null &&
            typeof always?.lastUpdateAt === 'number' &&
            always.lastUpdateAt > (alwaysBefore?.lastUpdateAt ?? 0) &&
            saver?.paused === 'metered' &&
            saver?.lastUpdateAt === pausedSaver?.lastUpdateAt
          )
        },
        45_000,
      )

      setWifiMetered(false)
      await waitForShare(
        'the metered pause to clear for the opted-in link',
        (status) => shareById(status, saverShare.shareId)?.paused === null,
      )
      const resumedBefore = shareById(await readPolicyStatus(cdp), saverShare.shareId)?.lastUpdateAt
      adb(['emu', 'geo', 'fix', '-70.0401', '40.0401'])
      await waitForShare(
        'the resumed link to publish again',
        (status) => {
          const saver = shareById(status, saverShare.shareId)
          return (
            typeof saver?.lastUpdateAt === 'number' && saver.lastUpdateAt > (resumedBefore ?? 0)
          )
        },
        45_000,
      )
      const resumed = await readPolicyStatus(cdp)
      assert.equal(shareById(resumed, saverShare.shareId)?.shareId, saverShare.shareId)
      assert.equal(shareById(resumed, saverShare.shareId)?.expiresAt, null)
      assert.equal(notificationDump().includes('paused on metered network'), false)

      adb(['shell', 'cmd', 'netpolicy', 'set', 'restrict-background', 'true'])
      await waitForShare(
        'the per-link Data Saver pause',
        (status) =>
          shareById(status, saverShare.shareId)?.paused === 'data-saver' &&
          shareById(status, alwaysShare.shareId)?.paused === null,
      )
      const dataSaverStatus = await readPolicyStatus(cdp)
      assert.equal(dataSaverStatus.sampling, 'balanced')
      assert.ok(notificationDump().includes('1 of 2 links paused on Data Saver'))
      adb(['shell', 'cmd', 'netpolicy', 'set', 'restrict-background', 'false'])
      await waitForShare(
        'the Data Saver pause to clear',
        (status) => shareById(status, saverShare.shareId)?.paused === null,
      )
    } finally {
      try {
        adb(['shell', 'cmd', 'netpolicy', 'set', 'restrict-background', 'false'])
      } catch {
        // Best-effort policy cleanup.
      }
      try {
        adb(['shell', 'cmd', 'netpolicy', 'set', 'metered-network', wifiNetworkId, 'undefined'])
      } catch {
        // The emulator reports a nonzero exit for this reset even when it applies.
      }
    }

    await cdp.evaluate(
      `window.__TAURI_INTERNALS__.invoke('android_stop_background_share', { shareId: ${JSON.stringify(alwaysShare.shareId)} })`,
    )
    await waitForShare(
      'saver sampling once only the saver link remains',
      (status) => status.sampling === 'saver' && status.shares.length === 1,
    )

    foregroundShare = await startDirectBackgroundShare(cdp, null, {
      name: 'Foreground policy smoke C',
      publication: 'foreground',
      battery: 'saver',
      network: 'pause-when-metered',
      expectedShareCount: 2,
    })
    assert.equal(foregroundShare.battery, 'balanced')
    assert.equal(foregroundShare.network, 'always')
    setWifiMetered(true)
    await waitForShare(
      'the metered pause for the background saver link',
      (status) => shareById(status, saverShare.shareId)?.paused === 'metered',
    )
    const foregroundStatus = await readPolicyStatus(cdp)
    const foregroundBefore = shareById(foregroundStatus, foregroundShare.shareId)?.lastUpdateAt
    assert.equal(shareById(foregroundStatus, foregroundShare.shareId)?.paused, null)
    adb(['emu', 'geo', 'fix', '-70.0501', '40.0501'])
    await waitForShare(
      'the foreground-only link to keep publishing on metered',
      (status) => {
        const foreground = shareById(status, foregroundShare.shareId)
        return (
          foreground?.paused === null &&
          typeof foreground?.lastUpdateAt === 'number' &&
          foreground.lastUpdateAt > (foregroundBefore ?? 0)
        )
      },
      45_000,
    )
    setWifiMetered(false)

    console.log('[android-test] per-link metered policy paused only the opted-in link.')
  } finally {
    try {
      adb(['shell', 'cmd', 'netpolicy', 'set', 'restrict-background', 'false'])
    } catch {
      // Best-effort cleanup after policy emulation.
    }
    for (const share of [foregroundShare, saverShare, alwaysShare]) {
      if (!share) continue
      try {
        await cdp?.evaluate(
          `window.__TAURI_INTERNALS__?.invoke('android_stop_background_share', { shareId: ${JSON.stringify(share.shareId)} })`,
        )
      } catch {
        // The debugger may already be gone after the policy smoke.
      }
    }
    relay?.kill('SIGTERM')
    try {
      adb(['reverse', '--remove', 'tcp:9111'])
    } catch {
      // Best-effort cleanup.
    }
    cdp?.close()
    adb(['shell', 'am', 'force-stop', packageName])
  }
}

const runRestrictedStartSmoke = async () => {
  let cdp
  let relay
  let alwaysShare
  let saverShare
  const processPid = () => {
    try {
      return adb(['shell', 'pidof', packageName]).trim().split(/\s+/)[0] ?? ''
    } catch {
      return ''
    }
  }
  try {
    relay = await startLocalRelay()
    adb(['reverse', 'tcp:9111', 'tcp:9111'])
    cdp = await setupNativeBackgroundSmoke()

    const wifiNetworkId = firstSavedWifiNetworkId()
    assert.ok(wifiNetworkId, 'the emulator must expose a synthetic Wi-Fi network')
    const setWifiMetered = (metered) => {
      try {
        adb(['shell', 'cmd', 'netpolicy', 'set', 'metered-network', wifiNetworkId, String(metered)])
      } catch {
        // The synthetic emulator returns a nonzero exit even when the value applies.
      }
    }
    const shareById = (status, shareId) => status.shares.find((share) => share.shareId === shareId)
    const waitForShare = async (label, check, timeout = 30_000) => {
      try {
        await waitFor(async () => check(await readPolicyStatus(cdp)), label, timeout)
      } catch (error) {
        const status = await readPolicyStatus(cdp).catch(() => undefined)
        throw new Error(`${label}: ${JSON.stringify(status)}`, { cause: error })
      }
    }

    try {
      setWifiMetered(true)
      alwaysShare = await startDirectBackgroundShare(cdp, null, {
        name: 'Restricted start always A',
        battery: 'balanced',
        network: 'always',
      })
      saverShare = await startDirectBackgroundShare(cdp, null, {
        name: 'Restricted start pause B',
        battery: 'saver',
        network: 'pause-when-metered',
        expectedShareCount: 2,
      })
      await waitForShare(
        'the pause link to fail closed while the restriction is already active',
        (status) =>
          shareById(status, saverShare.shareId)?.paused === 'metered' &&
          shareById(status, alwaysShare.shareId)?.paused === null,
      )
      assert.equal(
        shareById(await readPolicyStatus(cdp), saverShare.shareId)?.lastUpdateAt,
        null,
        'a restricted pause link must not publish before its policy is applied',
      )
      adb(['emu', 'geo', 'fix', '-70.0601', '40.0601'])
      await waitForShare(
        'the always link to publish under the same restriction',
        (status) => typeof shareById(status, alwaysShare.shareId)?.lastUpdateAt === 'number',
        45_000,
      )
      assert.equal(
        shareById(await readPolicyStatus(cdp), saverShare.shareId)?.lastUpdateAt,
        null,
        'the restricted pause link must stay unpublished',
      )

      cdp.close()
      cdp = undefined
      const originalPid = processPid()
      assert.match(originalPid, /^\d+$/)
      adb(['shell', 'cmd', 'activity', 'crash', packageName])
      let restartedPid = ''
      await waitFor(
        () => {
          restartedPid = processPid()
          return (
            /^\d+$/.test(restartedPid) &&
            restartedPid !== originalPid &&
            adb(['shell', 'dumpsys', 'activity', 'services', packageName]).includes(
              'LocationShareService',
            )
          )
        },
        'START_STICKY recovery while the restriction is active',
        45_000,
      )

      adb(['shell', 'am', 'start', '-n', `${packageName}/.MainActivity`])
      cdp = undefined
      for (let attempt = 0; attempt < 8 && !cdp; attempt += 1) {
        let candidate
        try {
          candidate = await connectCdp()
          const responsive = await Promise.race([
            candidate.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`),
            wait(5_000).then(() => false),
          ])
          if (responsive) {
            cdp = candidate
            break
          }
        } catch {
          // Process recovery can briefly leave a stale WebView target behind.
        }
        candidate?.close()
        await wait(1_000)
      }
      if (!cdp) throw new Error('Tauri bridge did not stabilize after restricted restart.')

      await waitForShare(
        'the restored pause link to remain unpublished while restricted',
        (status) =>
          shareById(status, saverShare.shareId)?.paused === 'metered' &&
          shareById(status, saverShare.shareId)?.lastUpdateAt === null,
        60_000,
      )
      adb(['emu', 'geo', 'fix', '-70.0701', '40.0701'])
      await waitForShare(
        'the restored always link to publish',
        (status) => typeof shareById(status, alwaysShare.shareId)?.lastUpdateAt === 'number',
        45_000,
      )
      assert.equal(
        shareById(await readPolicyStatus(cdp), saverShare.shareId)?.lastUpdateAt,
        null,
        'the restored pause link must stay unpublished',
      )
      console.log('[android-test] restricted start and restart kept the opted-in link unpublished.')
    } finally {
      try {
        adb(['shell', 'cmd', 'netpolicy', 'set', 'metered-network', wifiNetworkId, 'undefined'])
      } catch {
        // The emulator reports a nonzero exit for this reset even when it applies.
      }
    }
  } finally {
    for (const share of [saverShare, alwaysShare]) {
      if (!share) continue
      try {
        await cdp?.evaluate(
          `window.__TAURI_INTERNALS__?.invoke('android_stop_background_share', { shareId: ${JSON.stringify(share.shareId)} })`,
        )
      } catch {
        // The debugger may already be gone after the restart smoke.
      }
    }
    relay?.kill('SIGTERM')
    try {
      adb(['reverse', '--remove', 'tcp:9111'])
    } catch {
      // Best-effort cleanup.
    }
    cdp?.close()
    adb(['shell', 'am', 'force-stop', packageName])
  }
}

const describeInvitationAddresses = (viewer, shareUrl) =>
  viewer.evaluate(async (url) => {
    const { parseShareInvitation } = await import('/src/sharing/shareLink.ts')
    return parseShareInvitation(url, 0).addresses.map((address) =>
      address.includes('/webrtc') ? 'WebRTC relay' : 'circuit relay',
    )
  }, shareUrl)

const verifyBrowserRevocation = async (viewer, cdp) => {
  try {
    await viewer.getByRole('button', { name: 'Seeing 0' }).waitFor({ timeout: 15_000 })
  } catch (error) {
    throw new Error(
      `Revocation delivery failed: ${JSON.stringify({
        source: await readBackgroundTransportSummary(cdp),
        viewerStillFollowing: await viewer.getByRole('button', { name: 'Seeing 1' }).isVisible(),
        viewerOnline: await viewer.getByText('P2P online').isVisible(),
      })}`,
      { cause: error },
    )
  }
  const openSheet = viewer.getByRole('dialog')
  if (await openSheet.isVisible()) {
    await openSheet.getByRole('button', { name: 'Close', exact: true }).click()
  }
  await viewer.getByRole('button', { name: 'Seeing 0' }).click()
  const history = viewer.getByRole('dialog', { name: 'Following' })
  await history.getByText('Old seeing shares (1)').waitFor()
  await history.getByText('Old seeing shares (1)').click()
  await history.getByText('Revoked by sender').waitFor()
  assert.equal(await history.getByRole('button', { name: 'Show on map' }).count(), 0)
}

const verifyNativeAutomaticReturn = async (cdp, browser, shareUrl) => {
  const context = await browser.newContext({
    geolocation: { latitude: 40.0003, longitude: -70.0003 },
    permissions: ['geolocation'],
  })
  try {
    const peer = await context.newPage()
    await peer.goto(`http://127.0.0.1:4173/${new URL(shareUrl).hash}`, {
      waitUntil: 'domcontentloaded',
    })
    await peer.getByRole('button', { name: 'Keep following' }).click({ timeout: 30_000 })
    await peer.getByRole('button', { name: 'Save location' }).click()
    await peer.getByRole('button', { name: 'Share approximate location for 1 hour' }).click()
    await waitFor(
      () => androidTextIncludes(cdp, 'Seeing 2'),
      'an automatically accepted second return',
      30_000,
    )
    await waitFor(
      async () => (await readBackgroundStatus(cdp)).returnOfferCount === 0,
      'the acknowledged second return offer',
      30_000,
    )
    assert.equal(
      await androidTextIncludes(cdp, 'A viewer wants to share their location back'),
      false,
    )
    assert.equal(await clickButton(cdp, 'Seeing 2'), true)
    await waitFor(
      async () => (await androidButtonCount(cdp, 'Show on map')) === 2,
      'both returned locations',
      30_000,
    )
    assert.equal(await androidTextIncludes(cdp, 'Share approximate location for 1 hour'), false)
    assert.equal(await closeAndroidDialog(cdp), true)
  } finally {
    await context.close()
  }
  await waitFor(
    async () => (await readBackgroundTransportSummary(cdp)).viewerCount === 1,
    'the temporary second viewer to leave the original share',
    30_000,
  )
  console.log(
    '[android-test] same-link group accepted a second return without another prompt or viewer loop',
  )
}

const runShareFlow = async (cdp, browser, options = {}) => {
  console.log('[android-test] creating background share')
  await waitFor(
    () =>
      cdp.evaluate(`Boolean(
        document.querySelector('button[aria-label="Share location"]') ||
        document.querySelector('button[aria-label="Show sharing actions"]')
      )`),
    'Android sharing controls',
    30_000,
  )
  const shareActionVisible = await cdp.evaluate(
    `Boolean(document.querySelector('button[aria-label="Share location"]'))`,
  )
  if (!shareActionVisible) {
    assert.equal(await clickAriaButton(cdp, 'Show sharing actions'), true)
    await waitFor(
      () => cdp.evaluate(`Boolean(document.querySelector('button[aria-label="Share location"]'))`),
      'expanded Android share action',
    )
  }
  assert.equal(await clickAriaButton(cdp, 'Share location'), true)
  assert.equal(await clickButton(cdp, 'In background'), true)
  assert.equal(await clickButton(cdp, '10'), true)
  await waitFor(
    () =>
      cdp.evaluate(`([...document.querySelectorAll('button')].some(button =>
      button.textContent?.trim() === 'Create private link' && !button.disabled))`),
    'enabled Android Create private link action',
    30_000,
  )
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
    await wait(1_000)
    const state = await cdp.evaluate(`(() => {
      const buttons = [...document.querySelectorAll('button')];
      const createButton = buttons.find((button) => button.textContent && button.textContent.includes('Create private link'));
      return {
        backgroundSelected: buttons
          .some((button) => button.textContent && button.textContent.includes('In background') && button.getAttribute('aria-pressed') === 'true'),
        shareDialogVisible: Boolean(document.querySelector('[aria-labelledby="share-title"]')),
        createButtonDisabled: Boolean(createButton && createButton.disabled),
        createButtonText: createButton ? createButton.textContent.trim() : '',
        status: document.querySelector('.toast') ? document.querySelector('.toast').textContent.trim() : '',
        connecting: document.body && document.body.innerText.includes('Connecting to the P2P network'),
        noReachablePeer: document.body && document.body.innerText.includes('No reachable P2P address'),
        createFailed: document.body?.innerText?.includes('Could not create the location link.') === true,
        permissionDenied: document.body && document.body.innerText.includes('Location permission denied'),
        backgroundStarting: document.body && document.body.innerText.includes('Starting private P2P sharing'),
      };
    })()`)
    const nativeSerialized = await cdp.evaluate(`(async () => {
      try {
        const invoke = window.__TAURI_INTERNALS__?.invoke;
        if (!invoke) return JSON.stringify({ error: 'bridge unavailable' });
        const status = await invoke('android_background_share_status');
        return JSON.stringify({
          state: status.state,
          peerStatus: status.peerStatus ?? '',
          shares: status.shares?.length ?? 0,
          message: status.message ?? '',
        });
      } catch (nativeError) {
        return JSON.stringify({ error: String(nativeError) });
      }
    })()`)
    const nativeState =
      typeof nativeSerialized === 'string'
        ? JSON.parse(nativeSerialized)
        : { error: 'invalid CDP value' }
    throw new Error(
      `Android share link unavailable. UI state: ${JSON.stringify(state)}; native state: ${JSON.stringify(nativeState)}; IPC markers: ${JSON.stringify(cdp.ipcTrace())}`,
      { cause: error },
    )
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
      `No location reached the browser. Address forms: ${JSON.stringify(await describeInvitationAddresses(viewer, shareUrl))}; Browser state: ${JSON.stringify(browserState)}; Android state: ${JSON.stringify(androidState)}`,
      { cause: error },
    )
  }
  await viewer.getByRole('button', { name: 'Show on map' }).click()
  await viewer.getByRole('button', { name: 'Open menu' }).click()
  await viewer.getByRole('button', { name: 'Following (1)' }).click()
  const updatesBeforeLock = await receivedUpdateCount(viewer)
  console.log('[android-test] checking locked-screen update')
  adb(['shell', 'input', 'keyevent', 'KEYCODE_SLEEP'])
  let lockedUpdateError
  try {
    adb(['emu', 'geo', 'fix', '-70.0101', '40.0101'])
    await waitFor(
      async () => (await receivedUpdateCount(viewer)) > updatesBeforeLock,
      'a location update while the Android screen is locked',
      45_000,
    )
  } catch (error) {
    lockedUpdateError = error
  } finally {
    adb(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'])
    adb(['shell', 'input', 'keyevent', 'KEYCODE_MENU'])
  }
  if (lockedUpdateError) {
    const transport = await readBackgroundTransportSummary(cdp)
    const policy = await readPolicyStatus(cdp)
    throw new Error(
      `Locked-screen delivery failed: ${JSON.stringify({
        transport,
        capturedAt: policy.capturedAt,
        sequence: policy.sequence,
        pauseReason: policy.pauseReason,
        sampling: policy.sampling,
        updatesBeforeLock,
        updatesAfterLock: await receivedUpdateCount(viewer),
        idleState: adb(['shell', 'dumpsys', 'deviceidle']).match(/mState=(\w+)/)?.[1] ?? '',
      })}`,
      { cause: lockedUpdateError },
    )
  }
  console.log('[android-test] checking debugger after wake')
  await cdp.evaluate('document.readyState')
  await viewer
    .getByRole('dialog', { name: 'Following' })
    .getByRole('button', { name: 'Close' })
    .click()
  await viewer.getByRole('button', { name: 'Keep following' }).click()
  await viewer.getByRole('button', { name: 'Save location' }).click()
  await viewer.getByRole('button', { name: 'Share approximate location for 1 hour' }).click()
  console.log('[android-test] checking return offer')
  adb(['shell', 'am', 'start', '-n', `${packageName}/.MainActivity`])
  await waitFor(
    () => androidTextIncludes(cdp, 'A viewer wants to share their location back'),
    'the private return offer in Android',
    30_000,
  )
  assert.equal(await clickButton(cdp, 'Accept this and future shares from this link'), true)
  try {
    await waitFor(() => androidTextIncludes(cdp, 'Seeing 1'), 'Android return viewer', 75_000)
  } catch (error) {
    const ui = await cdp.evaluate(`(() => {
      const text = document.body.innerText;
      const errors = [
        'This return link was not created by the connected viewer.',
        'This return location link has ended.',
        'Already following this link.',
        'Protected storage is not configured; preview only.',
        'Could not accept this return link.',
      ];
      return {
        seeing: text.match(/Seeing (\\d+)/)?.[1] ?? null,
        accepting: [...document.querySelectorAll('button')].some(button =>
          button.textContent?.includes('Accept this and future') && button.disabled),
        errors: errors.filter(error => text.includes(error)),
      };
    })()`)
    throw new Error(
      `Return acceptance failed: ${JSON.stringify({
        ui,
        source: await readBackgroundTransportSummary(cdp),
        pendingOffers: (await readBackgroundStatus(cdp)).returnOfferCount,
      })}`,
      { cause: error },
    )
  }
  await waitFor(
    async () => (await readBackgroundStatus(cdp)).returnOfferCount === 0,
    'the background source to finish accepting the return offer',
    30_000,
  )
  assert.equal(await androidTextIncludes(cdp, 'Someone shared their location with you'), false)
  assert.equal(await androidTextIncludes(cdp, 'Keep following'), false)
  assert.equal(await androidTextIncludes(cdp, 'Save location'), false)
  assert.equal(await clickButton(cdp, 'Seeing 1'), true)
  await waitFor(() => androidTextIncludes(cdp, 'Show on map'), 'the return location', 30_000)
  assert.equal(await androidTextIncludes(cdp, 'Share approximate location for 1 hour'), false)
  assert.equal(await closeAndroidDialog(cdp), true)
  await verifyNativeAutomaticReturn(cdp, browser, shareUrl)
  assert.equal(await clickButton(cdp, 'Sharing 1'), true)
  await waitFor(() => androidTextIncludes(cdp, '1 connected'), 'Android viewer presence', 30_000)
  if (options.skipProcessRestart) {
    assert.equal(await clickButton(cdp, 'Revoke link'), true)
    await verifyBrowserRevocation(viewer, cdp)
    await viewerContext.close()
    return cdp
  }
  cdp.close()
  console.log('[android-test] checking process restart')
  adb(['shell', 'am', 'force-stop', packageName])
  adb(['shell', 'am', 'start', '-n', `${packageName}/.MainActivity`])
  cdp = undefined
  for (let attempt = 0; attempt < 8 && !cdp; attempt += 1) {
    let candidate
    try {
      candidate = await connectCdp()
      await wait(500)
      const responsive = await Promise.race([
        androidTextIncludes(candidate, 'Sharing 1'),
        wait(5_000).then(() => false),
      ])
      if (responsive) {
        cdp = candidate
        break
      }
    } catch {
      // Process restart may expose a stale WebView debugger target before the new UI settles.
    }
    candidate?.close()
    await wait(1_000)
  }
  if (!cdp) throw new Error('Android share UI did not stabilize after process restart.')
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
  await verifyBrowserRevocation(viewer, cdp)
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

  if (process.argv.includes('--notification-stop-smoke')) {
    await runNotificationStopSmoke()
    console.log('Android notification Stop sharing action stopped the foreground service.')
    return
  }
  if (process.argv.includes('--permission-denial-smoke')) {
    await runPermissionDenialSmoke()
    console.log('Android permission denial failed closed without starting background sharing.')
    return
  }

  if (process.argv.includes('--expiry-smoke')) {
    await runExpirySmoke()
    console.log(
      'Android expiry stopped location collection, retained notices, and honored Stop notices.',
    )
    return
  }
  if (process.argv.includes('--reboot-prepare-smoke')) {
    await runRebootPrepareSmoke()
    return
  }
  if (process.argv.includes('--reboot-verify-smoke')) {
    await runRebootVerifySmoke()
    return
  }
  if (process.argv.includes('--service-restart-smoke')) {
    await runServiceRestartSmoke()
    console.log('Android START_STICKY service recovered protected sharing after process death.')
    return
  }
  if (process.argv.includes('--foreground-only-smoke')) {
    await runForegroundOnlySmoke()
    console.log(
      'Android foreground-only sharing paused while hidden and resumed with the same link.',
    )
    return
  }
  if (process.argv.includes('--multiple-source-links-smoke')) {
    await runMultipleSourceLinksSmoke()
    console.log('Android independently revoked one of two simultaneous source links.')
    return
  }
  if (process.argv.includes('--power-network-smoke')) {
    await runPowerNetworkSmoke()
    console.log('Android active share survived Doze/power saver and network loss/recovery.')
    return
  }
  if (process.argv.includes('--direct-transport-smoke')) {
    await runDirectTransportSmoke()
    console.log('Android classified a direct transport and kept sharing after relay shutdown.')
    return
  }
  if (process.argv.includes('--captive-transport-smoke')) {
    await runCaptiveTransportSmoke()
    console.log('Android failed closed behind a captive relay and recovered with the real relay.')
    return
  }
  if (process.argv.includes('--metered-policy-smoke')) {
    await runMeteredPolicySmoke()
    console.log('Android metered/Data Saver policy paused and resumed with the share intact.')
    return
  }
  if (process.argv.includes('--restricted-start-smoke')) {
    await runRestrictedStartSmoke()
    console.log('Android applied the network restriction before any restricted share published.')
    return
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
  if (process.argv.includes('--native-fallback-smoke')) {
    let cdp
    const removeMockProviders = () => {
      for (const provider of ['gps', 'network']) {
        try {
          adb(['shell', 'cmd', 'location', 'providers', 'remove-test-provider', provider])
        } catch {
          // Provider may already be the platform implementation.
        }
      }
      try {
        adb(['shell', 'appops', 'set', '2000', 'android:mock_location', 'deny'])
      } catch {
        // Emulator cleanup is best-effort.
      }
    }
    try {
      adb(['shell', 'pm', 'clear', packageName])
      adb(['shell', 'appops', 'set', '2000', 'android:mock_location', 'allow'])
      for (const [provider, capability] of [
        ['gps', '--requiresSatellite'],
        ['network', '--requiresNetwork'],
      ]) {
        try {
          adb(['shell', 'cmd', 'location', 'providers', 'remove-test-provider', provider])
        } catch {
          // Start from the platform provider if no mock override exists yet.
        }
        adb(['shell', 'cmd', 'location', 'providers', 'add-test-provider', provider, capability])
        adb([
          'shell',
          'cmd',
          'location',
          'providers',
          'set-test-provider-enabled',
          provider,
          'true',
        ])
      }
      grantIfSupported('android.permission.ACCESS_FINE_LOCATION')
      adb(['shell', 'am', 'start', '-n', `${packageName}/.MainActivity`])
      cdp = await connectCdp()
      await cdp.installOnNewDocument(`(() => {
        const probe = { webWatchCalls: 0, injectError: '' };
        Object.defineProperty(window, '__constellationFallbackProbe', {
          configurable: true,
          value: probe,
        });
        try {
          const geolocation = navigator.geolocation;
          const prototype = geolocation && Object.getPrototypeOf(geolocation);
          if (!prototype || typeof prototype.watchPosition !== 'function') {
            probe.injectError = 'WebView geolocation watchPosition is unavailable.';
            return;
          }
          const original = prototype.watchPosition;
          Object.defineProperty(prototype, 'watchPosition', {
            configurable: true,
            writable: true,
            value: function(...args) {
              probe.webWatchCalls += 1;
              return original.apply(this, args);
            },
          });
        } catch (error) {
          probe.injectError = String(error);
        }
      })()`)
      const fallbackStart = Date.now()
      await cdp.reload()
      await waitFor(
        () => androidTextIncludes(cdp, 'Share location'),
        'Android fallback smoke reload',
      )
      await waitFor(
        () => adb(['shell', 'dumpsys', 'location']).includes(packageName),
        'native Android location watch registration with no first fix',
        15_000,
      )
      let probe
      try {
        await waitFor(
          async () => {
            probe = await cdp.evaluate(`window.__constellationFallbackProbe ? ({
              webWatchCalls: window.__constellationFallbackProbe.webWatchCalls,
              injectError: window.__constellationFallbackProbe.injectError,
            }) : null`)
            if (probe?.injectError) throw new Error(probe.injectError)
            return probe?.webWatchCalls >= 1
          },
          'twenty-second native no-fix timeout to hand off to WebView geolocation',
          35_000,
        )
      } catch (error) {
        throw new Error(
          `Android native fallback probe did not complete: ${JSON.stringify(probe)}`,
          {
            cause: error,
          },
        )
      }
      assert.ok(Date.now() - fallbackStart >= 18_000)
      assert.ok(probe.webWatchCalls >= 1)
    } finally {
      cdp?.close()
      adb(['shell', 'am', 'force-stop', packageName])
      removeMockProviders()
    }
    console.log('Android native no-fix timeout handed off to WebView geolocation.')
    return
  }
  if (process.argv.includes('--ui-policy-smoke')) {
    let cdp
    try {
      adb(['shell', 'pm', 'clear', packageName])
      grantIfSupported('android.permission.ACCESS_FINE_LOCATION')
      adb(['shell', 'am', 'start', '-n', `${packageName}/.MainActivity`])
      cdp = await connectCdp()
      await waitFor(
        () => androidTextIncludes(cdp, 'Share location'),
        'Android UI policy smoke startup',
      )
      const intro = await cdp.evaluate(
        `document.querySelector('[aria-label="Privacy introduction"]')?.textContent ?? ''`,
      )
      assert.match(intro, /Direct when possible\. Encrypted between peers\./)
      assert.match(intro, /end-to-end encrypted P2P connections/)
      assert.match(intro, /no central location history/)
      assert.equal(await clickButton(cdp, 'How it works'), true)
      await waitFor(
        () => androidTextIncludes(cdp, 'Privacy and network'),
        'Android About privacy copy',
      )
      const about = await cdp.evaluate(
        `document.querySelector('[aria-labelledby="about-title"]')?.textContent ?? ''`,
      )
      assert.match(about, /relays cannot read location content/i)
      assert.match(about, /configured relay for reachability/i)
      assert.match(about, /private share settings and followed links may be stored encrypted/i)
      assert.match(about, /captive portal that blocks access/i)
      assert.match(about, /network that blocks every available outbound transport/i)
      assert.equal(await closeAndroidDialog(cdp), true)
      assert.equal(await clickButton(cdp, 'Got it'), true)
      assert.equal(await clickAriaButton(cdp, 'Open menu'), true)
      assert.equal(await tapAndroidButton(cdp, 'Copy logs'), true)
      await waitFor(
        () => androidTextIncludes(cdp, 'Copied logs to clipboard.'),
        'Android diagnostics clipboard notice',
      )
      assert.equal(await androidTextIncludes(cdp, 'Could not copy logs to the clipboard.'), false)
    } finally {
      cdp?.close()
      adb(['shell', 'am', 'force-stop', packageName])
    }
    console.log('Android privacy/About presentation and diagnostics clipboard behavior passed.')
    return
  }
  if (process.argv.includes('--native-location-smoke')) {
    let cdp
    let nextFix
    try {
      adb(['shell', 'pm', 'clear', packageName])
      adb(['emu', 'geo', 'fix', '-70.0000', '40.0000'])
      grantIfSupported('android.permission.ACCESS_FINE_LOCATION')
      adb(['shell', 'am', 'start', '-n', `${packageName}/.MainActivity`])
      cdp = undefined
      for (let attempt = 0; attempt < 4 && !cdp; attempt += 1) {
        let candidate
        try {
          candidate = await connectCdp()
          await wait(750)
          if (await androidTextIncludes(candidate, 'Share location')) {
            cdp = candidate
            break
          }
        } catch {
          // Older WebViews may be replaced once while the Activity settles.
        }
        candidate?.close()
        await wait(1_000)
      }
      if (!cdp) throw new Error('Android app startup did not stabilize for native location smoke.')
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
  let relay
  let cdp
  let browser
  try {
    if (process.argv.includes('--local-share-flow')) {
      relay = await startLocalRelay()
      adb(['reverse', 'tcp:9111', 'tcp:9111'])
    }
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
    cdp = await runShareFlow(cdp, browser, {
      skipProcessRestart: process.argv.includes('--no-gms-flow'),
    })
    console.log('Android P2P sharing, process recovery, and shared-text intake passed.')
  } finally {
    await browser?.close()
    cdp?.close()
    server?.kill('SIGTERM')
    relay?.kill('SIGTERM')
    if (relay) adb(['reverse', '--remove', 'tcp:9111'])
    adb(['shell', 'am', 'force-stop', packageName])
  }
}

main().catch((error) => {
  console.error(
    redactAndroidTestError(error instanceof Error ? (error.stack ?? error.message) : String(error)),
  )
  process.exitCode = 1
})
