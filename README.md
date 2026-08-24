# Naughty Faction Companion

Naughty Faction Companion is a standalone Torn faction-operations userscript for Tampermonkey and TornPDA. It concentrates on faction state, chains, Ranked War contribution, and FFScouter target analysis without loading unrelated personal, company, inventory, or activity dashboards.

## Features

### Faction General

- Faction overview, member information, news, chain state, and Ranked War context.
- Live chain countdown and lead-target display.
- Personal Chain Hits, Chain Respect, War Hits, War Respect, bonus-hit, and milestone-bonus contribution cards.
- Clear refresh status and independently configurable refresh behavior for Faction General.

### FFScouter

- Ranked War enemy target board powered by FFScouter when configured.
- Projected battle statistics and Fair Fight values.
- Torn live status: availability, online state, travel destination, and hospital/travel release timing.
- Sortable target columns, persistent column order and widths, persistent status filters, and configurable Fair Fight ranges.
- Target attack links that open Torn’s attack page.
- Separate, verifiable FFScouter-linked Torn key so it is never silently substituted for the companion’s regular Torn key.

### Interface

- Dark and lower-glare light themes.
- Desktop move, resize, snap, and minimize controls.
- Native TornPDA detection plus the same compact-viewport trigger as the other companions: effective width ≤700px, effective height ≤520px, or scale >1.1 at ≤960px. Compact mode follows safe areas and live viewport/orientation updates.
- CSV export for cached sections.

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) or use TornPDA’s userscript support.
2. Open the [raw userscript](https://raw.githubusercontent.com/xf4k31tx/Naughty-Faction-Companion/main/Naughty%20Faction%20Companion.user.js) and install it.
3. Reload Torn and open the companion.
4. Go to **Settings → Controls**, save a Torn API key, and use **Refresh Faction**.
5. To use the target board, go to **Settings → Integrations**, save an FFScouter-registered Torn API key, and verify it.

## Usage

### Faction

Use the **General** sub-tab for the faction’s current operational picture. It includes chain and war information, contribution totals, news, and members. The companion keeps the chain timer live between data loads and makes the current refresh behavior visible.

Use the **FFScouter** sub-tab during a Ranked War to evaluate enemy targets. Click a column heading to sort. Persisted filters and Fair Fight bounds make it practical to focus on the targets appropriate to your current objective. Use **Attack** to open the corresponding Torn action page.

### Settings

- **Controls** stores the primary Torn API key, chooses the theme, resets panel layout, and refreshes faction data.
- **Auto Refresh** separately controls Faction General and FFScouter refresh intervals.
- **Integrations** stores, validates, and clears the FFScouter-linked key.
- **Exports** downloads available cached sections as CSV.

## Data sources and privacy

The companion stores keys, layout preferences, filters, cached faction data, and FFScouter display settings only in local per-script storage under its own `NFC_V1_*` namespace. Torn data is requested directly from `api.torn.com`. FFScouter is contacted only after you configure its separate integration key.

FFScouter’s availability, registration, and data-policy requirements are controlled by FFScouter. This script displays a verification result before relying on that key for target analysis.

API keys are secrets. Revoke any key that may have been exposed.

## TornPDA compatibility and storage

`PDA_storage` is the preferred durable store when the script is running in TornPDA. The companion loads its native namespace once during startup, writes related values in batches, and keeps an in-memory mirror for the interface. Existing GM/Tampermonkey values are migrated into native storage only when the native key is absent. If the native store cannot be read or written, including a quota failure, the same local GM compatibility storage remains active so saved keys, filters, layout, caches, and FFScouter settings are preserved.

TornPDA is confirmed through its native `flutterInAppWebViewPlatformReady` bridge and the `isTornPDA` handler. Browser/manager hints and a narrow viewport can inform presentation, but they do not by themselves identify the runtime as native TornPDA. The compact interface reacts independently to the usable viewport; confirmed native sessions also use TornPDA's `PDA_httpGet` handler if the declared GM network request APIs are unavailable.

The Faction Companion intentionally has one page scope only: `https://www.torn.com/factions.php*`. Its sole `@match` rule does not run from Torn's broad parent-page wildcard. The metadata retains both legacy and modern GM storage/network grants for Tampermonkey and TornPDA compatibility; `PDA_storage` itself does not require a userscript `@grant`.

## Updating and verification

Reopen the raw userscript URL in your userscript manager to update.

```powershell
node --check "Naughty Faction Companion.user.js"
node --test ffscouter-regression.test.js
```

## License

Released under the [GNU General Public License v3.0](LICENSE).
