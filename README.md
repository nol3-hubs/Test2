# BADOC Hub Dashboard — Test2

This repository is a test copy of `nol3-hubs/badoc-hub`.

## Included
- BADOC Hub dashboard
- Chrome extension
- Firefox extension
- Integrated POD/POOH checker
- GitHub Actions workflows and supporting tools

## Extension version validation
The dashboard now checks the extension package version separately from the bridge protocol version.

Minimum package versions currently configured:
- Chrome: `1.0.3`
- Firefox: `69.2.7`

The extension sends its installed package version during the bridge handshake. The dashboard identifies missing or outdated package-version reporting and prevents SPX bridge-dependent actions until a compatible extension is detected.

## Notes
- This is the independent Test2 copy; the production `badoc-hub` repository was not changed.
- Keep Chrome and Firefox extension package versions in sync with the minimum versions configured in the dashboard installer.
