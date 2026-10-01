import assert from 'node:assert/strict'
import fs from 'node:fs'

const readJson = (path) => JSON.parse(fs.readFileSync(path, 'utf8'))
const tauri = readJson('src-tauri/tauri.conf.json')
const capability = readJson('src-tauri/capabilities/mobile.json')
const iosCapability = readJson('src-tauri/capabilities/ios.json')
const desktopCapability = readJson('src-tauri/capabilities/desktop.json')
const viteConfig = fs.readFileSync('vite.config.ts', 'utf8')
const indexHtml = fs.readFileSync('index.html', 'utf8')
const legacyCompat = fs.readFileSync('public/legacy-compat.js', 'utf8')
const pmtilesRuntime = fs.readFileSync('src/map/pmtiles.ts', 'utf8')
const backgroundViteConfig = fs.readFileSync('vite.background.config.ts', 'utf8')
const cargo = fs.readFileSync('src-tauri/Cargo.toml', 'utf8')
const manifest = fs.readFileSync('src-tauri/gen/android/app/src/main/AndroidManifest.xml', 'utf8')
const serviceManifest = fs.readFileSync(
  'src-tauri/plugins/constellation-android/android/src/main/AndroidManifest.xml',
  'utf8',
)
const androidPlugin = fs.readFileSync(
  'src-tauri/plugins/constellation-android/android/src/main/java/space/taskyon/constellation/plugin/ConstellationAndroidPlugin.kt',
  'utf8',
)
const locationService = fs.readFileSync(
  'src-tauri/plugins/constellation-android/android/src/main/java/space/taskyon/constellation/plugin/LocationShareService.kt',
  'utf8',
)
const shareNotification = fs.readFileSync(
  'src-tauri/plugins/constellation-android/android/src/main/java/space/taskyon/constellation/plugin/ShareNotification.kt',
  'utf8',
)
const locationAccess = fs.readFileSync(
  'src-tauri/plugins/constellation-android/android/src/main/java/space/taskyon/constellation/plugin/AndroidLocationAccess.kt',
  'utf8',
)
const backgroundEntry = fs.readFileSync('src/android/backgroundEntry.ts', 'utf8')
const backgroundGradle = fs.readFileSync(
  'src-tauri/plugins/constellation-android/android/build.gradle.kts',
  'utf8',
)
const mobileBridge = fs.readFileSync(
  'src-tauri/plugins/constellation-android/src/mobile.rs',
  'utf8',
)
const tauriCommands = fs.readFileSync('src-tauri/src/lib.rs', 'utf8')

assert.equal(tauri.identifier, 'space.taskyon.constellation')
assert.equal(tauri.bundle.android.minSdkVersion, 29)
assert.match(viteConfig, /target:\s*mode === 'tauri' \? 'es2019' : 'es2022'/)
assert.ok(
  indexHtml.indexOf('/legacy-compat.js') < indexHtml.indexOf('/src/main.ts'),
  'legacy compatibility script must load before the module bundle',
)
assert.match(legacyCompat, /Object\.prototype\.hasOwnProperty\.call/)
assert.match(pmtilesRuntime, /maplibre-gl-csp-worker\.js\?worker&url/)
assert.match(pmtilesRuntime, /legacy-compat\.js/)
assert.match(pmtilesRuntime, /importScripts/)
assert.match(backgroundViteConfig, /target:\s*'chrome74'/)
assert.match(backgroundViteConfig, /legacy-compat\.js/)
assert.match(backgroundViteConfig, /banner/)
assert.match(backgroundViteConfig, /\\n;`/)
assert.match(
  backgroundGradle,
  /inputs\.file\(workspaceRoot\.resolve\("public\/legacy-compat\.js"\)\)/,
)
assert.deepEqual(tauri.plugins['deep-link'].mobile, [
  {
    scheme: ['https'],
    host: 'constellation.taskyon.space',
    pathPrefix: ['/'],
    appLink: true,
  },
])
assert.equal(capability.platforms.includes('android'), true)
assert.deepEqual(iosCapability.platforms, ['iOS'])
assert.equal(tauri.app.security.capabilities.includes('desktop'), true)
assert.equal(desktopCapability.platforms.includes('linux'), true)
assert.equal(desktopCapability.permissions.includes('core:default'), true)
assert.equal(capability.permissions.includes('deep-link:default'), true)
assert.equal(
  capability.permissions.some((permission) => permission.startsWith('geolocation:')),
  false,
)
assert.equal(iosCapability.permissions.includes('geolocation:allow-watch-position'), true)
assert.match(cargo, /tauri-plugin-deep-link = "=2\.4\.10"/)
assert.match(
  cargo,
  /\[target\.'cfg\(target_os = "ios"\)'\.dependencies\]\s+tauri-plugin-geolocation = "=2\.3\.3"/,
)
assert.doesNotMatch(cargo, /\[patch\.crates-io\]/)
assert.match(cargo, /tauri-plugin-constellation-android/)
for (const permission of [
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  'android.permission.FOREGROUND_SERVICE_LOCATION',
  'android.permission.POST_NOTIFICATIONS',
]) {
  assert.match(manifest, new RegExp(permission))
}
assert.match(serviceManifest, /android:foregroundServiceType="location"/)
assert.match(manifest, /android\.intent\.action\.SEND/)
assert.match(manifest, /android:mimeType="text\/plain"/)
assert.match(androidPlugin, /fun takeSharedText\(invoke: Invoke\)/)
assert.match(androidPlugin, /fun loadPrivateState\(invoke: Invoke\)/)
assert.match(androidPlugin, /fun savePrivateState\(invoke: Invoke\)/)
assert.match(androidPlugin, /fun blockBackgroundViewer\(invoke: Invoke\)/)
assert.match(androidPlugin, /fun locationPermission\(invoke: Invoke\)/)
assert.match(androidPlugin, /fun requestLocationPermission\(invoke: Invoke\)/)
assert.match(androidPlugin, /fun startLocationWatch\(invoke: Invoke\)/)
assert.match(androidPlugin, /fun stopLocationWatch\(invoke: Invoke\)/)
assert.match(androidPlugin, /fun currentLocation\(invoke: Invoke\)/)
assert.match(androidPlugin, /invoke\.resolve\(JSObject\(\)\.put\("watchId",/)
assert.match(shareNotification, /ACTION_BLOCK_VIEWER/)
assert.match(locationService, /"block-viewer"/)
assert.match(backgroundEntry, /runtime\.blockViewer\(command\.shareId, command\.fingerprint\)/)
assert.match(
  backgroundGradle,
  /inputs\.property\("relayAddresses", providers\.environmentVariable\("VITE_CONSTELLATION_RELAY_ADDRS"\)/,
)
assert.match(mobileBridge, /"blockBackgroundViewer"/)
assert.ok(
  mobileBridge.includes('run_mobile_plugin_async'),
  'Android plugin calls must use the asynchronous Tauri bridge',
)
assert.ok(!tauriCommands.includes('run_blocking_native'), 'Android commands must not block workers')
assert.match(tauriCommands, /android_block_background_viewer/)
assert.doesNotMatch(manifest, /FOREGROUND_SERVICE_DATA_SYNC/)
assert.match(serviceManifest, /android:stopWithTask="false"/)
assert.match(androidPlugin, /requireNotificationPermission\(\)/)
assert.match(androidPlugin, /Allow notifications, then create the share again\./)
assert.doesNotMatch(androidPlugin, /getRunningServices/)
assert.match(androidPlugin, /ShareServiceContract\.serviceRunning/)
assert.match(locationService, /ShareServiceContract\.serviceRunning = true/)
assert.match(locationService, /ShareServiceContract\.serviceRunning = false/)
assert.match(androidPlugin, /ShareServiceContract\.startPending = true/)
assert.match(androidPlugin, /ShareServiceContract\.startPending && !running/)
assert.match(locationService, /ShareServiceContract\.startPending = false/)
assert.doesNotMatch(androidPlugin, /requestNotificationPermission\(\)/)
assert.match(locationAccess, /fun androidLocationListener/)
assert.match(locationAccess, /override fun onProviderDisabled/)
assert.match(locationAccess, /override fun onProviderEnabled/)
assert.match(locationAccess, /override fun onStatusChanged/)
assert.doesNotMatch(androidPlugin, /object\s*:\s*LocationListener/)
assert.doesNotMatch(locationService, /object\s*:\s*LocationListener/)
assert.match(locationService, /BALANCED_UPDATE_INTERVAL_MS = 5_000L/)
assert.match(locationService, /BALANCED_UPDATE_MINIMUM_DISTANCE_METRES = 5f/)
assert.match(locationService, /SAVER_UPDATE_INTERVAL_MS = 30_000L/)
assert.match(locationService, /SAVER_UPDATE_MINIMUM_DISTANCE_METRES = 25f/)
assert.match(locationService, /ACTION_RESTRICT_BACKGROUND_CHANGED/)
assert.match(locationService, /fun connectivityPauseReason\(\): String\?/)
assert.match(locationService, /policyPauseReason/)
assert.match(manifest, /android\.permission\.ACCESS_NETWORK_STATE/)
assert.match(androidPlugin, /fun statusWithPolicy\(json: String\): JSObject/)
assert.doesNotMatch(
  locationService,
  /checkSelfPermission\(this, Manifest\.permission\.ACCESS_FINE_LOCATION\)/,
)
assert.equal(/\?: store\.loadRequest\(\)/.test(locationService), false)
assert.equal(/store\.saveStatus\(status\.toString\(\)\)/.test(locationService), false)
assert.ok(
  /private fun persistStatusIfChanged\(status: JSONObject\)/.test(locationService),
  'Android service must persist only changed recovery status',
)
assert.ok(/if \(redacted == lastPersistedStatus\) return/.test(locationService))
assert.ok(/persistStatusIfChanged\(status\)/.test(locationService))
assert.match(locationService, /replace\(Regex\("#share=\[A-Za-z0-9_-\]\+"\), "#share=<redacted>"\)/)
assert.ok(
  /if \(webView == null && !runtimeStarting\) createRuntime\(\)/.test(locationService),
  'Android service must schedule only one hidden P2P runtime',
)
assert.doesNotMatch(
  locationService,
  /__constellationBackgroundCommand\?\./,
  'Injected Android service JavaScript must remain parseable by the API 29 WebView.',
)
assert.match(locationService, /remove\("returnOffers"\)/)
assert.match(backgroundEntry, /returnOffers: state\.returnOffers/)

console.log('Android configuration checks passed.')
