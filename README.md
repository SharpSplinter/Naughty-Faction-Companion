# Naughty Faction Companion

Naughty Faction Companion is a standalone Torn faction-operations userscript for Tampermonkey and TornPDA. It concentrates on faction state, chains, Ranked War contribution, and FFScouter target analysis without loading unrelated personal, company, inventory, or activity dashboards.

## Project goals

This open-source userscript gives Torn factions a focused, local operations view for chains, Ranked War contribution, and optional FFScouter target analysis. Its goals are useful live context, privacy-conscious credential handling, predictable refresh behavior, and equal usability on desktop Tampermonkey and TornPDA. It is an independent community project and is not affiliated with Torn, TornPDA, or FFScouter.

## Features

### Faction General

- Faction overview, member information, news, chain state, and Ranked War context.
- Live chain countdown and lead-target display.
- Personal Chain Hits, Chain Respect, War Hits, War Respect, bonus-hit, and milestone-bonus contribution cards.
- Clear refresh status and independently configurable refresh behavior for Faction General.

### FFScouter

- Scheduled and live Ranked War enemy target board powered by FFScouter when configured, including pre-war scouting once Torn exposes the opponent.
- Projected battle statistics and Fair Fight values.
- Torn live status: availability, online state, travel destination, and hospital/travel release timing.
- Sortable target columns, persistent column order and widths, persistent status filters, configurable Fair Fight ranges, and a persistent collapsible **Sort & View** control panel.
- Target attack links that open Torn’s attack page.
- Hospital-release notifications configured from **Settings → Controls**; they honor the current FFScouter status, activity, FF, and estimated-BS filters.
- Separate, verifiable FFScouter-linked Torn key so it is never silently substituted for the companion’s regular Torn key.

### Staff Dashboard

- Optional Staff tab with Statuses, active weapon Loans, Bleeders, Revives, and active-war availability summaries.
- Every Staff subtab uses the same freshness row, named refresh action, responsive list rows, and single shared vertical scroller as the rest of the companion.
- The last valid Staff response is cached locally for offline/stale disclosure and backup/restore. The approved service origin is fixed to `https://naughtybot.unifiedbot.net`; its optional token is header-authenticated, excluded from normal backups, and never shown after it is saved.

### Interface

- Dark and lower-glare light themes.
- Desktop move, resize, snap, and minimize controls. The minimized launcher opens from any tap/click and can be dragged independently; its last launcher position is retained.
- Separate runtime and layout detection: Runtime reports Desktop or TornPDA, while the measured panel uses narrow, compact, standard, or wide layout profiles. Safe areas, rotation, visual-viewport changes, zoom, and the keyboard overlay update the layout without resetting the selected tab or form state.
- One hidden-scrollbar body scroller supports desktop wheel/keyboard navigation and TornPDA touch/inertial scrolling. Cards, settings, FFScouter filters, and target rows stay in normal flow, so long content remains reachable without nested-scroll traps or horizontal movement.
- Compact portrait and landscape reflow keeps controls, cards, statuses, filters, and tables inside the usable viewport. FFScouter keeps its controls above the target list and wraps table content rather than requiring horizontal scrolling.
- Strict Faction-page lifecycle handling for Torn and TornPDA navigation. If Torn changes pages without replacing the document, the companion immediately hides its existing panel and suspends refresh/countdown activity; returning to `factions.php` restores the same panel without duplicating its event handlers. User-enabled native hospital notifications remain scheduled.
- User-triggered CSV export and JSON backup for cached local data: TornPDA opens its native share sheet through `shareFile({ base64Data, fileName })`, while desktop/Tampermonkey downloads the file locally. Android and iOS choose Files or another destination from that system sheet rather than a browser save-location picker. A native share failure is shown as an error instead of being mislabeled as a download, and simultaneous share requests are prevented.
- Native TornPDA toast feedback for successful saves, refreshes, reminder actions, and recoverable errors; desktop keeps its in-panel status feedback.

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) or use TornPDA’s userscript support.
2. Open the [raw userscript](https://raw.githubusercontent.com/SharpSplinter/Naughty-Faction-Companion/main/Naughty%20Faction%20Companion.user.js) and install it.
3. Reload Torn and open the companion.
4. Go to **Settings → Controls**, save a Torn API key, and use **Refresh Faction**.
5. To use the target board, go to **Settings → Integrations**, save an FFScouter-registered Torn API key, and verify it.

## Usage

### Faction

Use the **General** sub-tab for the faction’s current operational picture. It includes chain and war information, contribution totals, news, and members. The companion keeps the chain timer live between data loads and makes the current refresh behavior visible.

Use the **FFScouter** sub-tab once Torn exposes a scheduled or active Ranked War to scout enemy targets before the fight begins. Click a column heading to sort. **Sort & View** can be collapsed to preserve list space; its filters and Fair Fight bounds persist. Hospital-release alerts only begin after the Ranked War starts. Use **Attack** to open the corresponding Torn action page.

### Settings

- **Controls** shows Runtime, Screen/Panel Size, Layout Profile, and Storage Method; stores the primary Torn API key, chooses the theme, enables/disables hospital-release alerts, selects the 1/3/5-minute threshold, resets alert settings, resets panel layout, refreshes faction data, and can schedule or cancel a TornPDA-native faction reminder. Desktop leaves native reminder controls disabled.
- **Auto Refresh** separately controls Faction General and FFScouter refresh intervals.
- **Integrations** stores, validates, and clears the FFScouter-linked key and configures the optional Staff Dashboard. The Staff integration only uses the declared NaughtyBot origin; its optional token is sent in request headers and is not displayed after saving.
- **Exports** saves available cached sections as CSV and can save or load a complete local JSON backup. Backups include local faction data, layout, refresh preferences, cached snapshot, and stock/networth history. API keys are excluded by default; including them at download and restoring them later both require separate explicit confirmation. TornPDA uses the system share sheet for both CSV and backup files.

## Data sources and privacy

The companion stores keys, layout preferences, filters, cached faction data, and FFScouter display settings only in local per-script storage under its own `NFC_V1_*` namespace. Torn data is requested directly from `api.torn.com`. FFScouter is contacted only after you configure its separate integration key.

FFScouter’s availability, registration, and data-policy requirements are controlled by FFScouter. This script displays a verification result before relying on that key for target analysis.

API keys are secrets. Revoke any key that may have been exposed.

## TornPDA compatibility and storage

Settings → Controls displays the current runtime, usable screen size, and storage method. `PDA_storage` is the default durable store in TornPDA, with GM/Tampermonkey storage as its fallback. The optional unchecked **Use legacy GM storage** setting makes GM storage primary; switching modes copies the companion's saved values to the new primary store where available, while the other backend remains a fallback. Ordinary native writes are briefly debounced and merged into `setMany` batches; quota or native-write failures fall back to GM storage. Clearing a saved value uses TornPDA's `PDA_storage.delete(key)` plus the compatible GM/local fallback.

Backup restore accepts only versioned `naughty-faction-companion-backup` files from this companion. The file is validated before its details are shown, then a second checkbox and browser confirmation are required before local data is replaced. Existing API keys are preserved unless a key-containing backup is explicitly opted into during restore. Restoring only changes this userscript’s local storage; it never changes Torn, TornPDA, or FFScouter data.

When TornPDA injects its API-key marker, the companion automatically uses that key without rendering, persisting, or logging its value. The Settings field instead says that TornPDA’s injected key is active. Automatic refresh timers pause whenever the document is hidden or TornPDA reports that the webview/tab is inactive, then safely resume when it becomes active again.

TornPDA is confirmed through its native `flutterInAppWebViewPlatformReady` bridge and the `isTornPDA` handler. Browser/manager hints and a narrow viewport can inform presentation, but they do not by themselves identify the runtime as native TornPDA. The compact interface reacts independently to the usable viewport; confirmed native sessions also use TornPDA's `PDA_httpGet` handler if the declared GM network request APIs are unavailable.

The Faction Companion intentionally has one page scope only: `https://www.torn.com/factions.php*`. Its sole `@match` rule does not run from Torn's broad parent-page wildcard. The metadata retains both legacy and modern GM storage/network grants for Tampermonkey and TornPDA compatibility; `PDA_storage` itself does not require a userscript `@grant`.

## Diagnostics

Browser developer tools show concise diagnostics by default: startup and confirmed runtime state, native bridge and storage fallback decisions, plus each API request's method, host, path, status, and duration. Request queries, headers, bodies, API keys, and other credentials are deliberately omitted or redacted from these logs.

## Updating and verification

Reopen the raw userscript URL in your userscript manager to update.

```powershell
node --check "Naughty Faction Companion.user.js"
node --test ffscouter-regression.test.js storage-adapter.test.js
```

## Community and governance

- [Contributing guidelines](CONTRIBUTING.md) explain how to propose code and documentation changes.
- [Code of Conduct](CODE_OF_CONDUCT.md) sets expectations for every project space.
- [Security policy](SECURITY.md) explains how to report a vulnerability privately.
- Use the [bug report](https://github.com/SharpSplinter/Naughty-Faction-Companion/issues/new?template=bug_report.yml) and [feature request](https://github.com/SharpSplinter/Naughty-Faction-Companion/issues/new?template=feature_request.yml) forms for public feedback.
- Source is available under the permissive [MIT License](LICENSE).

## License

Released under the [MIT License](LICENSE).
