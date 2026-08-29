# Patch Notes

## v1.1.95 — Auto-refresh settings persistence

- Fixed Auto Refresh changes so the Save button waits for storage to confirm the write.
- Added clear in-window saving, success, and failure feedback instead of failing silently.
- Preserved the exact interval entered in Settings across tab changes and reloads.
- Kept full Faction General refreshes capped at once per minute to protect Torn's shared API limit; the saved preference is no longer rewritten by that safety cap.
- Added regression coverage for dashboard setting snapshots and the visible save path.
