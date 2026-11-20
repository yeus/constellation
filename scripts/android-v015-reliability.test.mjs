import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const pluginPath =
  'src-tauri/plugins/constellation-android/android/src/main/java/space/taskyon/constellation/plugin/'
const read = (path) => fs.readFileSync(path, 'utf8')
const manifest = read(
  'src-tauri/plugins/constellation-android/android/src/main/AndroidManifest.xml',
)
const receiver = read(pluginPath + 'RestoreReceiver.kt')
const nativeStore = read(pluginPath + 'EncryptedShareStore.kt')
const journal = read(pluginPath + 'ReliabilityJournal.kt')
const service = read(pluginPath + 'LocationShareService.kt')
const plugin = read(pluginPath + 'ConstellationAndroidPlugin.kt')
const runtime = read('src/android/backgroundEntry.ts')
const viewer = read('src/android/backgroundViewer.ts')
const app = read('src/views/MapView.vue')
const bridge = read('src-tauri/src/lib.rs')

test('boot and app-update restore are opt-in and permission-gated', () => {
  assert.match(manifest, /android\.intent\.action\.BOOT_COMPLETED/)
  assert.match(manifest, /android\.intent\.action\.MY_PACKAGE_REPLACED/)
  assert.match(receiver, /hasBackgroundShares/)
  assert.match(receiver, /ACCESS_BACKGROUND_LOCATION/)
  assert.match(receiver, /PackageManager\.PERMISSION_GRANTED/)
  assert.match(receiver, /loadFollowingPreference\(\) == true/)
  assert.match(receiver, /publishing && allowedLocation && notificationsAllowed/)
  assert.match(receiver, /\|\| receiving/)
  assert.match(service, /receiverRequested\(\)/)
  assert.match(service, /set-sharing-behavior/)
  assert.match(service, /backgroundSourceShares/)
  assert.match(service, /ACTION_RESTORE/)
})
test('native stored opt-out gates all background receiver restoration paths', () => {
  assert.match(nativeStore, /fun saveFollowingPreference\(enabled: Boolean\)/)
  assert.match(nativeStore, /fun loadFollowingPreference\(\): Boolean\?/)
  assert.match(nativeStore, /requested == "foreground"/)
  assert.match(nativeStore, /requested == "background"/)
  assert.match(plugin, /fun setBackgroundFollowingPreference\(invoke: Invoke\)/)
  assert.match(plugin, /store\.loadFollowingPreference\(\) == true/)
  assert.match(
    service,
    /receiverFence\.snapshot\(\)\.owner == "service" && store\.loadFollowingPreference\(\) == true/,
  )
  assert.match(bridge, /android_set_background_following_preference/)
  assert.match(app, /loadNativeFollowingPreference\(\)/)
  assert.match(app, /resolveNativeFollowingPreference/)
})
test('foreground-only preference stops native location watches and refreshes despite existing OS permission', () => {
  assert.match(service, /canPublishRequestedInBackground\(\)/)
  assert.match(
    service,
    /loadBehaviorPreference\(\)\?\.let\(::JSONObject\)\?\.optString\("publication"\) != "foreground"/,
  )
  assert.match(
    service,
    /if \(commandType == "set-sharing-behavior"\) \{\s+reloadLocationPolicies\(\)\s+updatePolicyState/,
  )
  assert.match(service, /if \(!appVisible && !canPublishRequestedInBackground\(\)\)/)
  assert.match(service, /val permitted = appVisible \|\| canPublishRequestedInBackground\(\)/)
})

test('native journal retains multiple days and is included without export truncation', () => {
  assert.match(journal, /RETENTION_DAYS = 14L/)
  assert.match(journal, /MAX_DAY_BYTES = 4_000_000L/)
  assert.match(plugin, /ReliabilityJournal\(activity\.applicationContext\)\.writeTo\(writer\)/)
  assert.doesNotMatch(plugin, /file\.writeBytes\(bytes\)/)
  assert.match(service, /journal\.record\("location\.fix"/)
  assert.match(service, /journal\.record\("sharing\.submit"/)
  assert.match(service, /journal\.record\("sharing\.confirmed"/)
  assert.match(service, /journal\.record\("follow\.received"/)
  assert.match(service, /journal\.record\("service\.heartbeat"/)
  assert.match(plugin, /fun recordSessionEvent\(invoke: Invoke\)/)
  assert.match(bridge, /android_record_session_event/)
  assert.match(app, /android_record_session_event/)
})

test('native heartbeat samples accessible power states without logging locations', () => {
  const power = read(pluginPath + 'DevicePowerDiagnostics.kt')
  assert.match(service, /journal\.record\("service\.heartbeat",/)
  assert.match(
    service,
    /journal\.record\("service\.power\.snapshot", powerConditionsSnapshot\(applicationContext\)\)/,
  )
  assert.doesNotMatch(service, /service\.heartbeat.*powerConditionsSnapshot\(applicationContext\)/)
  for (const field of [
    'ACTION_BATTERY_CHANGED',
    'EXTRA_LEVEL',
    'EXTRA_SCALE',
    'EXTRA_BATTERY_LOW',
    'getRestrictBackgroundStatus',
    'getCurrentInterruptionFilter',
    'getAppStandbyBucket',
    'isInteractive',
    'isPowerSaveMode',
    'isLowPowerStandbyEnabled',
  ]) {
    assert.ok(power.includes(field), `Missing power diagnostic ${field}`)
  }
  assert.match(service, /service\.power\.changed/)
  assert.match(service, /journal\.record\("sharing\.session"/)
  assert.match(service, /lastJournalSessionSequence/)
  assert.match(service, /safeSessionKinds/)
  assert.match(service, /state in setOf\("retry", "connected", "pending", "error"\)/)
  assert.match(service, /Intent\.ACTION_BATTERY_LOW/)
  assert.match(service, /PowerManager\.ACTION_POWER_SAVE_MODE_CHANGED/)
  assert.match(service, /NotificationManager\.ACTION_INTERRUPTION_FILTER_CHANGED/)
  assert.doesNotMatch(power, /latitude|longitude|peerId|shareId|shareSecret/)
})

test('v0.1.5 power acceptance exercises Android policies and journal-backed assertions', () => {
  const native = read('scripts/test-android.mjs')
  const managed = read('scripts/test-android-managed.mjs')
  const workflow = read('.github/workflows/android-standby.yml')
  assert.match(native, /runPowerStateMatrixSmoke/)
  assert.match(native, /parsePowerJournal/)
  assert.match(managed, /--power-state-matrix/)
  assert.match(workflow, /--power-state-matrix/)
  assert.match(native, /--power-recovery-matrix/)
  assert.match(managed, /--power-recovery-matrix/)
  assert.match(workflow, /--power-recovery-matrix/)
  assert.match(native, /deliveryStates/)
  assert.match(native, /processAliveBeforeCleanup/)
  assert.match(managed, /summarizeAndroidNativeCrash/)
  assert.match(native, /\[android-acceptance\] failed-phase=/)
  assert.match(native, /markPhase\('initial-authenticated-ack'\)/)
  assert.match(managed, /two-device failed diagnostics/)
})

test('API 29 synthetic locations arrive after viewer admission enables the native watch', () => {
  const acceptance = read('scripts/test-android.mjs')
  const viewer = acceptance.indexOf('await startBrowserLocationPreview(viewer)')
  const admitted = acceptance.indexOf(
    "'the first authenticated viewer before injecting a synthetic location fix'",
  )
  const fix = acceptance.indexOf("injectShareFlowLocation('-70.0011', '40.0011')")
  assert.ok(viewer >= 0 && admitted > viewer && fix > admitted)
})

test('API 29 Play Store fixture mocks network locations without modifying the app', () => {
  const native = read('scripts/test-android.mjs')
  const managed = read('scripts/test-android-managed.mjs')
  const fixture = read('scripts/fixtures/android-network-location/NetworkLocationFixture.java')
  const manifest = read('scripts/fixtures/android-network-location/AndroidManifest.xml')
  assert.match(managed, /testArgs.includes\('--network-location-fixture'\)/)
  assert.match(managed, /'--local-share-flow', '--network-location-fixture'/)
  assert.match(native, /retryMockLocationFix\('-70\.0201', '40\.0201'\)/)
  assert.match(fixture, /LocationManager\.NETWORK_PROVIDER/)
  assert.match(fixture, /setTestProviderLocation\(PROVIDER, location\)/)
  assert.match(manifest, /android:permission="android\.permission\.DUMP"/)
  assert.match(native, /if \(options.exactLocationFixture\)/)
  assert.match(native, /clickButton\(cdp, 'Exact'\)/)
})

test('Android pause command preserves the requested boolean for UI and notification actions', () => {
  const notification = read(pluginPath + 'ShareNotification.kt')
  assert.match(plugin, /request = request\.toString\(\)/)
  assert.match(notification, /putExtra\(ShareServiceContract\.EXTRA_PAUSED, !paused\)/)
  assert.match(service, /getStringExtra\(ShareServiceContract\.EXTRA_REQUEST\)/)
  assert.match(service, /getBoolean\("paused"\)/)
  assert.match(service, /hasExtra\(ShareServiceContract\.EXTRA_PAUSED\)/)
  assert.match(service, /journal\.record\("sharing\.pause\.request"/)
  assert.match(service, /journal\.record\("sharing\.pause\.complete"/)
  assert.match(plugin, /ReliabilityJournal\(context\)\.record\("sharing\.pause\.ack"/)
})

test('receiver and sender reconnect independently with a rate limit', () => {
  assert.match(service, /recover-background-sources/)
  assert.match(service, /recover-background-viewer/)
  assert.match(runtime, /shouldAttemptReceiverRecovery/)
  assert.match(runtime, /state\.viewer\.recover\(\)/)
  assert.match(viewer, /setFollowingSuspended\(true\)/)
  assert.match(viewer, /setFollowingSuspended\(false\)/)
})
test('receiver restoration records sanitized start outcomes in the native journal', () => {
  for (const outcome of ['attempt', 'finished', 'failed']) {
    assert.match(runtime, new RegExp(`follow\\.restore\\.${outcome}`))
    assert.match(service, new RegExp(`follow\\.restore\\.${outcome}`))
  }
})
test('sticky service restart explains policy-based stops and fail-closed exceptions', () => {
  assert.match(service, /service\.restart\.policy/)
  assert.match(service, /service\.start\.failed/)
  assert.match(service, /service\.foreground\.attempt/)
  assert.match(service, /service\.foreground\.ready/)
  assert.match(service, /service\.stop/)
  assert.match(service, /finishStop\(reason = "no-authorized-background-work"\)/)
  assert.match(service, /reason = "runtime-idle"/)
  assert.match(service, /reason = "explicit-stop"/)
  assert.match(service, /if \(finishing\) return/)
  assert.match(service, /getHistoricalProcessExitReasons/)
  assert.match(service, /service\.previous\.process\.exit/)
  assert.match(service, /service\.destroyed.*runtimeReady/)
})

test('dual-role Android process death checks both grant directions and durable service life', () => {
  const native = read('scripts/test-android.mjs')
  const managed = read('scripts/test-android-managed.mjs')
  assert.match(native, /--dual-role-process-restart/)
  assert.match(native, /The process must temporarily be absent after SIGKILL/)
  assert.match(native, /dual-role START_STICKY process restart/)
  assert.match(native, /dual-role service must still be started without opening the Activity/)
  assert.match(native, /Focused repeatable restart regression/)
  assert.match(managed, /--dual-role-restart-only/)
  assert.match(native, /durable outgoing share and incoming follow after dual-role process death/)
  const shareSheet = read('src/components/ShareSheet.vue')
  assert.match(shareSheet, /aria-label="Name to share"/)
  assert.match(native, /fillAndroidInput\(cdp, 'Name to share', name\)/)
  assert.match(native, /saving an Android peer must not automatically share back/)
  assert.match(native, /enabled global background following switch/)
  assert.match(native, /enabled Android background-following setting/)
  assert.match(managed, /--dual-role-process-restart/)
})

test('foreground return restores a receiver-only service after process death', () => {
  const visibility = plugin.slice(
    plugin.indexOf('fun setBackgroundVisibility'),
    plugin.indexOf('fun importSourceState'),
  )
  assert.match(visibility, /receiverFence\.snapshot\(\)\.owner == "service"/)
  assert.match(visibility, /ACTION_RESTORE/)
  assert.match(visibility, /service\.foreground\.restore/)
})
