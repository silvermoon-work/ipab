# Swarm authorization

The authoritative implemented protocol is
[Scope / Variable onboarding](onboarding.md). It supersedes the former
Invite/Request-CID/Response-CID/Join draft completely.

One Swarm corresponds to one immutable-Owner Scope and one IPFS private network.
All live Variables are publicly readable. Owner directly signs all management;
members hold nonexpiring Owner certificates for the exact current HEAD and their
own public profile, proving subject-key possession on every mutation.

Requests are signed self-contained files persisted locally and re-exportable.
Owner manually verifies real identity and publishes a signed X25519/AES-GCM
package. Members automatically discover it on normal use. Removal atomically
freezes old HEAD, preserves its final committed publication, rotates HEAD/PSK/
epoch and remaining packages, deletes the leaving profile, publishes the new
configuration at the unchanged URL and retires old HEAD. Persistent Owner-only
resume never unfreezes a resource.

No generic revocation, expiry, Owner recovery, content encryption or public
relay is provided. Public metadata and offline-switch windows are explicit
accepted limitations, not guarantees that all old peers instantly stop serving
content.
