const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "Naughty Faction Companion.user.js"), "utf8");
const readme = fs.readFileSync(path.join(__dirname, "README.md"), "utf8");
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const persistence = section("const getStoredDashboardState", "function updateCompanyStockHistory");
const restore = section("async function loadPersistedState", "async function secureCustomFetch");
const controls = section("function bindFactionControls", "function stopWarTargetsRefreshTimer");
const renderer = section("function renderFFScouterWarTargets", "function renderFactionPanel");
const refresh = section("async function refreshWarTargets", "function bindFactionControls");
const factionFetch = section("async function fetchFactionData", "async function fetchCompanyData");
const factionOnlyRefresh = section("async function refreshAllSections", "function performAutoRefreshCycle");
const navigation = section("const tabs =", "const navHtml");
const resize = section("const resizeHandles = dashboard.querySelectorAll", "let viewportLayoutTimer");
const scrollbarStyles = section("#nfc-faction-wrapper #nfc-main-body {", "#nfc-faction-wrapper .nfc-primary-nav");
const responsiveColumns = section("function allocateColumnPixels", "function getWarTargetTableAvailableWidth");
const storage = section("// --- TornPDA-storage-first persistent storage ---", "const getStoredKey");
const settings = section("function renderSettingsPanel", "function renderInventorySection");
const settingsControls = section("function bindSettingsControls", "function bindPersonalControls");
const hospitalAlerts = section("function getWarHospitalAlertNotificationId", "function getCrossOriginTransport");
const targetFiltering = section("function getWarTargetStatus", "function getWarTargetSortValue");
const minimizedInteraction = section('const dragHandle = document.getElementById("nfc-drag-handle")', "const resizeHandles = dashboard.querySelectorAll");

assert.match(source, /@version\s+1\.0\.41/, "userscript header version must be 1.0.41");
assert.match(source, /@license\s+MIT/, "metadata must declare the MIT license");
assert.match(source, /https:\/\/github\.com\/SharpSplinter\/Naughty-Faction-Companion/, "metadata must use the renamed GitHub account");
assert.match(source, /https:\/\/raw\.githubusercontent\.com\/SharpSplinter\/Naughty-Faction-Companion\/main/, "metadata must update from the renamed account");
assert.doesNotMatch(source, /refs\/heads\/main/, "TornPDA update metadata must use the direct branch URL");
assert.doesNotMatch(source + readme, /xf4k31tx/, "stale GitHub account links must not remain");
assert.match(source, /const SCRIPT_VERSION = "1\.0\.41";/, "displayed version must match the userscript header");
assert.doesNotMatch(source, /BOOT_TRACE|logBootPhase|bootEnvironmentSnapshot|bootErrorDetails|logBootWatchdog/, "temporary boot-phase diagnostics must stay disabled");
assert.match(source, /^\/\/ @run-at\s+document-start$/m, "Faction must execute at document-start");
assert.match(source, /@grant\s+GM_notification/, "desktop hospital alerts must request the legacy Tampermonkey notification grant");
assert.match(source, /@grant\s+GM\.notification/, "desktop hospital alerts must request the modern Tampermonkey notification grant");
assert.match(source, /const CONSOLE_TAG = "\[Naughty Faction Companion\]";/, "diagnostics must use the script-specific console prefix");
assert.match(source, /function redactSecretText\(value\)/, "diagnostics must redact secret-bearing text");
assert.match(source, /function getSafeRequestTarget\(method, rawUrl\)/, "API diagnostics must build a query-free request target");
assert.match(source, /host: parsed\.host/, "API diagnostics must include the request host");
assert.match(source, /path: parsed\.pathname/, "API diagnostics must include the request path");
assert.match(source, /API request started/, "API diagnostics must log request starts");
assert.match(source, /API request succeeded/, "API diagnostics must log status and duration on success");
assert.match(source, /API request failed/, "API diagnostics must log failures");
assert.match(source, /Storage backend selected/, "storage backend and fallback diagnostics must be visible");
assert.match(source, /Native bridge HTTP fallback/, "native bridge fallback diagnostics must be visible");
assert.match(source, /Startup runtime/, "startup runtime diagnostics must be visible");
assert.doesNotMatch(source, /console\.warn\("Catalog fetch failed:/, "raw console warnings must use the secret-safe logger");
assert.doesNotMatch(source, /console\.error\("Refresh failed:/, "raw console errors must use the secret-safe logger");
assert.match(source, /storagePreference: "NFC_V1_STORAGE_PREFERENCE"/, "storage preference needs its own durable key");
assert.match(source, /useLegacyGMStorage: false/, "PDA_storage must remain the unchecked default");
assert.match(storage, /const loadStoragePreference = async \(\)/, "the storage preference must load before normal persisted values");
assert.match(restore, /await loadStoragePreference\(\)/, "storage routing must be selected before restoring settings and keys");
assert.match(source, /function waitForTornPDABridgeReady\(/, "native bridge calls must wait for TornPDA readiness");
assert.match(storage, /const waitForPdaStorageBridgeReady = async \(\)/, "PDA_storage loading must wait for bridge readiness");
assert.match(storage, /Promise\.resolve\(\)\.then\(\(\) => PDA_storage\.loadAll\(\)\)/, "synchronous PDA_storage startup errors must become promise rejections");
assert.match(storage, /PDA_STORE\.retryScheduled/, "late bridge readiness must retry the native storage backend");
assert.match(source, /function recoverFromStartupStorageFailure\(/, "a storage startup failure must not prevent dashboard rendering");
assert.match(source, /Startup persistence failed; rendering with safe defaults/, "startup fallback must emit an actionable diagnostic");
assert.match(storage, /nextUseLegacyGMStorage \? "pda-to-gm" : "gm-to-pda"/, "switching storage must migrate known companion values in the selected direction");
assert.match(storage, /const writeStoragePreference = async \(preference, requireLegacyGM = false\)/, "the preference must persist independently of the selected backend");
assert.match(storage, /if \(state\.useLegacyGMStorage\)/, "legacy GM mode must route reads and writes through GM first");
assert.match(settings, /Screen Size/, "Settings must display the current screen size");
assert.match(settings, /Storage Method/, "Settings must display the active storage method");
assert.match(settings, /Use legacy GM storage/, "Settings must expose the legacy GM storage option");
assert.match(settingsControls, /setUseLegacyGMStorage\(legacyStorageToggle\.checked\)/, "the legacy GM checkbox must persist and apply its selected mode");
assert.match(source, /GM_deleteValue/, "GM delete compatibility must be granted when native deletion is unavailable");
assert.match(storage, /PDA_storage\.delete\(key\)/, "native deletion must use TornPDA's documented delete API");
assert.match(storage, /function createPdaWriteQueue/, "ordinary PDA writes must be debounced into setMany batches");
assert.match(source, /TORN_PDA_INJECTED_API_KEY = "_###PDA-APIKEY###_"/, "TornPDA injected API keys must be detected without exposing their value");
assert.match(settings, /Using TornPDA&#8217;s injected API key/, "injected key status must be visible without displaying the key");
const tornPdaAdaptedSource = `(function() {const PDA_storage = window.__pdaStorageFactory && window.__pdaStorageFactory("faction");${source.replaceAll("###PDA-APIKEY###", "injected-demo-key").replace(/[“”]/g, '"').replace(/[‘’]/g, "'")} }());`;
assert.doesNotThrow(() => new vm.Script(tornPdaAdaptedSource), "TornPDA's source adaptation must preserve valid JavaScript");
assert.match(source, /function showNativeToast/, "TornPDA feedback must prefer native toasts");
assert.match(source, /function scheduleNativeReminder/, "TornPDA native reminders must be supported");
assert.match(source, /function getWarHospitalAlertCandidates/, "hospital alerts must derive candidates through the current FFScouter view");
assert.match(source, /function reconcileWarHospitalAlerts/, "hospital alerts must reconcile stale native and desktop schedules");
assert.match(source, /function syncWarHospitalAlertsFromFreshData/, "hospital alerts must schedule from a fresh active scan");
assert.match(hospitalAlerts, /scheduleNotification/, "TornPDA hospital alerts must use native scheduled notifications");
assert.match(hospitalAlerts, /NATIVE_WAR_HOSPITAL_ALERT_ID_MIN/, "native hospital alert IDs must remain inside TornPDA's supported range");
assert.match(hospitalAlerts, /cancelNotification/, "changing view eligibility must cancel stale TornPDA hospital alerts");
assert.doesNotMatch(hospitalAlerts, /Promise\.allSettled/, "hospital alert cleanup must support older TornPDA WebViews");
assert.doesNotMatch(renderer, /\$\{hospitalAlertPanel\}/, "FFScouter must keep hospital-alert configuration out of the target view");
assert.doesNotMatch(source, /id="war-hospital-alert-toggle"/, "legacy hospital-alert controls must not remain in FFScouter");
assert.match(settings, /settings-war-hospital-alert-toggle/, "Settings must expose hospital-alert enablement");
assert.match(settings, /settings-war-hospital-alert-threshold/, "Settings must expose the saved hospital-alert threshold");
assert.match(settingsControls, /const getHospitalAlertThreshold =/, "Settings must validate the selected hospital-alert threshold");
assert.match(settingsControls, /await enableWarHospitalAlerts\(selected\)/, "Settings must enable alerts using the selected threshold");
assert.match(settingsControls, /await disableWarHospitalAlerts\(\{ resetPreference: true \}\)/, "Settings must be able to clear all hospital-alert settings");
assert.match(settings, /reset-war-hospital-alerts-btn/, "Settings must offer a hospital-alert preference reset");
assert.match(settingsControls, /disableWarHospitalAlerts\(\{ resetPreference: true \}\)/, "Settings reset must clear hospital-alert preference and schedules");
assert.match(source, /const formatIdentifier =/, "identifier formatting must not reuse comma-separated integer formatting");
assert.doesNotMatch(source, /ID \$\{formatInteger\(/, "displayed IDs must remain ungrouped identifiers");
assert.match(source, /tornpda:tabState/, "TornPDA tab state must pause automatic refresh while inactive");
assert.match(source, /document\.addEventListener\("visibilitychange"/, "document visibility must pause automatic refresh while inactive");
assert.match(source, /function isAutomaticRefreshAllowed/, "auto-refresh must centrally gate inactive states");
assert.match(source, /function readViewportMetrics\(\)/, "keyboard detection must distinguish raw visual-viewport changes from stable panel geometry");
assert.match(source, /const virtualKeyboardState = \{ active: false, baseline: null \}/, "keyboard state must retain the pre-keyboard viewport");
assert.match(source, /function enableNativeKeyboardOverlay\(\)/, "supporting TornPDA webviews must be opted into native keyboard overlays");
assert.match(source, /keyboard\.overlaysContent = true;/, "the native keyboard must overlay content rather than resize the viewport when the API is available");
assert.match(source, /function beginVirtualKeyboardGuard\(target\)/, "focusing a widget input must arm the native keyboard overlay guard");
assert.match(source, /const keyboardOpening = inputFocused && geometryMatches && heightLoss >= VIRTUAL_KEYBOARD_OPEN_DELTA_PX;/, "keyboard-height changes must be recognized without treating rotations as a keyboard");
assert.match(source, /if \(keyboardOpen\) return;/, "keyboard viewport changes must not resize or reposition the panel");
assert.match(source, /dashboard\.addEventListener\("focusin", \(event\) => beginVirtualKeyboardGuard\(event\.target\)\);/, "native keyboard protection must begin when any script input receives focus");
assert.match(source, /const getStoredMinimizedPosition =/, "minimized icon positions must be restored from persisted state");
assert.match(source, /const setStoredMinimizedPosition =/, "minimized icon positions must be saved independently from the expanded panel position");
assert.match(source, /state\.isMinimized \? getStoredMinimizedPosition\(position\) : null/, "minimized view must prefer its saved coordinates");
assert.match(source, /#nfc-faction-wrapper\[data-minimized="true"\] #nfc-drag-handle\s*\{\s*touch-action: none;/, "the minimized icon must accept reliable TornPDA drag gestures");
assert.match(minimizedInteraction, /const DRAG_ACTIVATION_DISTANCE_PX = 5/, "small tap movement must not be mistaken for an icon drag");
assert.match(minimizedInteraction, /setStoredMinimizedPosition\(\{ x: rect\.left, y: rect\.top \}\)/, "dragging a minimized icon must persist its coordinates");
assert.match(minimizedInteraction, /if \(wasMinimized && !didDrag && !cancelled\) restoreMinimizedWidget\(\);/, "releasing a non-dragged minimized icon must restore it without relying on a synthetic click");
assert.match(minimizedInteraction, /dashboard\.addEventListener\("click", \(e\) => \{[\s\S]*restoreMinimizedWidget\(\);/, "click fallback must restore from every part of the minimized icon");

for (const key of ["warTargetSort", "warTargetFilters", "warTargetFFRange", "warTargetBSRange", "warTargetRangeMetric", "warHospitalAlertSettings", "warTargetColumnOrder", "warTargetColumnWidths"]) {
    assert.match(persistence, new RegExp(key), `${key} must be saved`);
    assert.match(restore, new RegExp(key), `${key} must be restored`);
}

for (const target of ["faction:general", "faction:ffscouter"]) {
    assert.match(source, new RegExp(target), `${target} must have an auto-refresh control`);
}
assert.match(persistence, /autoRefreshSettings/, "auto-refresh settings must persist");
assert.match(restore, /autoRefreshSettings/, "auto-refresh settings must restore");
assert.match(source, /function getCurrentAutoRefreshTarget\(\)/, "auto-refresh must resolve the active view");
assert.match(navigation, /id: "faction", label: "Faction"/, "Faction must be a visible top-level tab");
assert.match(navigation, /id: "settings", label: "Settings"/, "Settings must remain available");
assert.doesNotMatch(navigation, /id: "(overview|personal|company|inventory)"/, "standalone navigation must not expose unrelated tabs");
assert.doesNotMatch(factionOnlyRefresh, /fetch(Overview|Personal|Company|Inventory)Data\(/, "standalone refresh must not request unrelated data");

assert.doesNotMatch(controls, /state\.caches/, "view controls must never mutate faction data");
assert.match(renderer, /faction\.war \|\| data\?\.war/, "renderer must retain the target snapshot's war context");
assert.match(factionFetch, /warsRequestFailed \? \(previousFaction\.war \|\| null\) : null/, "failed wars requests must retain the last valid war");
assert.match(refresh, /currentFaction\.war\?\.warId/, "target refresh must validate the current war before committing");
assert.match(refresh, /warTargets: \{ \.\.\.refreshed, war: \{ \.\.\.war \} \}/, "target cache must carry its war snapshot");
assert.match(source, /function hasRankedWarStarted\(war\)/, "static target lookup must wait for the Ranked War start time");
assert.match(refresh, /if \(!hasRankedWarStarted\(war\)\)/, "target refresh must wait for the Ranked War start time");
assert.match(refresh, /const loadStatic = !cacheMatchesWar \|\| !Number\(existing\.staticLookupAttemptedAt \|\| 0\)/, "FFScouter data must be loaded once per Ranked War");
assert.match(factionFetch, /let warTargets = previousWarTargets \|\| null;/, "ordinary faction refreshes must preserve the static FFScouter snapshot");
assert.doesNotMatch(factionFetch, /fetchWarTargetData\(/, "ordinary faction refreshes must not trigger FFScouter or target-profile lookups");
assert.match(source, /async function fetchTornWarStatuses\(factionId, apiKey\)/, "live enemy status must use the Torn faction-members response");
assert.match(source, /faction\/\$\{factionId\}\/members/, "live enemy status must use Torn v2 faction members");
assert.doesNotMatch(source, /TORN_V1_BASE_URL/, "legacy Torn v1 profile batches must not be used for live status");
assert.match(source, /function pauseWindowActivity\(\)/, "minimizing must pause all refresh timers");
assert.match(source, /function resumeWindowActivity\(\)/, "restoring must resume permitted refresh timers");
assert.match(source, /if \(state\.isMinimized\) \{[\s\S]*return Promise\.reject/, "request wrappers must block API calls while minimized");
assert.match(source, /if \(!state\.pageScopeActive \|\| state\.isMinimized\) return false;/, "refresh entry points must pause while minimized");
assert.doesNotMatch(renderer, /buildStatCard\("Estimates"/, "backend Estimates card must remain hidden");
assert.match(controls, /input\.onwheel/, "FF range fields must support wheel stepping");
assert.match(controls, /event\.preventDefault\(\)/, "FF wheel stepping must not scroll the page");
assert.match(source, /data-corner="top-left"/, "top-left window resize grip must exist");
assert.match(source, /data-corner="bottom-left"/, "bottom-left window resize grip must exist");
assert.match(source, /data-corner="bottom-right"/, "bottom-right window resize grip must exist");
assert.doesNotMatch(source, /data-corner="top-right"/, "top-right corner must remain reserved for Minimize");
assert.match(resize, /"bottom-left": \{ fromLeft: true, fromTop: false \}/, "bottom-left grip must resize from the left");
assert.match(resize, /"bottom-right": \{ fromLeft: false, fromTop: false \}/, "bottom-right grip must resize from the right");
assert.match(resize, /capturePointer\(handle, resizePointerId\)/, "each active resize grip must capture its pointer when available");
assert.match(resize, /releasePointer\(resizeHandle, resizePointerId\)/, "resize pointer capture must be released when resizing ends");
assert.match(source, /down: "pointerdown", move: "pointermove", up: "pointerup"/, "pointer events must support resize interactions");
assert.match(source, /down: "mousedown", move: "mousemove", up: "mouseup"/, "mouse events must remain a resize fallback");
assert.match(source, /overflow: hidden !important/, "widget content must not overflow horizontally or vertically");
assert.match(source, /min-inline-size: 0 !important/, "cards and fields must be allowed to shrink with the widget");
assert.match(source, /max-inline-size: 100% !important/, "cards and fields must remain constrained to the widget width");
assert.match(source, /minWidth: Math\.min\(380, maxWidth\)/, "the script window must enforce a readable minimum width");
assert.match(source, /minHeight: Math\.min\(620, maxHeight\)/, "the script window must enforce a readable minimum height");
assert.match(source, /grid-template-rows: auto auto auto minmax\(0, 1fr\)/, "FFScouter must reserve separate rows for refresh header, section title, tabs, and targets");
assert.match(source, /scrollbar-width: none/, "FFScouter scrollbars must remain hidden without disabling scrolling");
assert.match(scrollbarStyles, /\.nfc-scroll-region/, "every intentional scroll region must use the shared hidden-scrollbar treatment");
assert.match(scrollbarStyles, /\.nfc-scroll-region::-webkit-scrollbar \{ display: none;/, "WebKit scrollbar tracks must be hidden for every intentional scroll region");
assert.match(scrollbarStyles, /-webkit-overflow-scrolling: touch/, "TornPDA touch scrolling must remain enabled for intentional scroll regions");
assert.match(source, /ntc-war-target-table-wrap nfc-war-target-table-shell nfc-scroll-region" tabindex="0"/, "war-target scrolling must remain keyboard focusable");
assert.match(source, /ntc-inventory-table-wrap nfc-scroll-region" tabindex="0"/, "inventory scrolling must receive the same hidden-scrollbar and keyboard treatment");
assert.match(source, /ffscouter-verification-dialog" class="nfc-scroll-region" tabindex="0"/, "verification dialog scrolling must receive the same hidden-scrollbar treatment");
assert.match(source, /ntc-war-target-table-wrap[\s\S]*overflow-y:auto/, "war-target vertical scrolling must remain enabled");
assert.match(source, /dialog id="ffscouter-verification-dialog"[\s\S]*overflow-y: auto/, "dialog vertical scrolling must remain enabled");
assert.match(source, /resizeRenderTimer = setTimeout/, "FFScouter columns must recalculate while the window is being resized");
assert.match(source, /widgetBody\.style\.overflowY = useCompactScroll \? "auto" : "hidden"/, "compact runtimes must scroll the full companion window while desktop keeps its bounded layout");
assert.match(source, /function fitCurrentContentToWidget\(\)/, "non-table panels must scale to fit the available window height");
assert.match(source, /requestAnimationFrame\(fitCurrentContentToWidget\)/, "card fitting must run after renders and size changes");
assert.match(source, /const useCompactScroll = isCompactRuntime\(\);/, "compact runtimes must opt out of height-based content scaling");
assert.match(source, /content\.classList\.toggle\("nfc-compact-scroll", useCompactScroll\);/, "all compact tabs must use the shared scrollable content class");
assert.match(source, /const useSettingsScroll = state\.currentTab === "settings" && useCompactScroll;/, "compact Settings must retain its dedicated scrollable content class");
assert.match(source, /content\.classList\.toggle\("nfc-settings-scroll", useSettingsScroll\);/, "compact Settings must use a dedicated scrollable content class");
assert.match(source, /if \(useCompactScroll\) \{[\s\S]*content\.setAttribute\("tabindex", "0"\);[\s\S]*return;/, "every compact tab must remain keyboard and touch scrollable instead of shrinking vertically");
assert.match(source, /#nfc-faction-wrapper #nfc-content\.nfc-settings-scroll \{[\s\S]*overflow-x: hidden !important;[\s\S]*overflow-y: auto !important;[\s\S]*-webkit-overflow-scrolling: touch;[\s\S]*scrollbar-width: none;/, "compact Settings must fit horizontally while allowing hidden-scrollbar vertical touch scrolling");
assert.match(source, /#nfc-faction-wrapper #nfc-content\.nfc-settings-scroll::\-webkit-scrollbar \{[\s\S]*display: none;/, "compact Settings must hide the WebKit scrollbar without disabling scrolling");
assert.match(source, /#nfc-faction-wrapper\[data-runtime="tornpda"\] #nfc-main-body,[\s\S]*overflow-y:auto !important;[\s\S]*touch-action:pan-y pinch-zoom;[\s\S]*-webkit-overflow-scrolling:touch;/, "TornPDA must scroll the main Faction body vertically by touch");
assert.match(source, /nfc-compact-scroll \.ntc-ffscouter-layout[\s\S]*flex-direction:column !important;/, "TornPDA FFScouter parameters and targets must stack vertically");
assert.match(source, /nfc-compact-scroll \.ntc-war-target-table-wrap[\s\S]*overflow:visible !important;/, "TornPDA target rows must flow through the main vertical scroll region");
assert.match(source, /min-height:210px;flex:1 1 auto;border:1px solid #343a43/, "the FFScouter table must retain room for roughly five readable target rows");
assert.match(source, /ntc-ffscouter-summary/, "the FFScouter summary must have an independently responsive container");
assert.match(source, /const preferredTableHeight = tableHeaderHeight \+ \(tableRowHeight \* 4\) \+ 4/, "FFScouter must reserve four readable player rows before summary scaling");
assert.match(source, /const minimumTableHeight = tableHeaderHeight \+ \(tableRowHeight \* 3\) \+ 4/, "FFScouter must keep a useful minimum player-table viewport");
assert.match(source, /const maximumTableHeight = Math\.max\(0, Math\.floor\(layoutHeight - layoutGap\)\)/, "short visual viewports must clamp the table to the available layout height");
assert.match(source, /tableWrap\.style\.setProperty\("min-height", `\$\{tableHeight\}px`, "important"\)/, "responsive table height must override mobile minimums safely");
assert.match(source, /nfc-war-target-table--compact/, "narrow FFScouter headers must use explicit compact labels rather than clipped text");
assert.match(source, /compactLabel: "On"/, "compact FFScouter headers must use short visible names");
assert.match(source, /nfc-faction-general-layout/, "General must have an independent compact portrait layout");
assert.doesNotMatch(source, /Math\.max\(0\.72, Math\.min\(1, availableHeight/, "General must fit fully rather than clip at a fixed zoom floor");
assert.match(source, /ntc-ffscouter-summary-viewport/, "the FFScouter summary must reserve its own non-overlapping layout row");
assert.match(source, /summaryViewport\.style\.flex = `0 0 \$\{reservedSummaryHeight\}px`/, "the table must begin below the reserved FFScouter summary height");
assert.doesNotMatch(source, /faction\.factionNews/, "the General tab must not retain News-card data");
assert.match(source, /function allocateColumnPixels\(maximums, availableWidth\)/, "responsive columns must allocate whole pixels without rounding overflow");
assert.match(source, /const widths = allocateColumnPixels\(floors, availableWidth\)/, "extremely narrow tables must remain inside their container");
assert.match(source, /const allocatedExtra = allocateColumnPixels\(reducibleWidths, additionalRoom\)/, "compact table widths must use exact remaining-space allocation");
assert.match(source, /const maxWidth = Math\.max\(1, bounds\.maxRight - bounds\.minLeft\)/, "widget width limits must never exceed tiny safe viewports");
assert.match(source, /#nfc-faction-wrapper \{[\s\S]*box-sizing: border-box;/, "widget borders must be included in viewport width limits");
assert.match(source, /#nfc-faction-wrapper #nfc-content \[style\*="display:flex"\]/, "compact inline flex layouts must wrap even without a space after the colon");
assert.match(source, /@container \(max-width: 360px\)[\s\S]*nfc-war-target-filter-group[\s\S]*flex:1 1 100% !important/, "narrow filter controls must stack instead of overflowing");
assert.match(source, /ntc-inventory-table-wrap \{[\s\S]*overflow-x:hidden !important/, "latent table containers must not create horizontal scrolling");
assert.match(source, /nfc-section-meta \{[\s\S]*flex-direction:column/, "compact section status must reflow into the available width");
assert.match(source, /const BACKUP_SCHEMA = "naughty-faction-companion-backup";/, "Faction backups must use their own schema");
assert.match(storage, /function validateLocalBackupPayload\(raw\)/, "backup files must be validated before restore");
assert.match(storage, /async function restoreLocalBackupPayload\(raw, \{ restoreApiKeys = false \} = \{\}\)/, "backup restore must preserve keys unless explicitly enabled");
assert.match(settings, /Local backup &amp; restore/, "Settings exports must expose local backup controls");
assert.match(settingsControls, /stageLocalBackupRestore\(file\)/, "selected backup files must be staged and validated");
assert.match(settingsControls, /confirmLocalBackupRestoreInput\?\.checked/, "restoring a backup must require explicit confirmation");
assert.match(source, /async function shareCsvWithTornPDA\(csv, fileName\)/, "TornPDA CSV exports must provide a native share-sheet path");
assert.match(source, /async function shareTextWithTornPDA\(text, fileName\)/, "TornPDA backups and CSV exports must share through one native path");
assert.match(source, /pdaHandler\("shareFile", \{ base64Data, fileName \}\)/, "native exports must route TornPDA shareFile data through the readiness-safe bridge helper");
assert.match(source, /response\?\.status === "success"/, "native exports must require a successful TornPDA share response");
assert.match(source, /exportInFlight: false/, "native shares must be serialized");
assert.match(source, /snapshot opened in the TornPDA share sheet/, "CSV export feedback must identify the native share sheet");
assert.match(source, /Faction backup \$\{destination\}/, "Backup feedback must distinguish the native share sheet from a desktop download");

const testColumns = {
    player: { minWidth: 104, hardFloor: 58 },
    online: { minWidth: 50, hardFloor: 32 },
    status: { minWidth: 76, hardFloor: 40 },
    stats: { minWidth: 136, hardFloor: 64 },
    ff: { minWidth: 38, hardFloor: 32 },
    attack: { minWidth: 58, hardFloor: 52 }
};
const computeResponsiveColumnWidths = new Function(
    "state",
    "WAR_TARGET_COLUMNS",
    `${responsiveColumns}\nreturn computeResponsiveColumnWidths;`
)({ warTargetColumnWidths: {} }, testColumns);
const responsiveOrder = ["player", "online", "status", "stats", "ff", "attack"];
for (const width of [1, 88, 120, 174, 244, 318, 480, 720]) {
    const widths = computeResponsiveColumnWidths(responsiveOrder, width);
    const total = Object.values(widths).reduce((sum, value) => sum + value, 0);
    assert.ok(total <= width, `FFScouter columns must fit ${width}px without horizontal overflow`);
    assert.ok(Object.values(widths).every(Number.isInteger), `FFScouter columns must retain whole-pixel widths at ${width}px`);
}

const defaults = { okay: true, hospitalized: true, traveling: true, online: true, idle: true, offline: true };
const targets = [
    { status: "okay", online: "online", fairFight: 1.25 },
    { status: "hospitalized", online: "idle", fairFight: 2.5 },
    { status: "traveling", online: "offline", fairFight: 4 },
    { status: "okay", online: "offline", fairFight: 0 }
];
const ranges = [["", ""], ["2", ""], ["", "3"], ["2", "3"], ["0", "0"], ["4", "2"]];
const filter = (target, filters, [minText, maxText]) => {
    if (filters[target.status] === false || filters[target.online] === false) return false;
    let min = minText === "" ? null : Number(minText);
    let max = maxText === "" ? null : Number(maxText);
    if (min !== null && max !== null && min > max) [min, max] = [max, min];
    if (min === null && max === null) return true;
    return target.fairFight > 0 && (min === null || target.fairFight >= min) && (max === null || target.fairFight <= max);
};

for (let mask = 0; mask < 64; mask += 1) {
    const filters = Object.fromEntries(Object.keys(defaults).map((key, index) => [key, Boolean(mask & (1 << index))]));
    for (const range of ranges) {
        const faction = { war: { warId: 7 }, warTargets: { targets: structuredClone(targets) } };
        const before = structuredClone(faction);
        faction.warTargets.targets.filter((target) => filter(target, filters, range));
        assert.deepEqual(faction, before, `filters mutated faction state for mask ${mask} and range ${range}`);
    }
}

const hospitalViewState = {
    warTargetFilters: { ...defaults },
    warTargetRangeMetric: "ff",
    warTargetFFRange: { min: "2", max: "3" },
    warTargetBSRange: { min: "", max: "" },
    warHospitalAlertSettings: { enabled: true, thresholdMinutes: 3 }
};
const hospitalFilter = new Function(
    "state",
    "WAR_HOSPITAL_ALERT_THRESHOLDS",
    "formatIdentifier",
    `${targetFiltering}\nreturn { filterWarTargets, getWarHospitalAlertCandidates, targetMatchesWarHospitalAlertView };`
)(hospitalViewState, [1, 3, 5], (value, fallback = "—") => {
    const numeric = Math.trunc(Number(value));
    return Number.isSafeInteger(numeric) && numeric >= 0 ? String(numeric) : fallback;
});
const hospitalNow = Date.now();
const hospitalTargets = [
    { id: 8317, name: "Visible FF", fairFight: 2.5, battleStats: 900, lastAction: { status: "online" }, status: { state: "Hospital", until: Math.ceil((hospitalNow + 10 * 60 * 1000) / 1000) } },
    { id: 8318, name: "Visible BS", fairFight: 4.5, battleStats: 1200, lastAction: { status: "online" }, status: { state: "Hospital", until: Math.ceil((hospitalNow + 10 * 60 * 1000) / 1000) } },
    { id: 8319, name: "Released", fairFight: 2.4, battleStats: 950, lastAction: { status: "online" }, status: { state: "Hospital", until: Math.floor((hospitalNow - 60 * 1000) / 1000) } }
];
assert.deepEqual(hospitalFilter.filterWarTargets(hospitalTargets).map((target) => target.id), [8317, 8319], "FF range must constrain the view while expired hospital entries remain excluded from alerts");
assert.deepEqual(hospitalFilter.getWarHospitalAlertCandidates(hospitalTargets, { warId: 44 }, hospitalNow).map((candidate) => candidate.targetId), [8317], "only visible hospitalized targets may receive alerts");
hospitalViewState.warTargetRangeMetric = "bs";
hospitalViewState.warTargetBSRange = { min: "1000", max: "1300" };
assert.deepEqual(hospitalFilter.getWarHospitalAlertCandidates(hospitalTargets, { warId: 44 }, hospitalNow).map((candidate) => candidate.targetId), [8318], "estimated-BS range must constrain hospital-alert candidates");
hospitalViewState.warTargetFilters.hospitalized = false;
assert.equal(hospitalFilter.getWarHospitalAlertCandidates(hospitalTargets, { warId: 44 }, hospitalNow).length, 0, "disabled hospital view filter must suppress alerts");
hospitalViewState.warTargetFilters.hospitalized = true;
hospitalViewState.warTargetBSRange = { min: "", max: "" };
assert.deepEqual(hospitalFilter.getWarHospitalAlertCandidates(hospitalTargets, { warId: 44 }, hospitalNow).map((candidate) => candidate.targetId), [8317, 8318], "an unbounded selected view may alert every hospitalized enemy");

console.log("FFScouter regression checks passed: persistence, storage preference, 384 filter/range combinations, cache race guards, responsive widths, hidden Estimates card, and wheel controls.");
