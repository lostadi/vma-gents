# Compatibility profiles

`claude-desktop.json` is the single repository source of truth for the private
Claude VM inputs that have been reviewed with this launcher. Setup refuses a
source bundle or helper image whose origin, hash, or size differs from this
profile.

The profile does not claim compatibility with every Claude Desktop release.
Qualify a changed bundle and helper together before changing these values; an
application version alone is not sufficient evidence that the embedded VM
artifacts are compatible.
