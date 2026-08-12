# Naughty Torn Companion

Naughty Torn Companion is a Tampermonkey dashboard for [Torn](https://www.torn.com/) that brings player, faction, company, inventory, activity, and war-target information into one persistent, resizable window.

The script uses Torn API v2 for account data and optionally integrates with [FFScouter](https://ffscouter.com/) for battle-stat estimates and projected Fair Fight values during ranked wars.

## Features

- Persistent right-side dashboard that can be resized and dragged vertically.
- Compact `NTC` minimized mode.
- Persistent window size, position, selected tabs, theme, and minimized state.
- Light and dark modes.
- Live Energy, Nerve, Happiness, and Life bars with recovery timers.
- Cooldown, travel, chain, organized-crime, ranked-war, and bank-investment timers.
- Personal identity, wealth, net worth, battle stats, work stats, skills, education, perks, medals, and honors.
- Effective battle-stat calculations using passive perks, Xanax effects, and Drug Addiction penalties reported by Torn.
- Ranked War score and lead-target visualization.
- Optional FFScouter war-target table with sortable, reorderable, and resizable columns.
- Company profile, finances, employees, stock levels, and daily stock changes.
- Sortable inventory with categories, item bonuses, modifications, loan state, quantities, and estimated value.
- Activity notifications, enriched log values, Torn event links, ongoing trades, racing car/track names, property names, and player-name resolution.
- Manual refresh controls and per-section CSV exports.

## Requirements

- A modern Chromium- or Firefox-based browser.
- [Tampermonkey](https://www.tampermonkey.net/) or a compatible userscript manager supporting the `GM` APIs used by the script.
- A Torn API key with permission to access the account data you want the dashboard to display.
- Optional: a Torn API key registered with FFScouter for its war-target estimates.

## Installation

1. Install Tampermonkey from your browser's official extension store.
2. Open the [raw userscript](https://raw.githubusercontent.com/xf4k31tx/Naughty-Torn-Companion/refs/heads/main/Naughty%20Torn%20Companion.js).
3. Tampermonkey will open an installation page. Review the requested permissions and select **Install**.
4. Open or reload a supported Torn page, such as the Home, Items, Faction, Company, or Item Market page.
5. Open **Settings → Controls** in Naughty Torn Companion.
6. Enter your Torn API key and select **Save**.
7. Select **Refresh all sections** for the initial data load.

Tampermonkey checks the script's `@updateURL` for later releases. You can also manually check for userscript updates from the Tampermonkey dashboard.

## Usage

### Window controls

- Drag the header vertically to reposition the dashboard. The window remains attached to the right side of the browser.
- Resize the dashboard from its resize handle. Cards and tables adapt to the available width and height.
- Select `_` to minimize the dashboard to the small `NTC` box; select that box to restore it.
- Window state and the last selected tabs persist across supported Torn pages.

### Overview

- **General** displays the four resource bars, recovery timers, cooldowns, travel information, current money, points, level, chain information, and other high-level status details.
- **Status** displays relevant entries returned by Torn's `user/icons` endpoint, including descriptions and expiry timers. The gender icon is intentionally hidden because it is not an actionable status.

### Personal

- **Info** contains player, job, wealth, net-worth, battle-stat, and work-stat information.
- **Skills/Education** contains Torn skills and current/completed education details.
- **Perks** groups active perks by source and presents them in dashboard cards.
- **Awards** contains medal and honor summaries, descriptions, and the five tracked awards closest to completion.

Effective battle stats are estimates derived from Torn's reported base stats and applicable passive percentage modifiers. Active Xanax and Drug Addiction effects are incorporated when Torn reports them through `user/icons`.

### Faction

- **General** displays faction, chain, ranked-war, contribution, news, and member information.
- **FFScouter** displays the current enemy faction's projected battle stats and Fair Fight values alongside live Torn online, travel, hospital, and location status. Its persisted **Sort & View** controls can independently show or hide Okay, Hospitalized, Abroad/Traveling, Online, Idle, and Offline targets.
- Select column headers to sort FFScouter targets within their permanent availability groups. Okay targets remain first, hospitalized targets remain second with the nearest release first, and traveling or abroad targets remain last. Drag the header grip to reorder columns and the header edge to resize them.
- Select a player name to open their profile or **Attack** to open Torn's attack page.

### Company

Displays company profile details, income, estimated expenses and profit where permitted, employee effectiveness, stock counts, market values, and stock changes compared with the previous daily snapshot.

### Inventory

- Select sortable headers to reorder inventory data.
- Expand categories to inspect individual items.
- Review quantities, estimated market values, item bonuses, modifications, and loan state.
- The inventory table expands to use the remaining dashboard height.

### Activity

- Displays useful Torn notification counters, recent logs, recent events, and ongoing trades.
- Resolves supported numeric IDs into racing car, track, property, and player names.
- Formats known financial log fields as currency.
- Torn-provided event and `[View]` links are clickable and open in a new tab.
- The non-actionable API `competition` counter is intentionally hidden.

### Settings

- **Controls:** switch theme, save the main Torn API key, refresh all data, or refresh individual sections.
- **Integrations:** save and verify the separate FFScouter-linked Torn API key. Verification reports registration, policy, premium, and expiry status returned by FFScouter.
- **Exports:** download cached Overview, Personal, Faction, Company, Inventory, or Activity data as CSV.

## Data refresh and persistence

The dashboard caches section data to reduce unnecessary API calls. Frequently changing sections refresh more often than slower-moving data, and every section can be refreshed manually from Settings.

The following information is stored by the userscript manager on the local browser profile:

- Torn API key.
- Optional FFScouter-linked Torn API key.
- Dashboard position, dimensions, theme, active tabs, and minimized state.
- Cached section data.
- Company stock history used for daily comparisons.
- Net-worth tracking history used for live comparisons.

Clearing Tampermonkey storage or removing the script removes this locally stored state.

## Policy

### Privacy

- Naughty Torn Companion does not operate a separate backend and does not send account data to the repository owner.
- Torn requests are sent directly from the userscript to `api.torn.com`.
- FFScouter requests occur only when its integration is configured and are sent directly to `ffscouter.com` under that service's own policy.
- API keys are stored through Tampermonkey's userscript storage. Treat them as secrets, do not share them, and revoke any key you believe has been exposed.

### API and rate-limit use

- The script caches responses and batches supported requests to reduce Torn and FFScouter API usage.
- Manual refreshes and repeated page reloads can still consume API capacity.
- Missing permissions, unavailable endpoints, service errors, or rate limits may leave individual cards unavailable or using their last cached value.

### Fair use and account responsibility

- This project is an informational companion. It does not guarantee the accuracy, availability, or timeliness of Torn or FFScouter data and estimates.
- Users are responsible for complying with Torn's rules, API terms, and any third-party service terms.
- Review the source before installation and install updates only from a source you trust.
- The author is not affiliated with or endorsed by Torn or FFScouter.

## Troubleshooting

- **Dashboard does not appear:** confirm Tampermonkey is enabled, the script is enabled, and the current URL matches one of the supported Torn pages.
- **A section is empty or reports an error:** verify the Torn API key and its access permissions, then refresh that section under Settings → Controls.
- **FFScouter targets are unavailable:** save the separate 16-character FFScouter-linked key under Settings → Integrations and select **Verify**.
- **Old data remains visible:** use the relevant manual refresh button or **Refresh all sections**.
- **Layout looks incorrect after an update:** reload Torn once so Tampermonkey runs the newest installed version.

## Security

Please do not publish API keys, cached account data, or screenshots containing secrets in an issue. Revoke exposed keys through Torn immediately.

For a suspected code vulnerability, provide a minimal reproduction that contains no private account information.

## License

Naughty Torn Companion is released under the [GNU General Public License v3.0](LICENSE).

## Disclaimer

Torn, its names, game data, and related marks belong to their respective owners. FFScouter is a separate third-party service. This software is provided without warranty under the terms of the included license.
