# Contributing to Naughty Faction Companion

Thanks for helping improve a local Torn faction-operations companion for Tampermonkey and TornPDA.

## Before you start

- Search existing issues before opening a new one.
- Use the bug or feature issue form so maintainers can reproduce and evaluate the change.
- Discuss new Torn selections, FFScouter behavior, automatic refresh policies, or broad interface changes in an issue before writing code.

## Security and privacy

Never commit or post Torn API keys, FFScouter-linked keys, request URLs containing keys, member data, war target lists, private backups, or unredacted screenshots. Use redacted examples and synthetic data in issues, pull requests, and tests. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in a public issue.

## Development workflow

1. Fork the repository and create a focused branch.
2. Make the smallest practical change. Preserve the script's one-page faction scope, local-only data handling, and TornPDA/Tampermonkey compatibility.
3. Run the checks from the repository root:

   ```powershell
   node --check "Naughty Faction Companion.user.js"
   node --test ffscouter-regression.test.js
   node --test storage-adapter.test.js
   ```

4. If the change affects layout, verify a normal desktop viewport and a narrow/portrait viewport. If it affects native behavior, export, reminders, or API access, also verify TornPDA where available.
5. Update the README when installation, refresh behavior, privacy, compatibility, or visible behavior changes.

## Pull requests

Describe the faction-use case, the solution, and the checks you ran. Include redacted screenshots for UI changes and say whether TornPDA was exercised. Avoid unrelated formatting churn, generated files, and any credential-bearing fixture. Contributions must follow the [Code of Conduct](CODE_OF_CONDUCT.md) and are licensed under the repository's [MIT License](LICENSE).
