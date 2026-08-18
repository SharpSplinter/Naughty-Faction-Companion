# Naughty Faction Companion

Naughty Faction Companion is a standalone Tampermonkey userscript for Torn faction operations. It provides the Faction overview, chain and Ranked War tracking, personal war contribution, and the FFScouter target board without loading Personal, Company, Inventory, or activity data.

## Features

- Faction overview with member, news, chain, and Ranked War information.
- Live chain countdown and Ranked War lead-target display.
- Personal Chain Hits, Chain Respect, War Hits, War Respect, and Bonus Hit information.
- FFScouter enemy-faction targets with projected battle stats and Fair Fight values.
- Torn live status for each target: availability, online state, travel/hospital release timing, and destination.
- Sortable, reorderable, resizable FFScouter columns plus persistent status and Fair Fight range filters.
- Persistent per-view auto-refresh controls for Faction General and FFScouter.
- Separate Torn and FFScouter API-key storage, light/dark themes, window snapping, resizing, and minimized mode.

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open the [raw userscript](https://raw.githubusercontent.com/xf4k31tx/Naughty-Faction-Companion/refs/heads/main/Naughty%20Faction%20Companion.user.js).
3. Install the script, then reload Torn.
4. Open **Settings → Controls**, save a Torn API key, then select **Refresh Faction**.
5. To use the target board, save and verify an FFScouter-linked Torn API key in **Settings → Integrations**.

## Usage

### Faction

- **General** displays faction and war details, the chain timer, contribution cards, news, and member information.
- **FFScouter** displays Ranked War enemy targets. Sort by any column, move or resize columns, filter by state or activity, and set an optional Fair Fight range.
- **Attack** opens Torn’s attack page for that target.

### Settings

- **Controls** saves the Torn API key, changes the theme, resets the window, and refreshes faction data.
- **Auto Refresh** independently enables/disables and configures refresh intervals for Faction General and FFScouter.
- **Integrations** stores and verifies the separate FFScouter-linked API key.
- **Exports** downloads the cached faction snapshot as CSV.

## Data and privacy

The script stores its API keys, UI preferences, filters, and cached faction data only in Tampermonkey storage under its own `NFC_V1_*` namespace. It sends Torn requests directly to `api.torn.com` and only contacts `ffscouter.com` when FFScouter is configured.

API keys are secrets. Revoke any key you believe has been exposed.

## License

Released under the [GNU General Public License v3.0](LICENSE).
