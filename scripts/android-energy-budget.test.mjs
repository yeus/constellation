import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const android =
  'src-tauri/plugins/constellation-android/android/src/main/java/space/taskyon/constellation/plugin/'
const location = fs.readFileSync(android + 'AndroidLocationAccess.kt', 'utf8')
const service = fs.readFileSync(android + 'LocationShareService.kt', 'utf8')
const behavior = fs.readFileSync('src/sharing/sharingBehavior.ts', 'utf8')

test('Android defaults to saver instead of opt-out high-frequency sampling', () => {
  assert.match(behavior, /battery: isAndroid \? 'saver' : 'balanced'/)
  assert.match(service, /BALANCED_UPDATE_INTERVAL_MS = 15_000L/)
  assert.match(service, /SAVER_UPDATE_INTERVAL_MS = 30_000L/)
})

test('native location watcher stops when nobody is connected and resumes when a viewer arrives', () => {
  assert.match(service, /if \(lastViewerCount == 0 \|\| allKnownSharesPaused\(\)\) return/)
  assert.match(
    service,
    /publishingShareCount\(shares\) == 0 \|\| lastViewerCount == 0 \|\| !permitted/,
  )
  assert.match(service, /watchRequested &&[\s\S]{0,140}appliedSampling !=/)
  assert.match(service, /if \(cancelRefresh\) clearRefresh\(\)/)
})

test('background sharing watches only one provider; precise grants select GPS only for exact shares', () => {
  assert.match(location, /preferredProvider: String\? = null/)
  assert.match(location, /val providers = availableLocationProviders\(manager\)/)
  assert.match(location, /preferredProvider == null/)
  assert.match(service, /preferredProvider = preferredLocationProvider\(lastShares\)/)
  assert.match(service, /locationGrant\(this\) == "fine"/)
  assert.match(service, /optString\("precision"\) == "exact"/)
  assert.match(service, /onProviderDisabled\(provider: String\)/)
})

test('one-shot refresh remains independent from the periodic watch manager', () => {
  assert.match(service, /refreshManager = manager/)
  assert.match(service, /refreshManager\?\.removeUpdates\(listener\)/)
  assert.match(service, /stopLocationUpdates\(cancelRefresh = false\)/)
})

test('screen off and battery saver dynamically select the low-rate preset', () => {
  assert.match(service, /isInteractive == false/)
  assert.match(service, /isPowerSaveMode == true/)
  assert.match(service, /mainHandler\.post \{ updatePolicyState\(\) \}/)
})

test('GPS diagnostics coalesce disk writes without dropping per-provider counts', () => {
  assert.match(service, /private fun recordLocationFix\(type: String\)/)
  assert.match(service, /SystemClock\.elapsedRealtime\(\) - lastFixJournalAt < 300_000L/)
  assert.match(service, /private fun flushLocationFixJournal\(\)/)
  assert.match(service, /watch=\$watchFixesSinceJournal;refresh=\$refreshFixesSinceJournal/)
  assert.match(
    service,
    /private fun sendPosition\(location: Location, type: String\) \{\n {4}recordLocationFix\(type\)/,
  )
  assert.match(service, /override fun onDestroy\(\) \{\n {4}flushLocationFixJournal\(\)/)
})

test('network-only option never falls back to GPS for background watches or fresh fixes', () => {
  assert.match(behavior, /locationProvider: z.enum\(\['automatic', 'network-only'\]\).optional\(\)/)
  assert.match(location, /allowFallback: Boolean = true/)
  assert.match(location, /if \(allowFallback\) providers.filter/)
  assert.match(service, /allowFallback = !networkOnlyLocationRequested\(\)/)
  assert.match(
    service,
    /if \(networkOnlyLocationRequested\(\)\) listOf\(LocationManager.NETWORK_PROVIDER\)/,
  )
})

test('hidden background mode always selects saver regardless of screen being on', () => {
  assert.match(service, /if \(!appVisible \|\| power\?\.isPowerSaveMode == true/)
})

test('only switching into network-only cancels possible GPS refresh, not ordinary sampling', () => {
  assert.match(service, /val wasNetworkOnly = networkOnlyPolicy/)
  assert.match(service, /if \(!wasNetworkOnly && networkOnlyPolicy\) clearRefresh\(\)/)
  assert.match(service, /stopLocationUpdates\(cancelRefresh = false\)/)
})
test('unreadable power preferences fail closed to network-only without boosting', () => {
  assert.match(service, /if \(loaded\.isFailure\)/)
  assert.match(service, /networkOnlyPolicy = true/)
  assert.match(service, /activeViewingBoostPolicy = false/)
})

test('active-viewing boosts require a sourced, bounded, authenticated P2P lease', () => {
  const protocol = fs.readFileSync('src/sharing/shareProtocol.ts', 'utf8')
  const source = fs.readFileSync('src/sharing/sharingHelpers.ts', 'utf8')
  const projection = fs.readFileSync('src/sharing/sharingProjection.ts', 'utf8')
  const viewer = fs.readFileSync('src/sharing/sharingViewerApi.ts', 'utf8')
  const budget = fs.readFileSync(android + 'ViewingBoostBudget.kt', 'utf8')
  const map = fs.readFileSync('src/views/MapView.vue', 'utf8')
  const mapComponent = fs.readFileSync('src/components/LocationMap.vue', 'utf8')
  assert.match(protocol, /viewing: z\.boolean\(\)\.optional\(\)/)
  assert.match(source, /requireAuthorized\(session, state\.authorizedShare\)/)
  assert.match(source, /session\.receiptCapable &&\s+session\.subscriptionId/)
  assert.match(source, /session\.lastHeartbeatAt \+ 25_000/)
  assert.match(viewer, /state\.isV3 \? \{ viewing:/)
  assert.match(projection, /activeViewingUntil > input\.now/)
  assert.match(budget, /windowMs: Long = 600_000L/)
  assert.match(budget, /limitMs: Long = 60_000L/)
  assert.match(service, /viewingBudget\.permittedUntil/)
  assert.match(service, /power\?\.isDeviceIdleMode != true/)
  assert.match(service, /mainHandler\.postDelayed\(viewingBoostTimer/)
  assert.match(map, /synchronizeActiveViewing/)
  assert.match(map, /@user-pan="selectedFollowId = undefined"/)
  assert.match(mapComponent, /target\.on\('dragstart', \(\) => emit\('userPan'\)\)/)
})

test('a source can opt out, and network-only never enables GPS in a boost', () => {
  assert.match(behavior, /activeViewingBoost: z\.boolean\(\)\.optional\(\)/)
  assert.match(service, /optBoolean\("activeViewingBoost", true\) != false/)
  assert.match(service, /!networkOnlyLocationRequested\(\) && locationGrant\(this\) == "fine"/)
})
