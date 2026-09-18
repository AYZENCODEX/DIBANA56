# CHANGES — Vault Backup Hardening, Round 5

One fix this round: SSRF protection for the webhook backup-delivery
destination. Round 4 closed a cross-user decrypt hole in envelope-mode
restore; this round is about the *server itself* being tricked into making
requests it shouldn't, via the same delivery feature.

## The bug

A vault backup schedule can be configured to POST a copy of every backup to
a user-supplied `webhookUrl` (`lib/vault-backup-delivery.ts`, config'd via
`routes/vault-backup-schedule.ts`). Validation on that URL was `isHttpUrl()`
— literally just "does `new URL()` parse it and is the scheme http(s)".
Nothing checked *where* the URL pointed.

Because the SERVER makes this request — not the user's browser — on an
unattended cron schedule, this is a textbook SSRF primitive: a malicious or
compromised account could point `webhookUrl` at `http://169.254.169.254/...`
(cloud instance metadata — often a path straight to IAM credentials),
`http://localhost:<internal-port>/...`, an internal admin panel, a
database's HTTP interface, or any other address the app's own network can
reach but the account holder can't. And it's not a one-off: it fires again
every time the schedule runs, carrying the actual encrypted backup blob in
the POST body, until the schedule is disabled.

## The fix

New `lib/ssrf-guard.ts`, `assertPublicHttpsUrl()`:
- Requires `https:` (previously `http:` was also accepted).
- Rejects a bare IP literal, or a hostname that *resolves* via a real DNS
  lookup (not string-matching — `dns.lookup(..., { all: true })`, every
  returned address checked) to anything private/loopback/link-local/
  reserved/multicast — IPv4 and IPv6, **including IPv4-mapped IPv6**
  (`::ffff:169.254.169.254`), which a naive IPv4-only or IPv6-only check
  would miss entirely.
- Rejects `localhost`/`*.localhost`/`metadata.google.internal` by name too,
  and embedded credentials in the URL.

Called at **two** points, deliberately:
1. `routes/vault-backup-schedule.ts` — at save time, so a bad URL gets
   immediate, specific feedback instead of a silent failure on the next
   scheduled run. Replaces the old `isHttpUrl()` check entirely.
2. `lib/vault-backup-delivery.ts`'s `deliverSnapshotByWebhook()` — again,
   right before every actual send. This is the check that actually matters:
   DNS answers can change after a schedule is saved, and this also protects
   any schedule that was configured before this round shipped, with no
   migration needed.

Also added at the same call site: the webhook fetch now sends
`redirect: "manual"` and treats any 3xx response as a failed delivery
instead of following it. Without this, a webhook target could pass
validation as an innocuous public URL and then respond with a redirect to
an internal address, sidestepping the check entirely — this closes that
gap, which is a materially easier attack than DNS tricks.

**Documented residual risk, not a silently-ignored one:** a sufficiently
adversarial authoritative DNS setup (near-zero TTL, alternating answers)
could in principle return a different address to this module's validation
lookup than to `fetch()`'s own internal lookup microseconds later — full
protection against that requires pinning the exact validated socket address
for the real request (a custom low-level connect/lookup override), which
isn't done here to avoid adding a new runtime dependency this round. What's
implemented closes the realistic, low-effort version of this bug (a literal
internal address, a static internal hostname, or a redirect-based bypass).

**Behavior change to be aware of:** webhook destinations must now be
`https://` — a schedule previously configured with a plain `http://`
webhook will start failing deliveries (visible as a normal failed-delivery
row in `vault_backup_deliveries`, same as a timeout or non-2xx response,
not a crash) until updated to `https://`. Email, Google Drive, and Dropbox
delivery destinations are unaffected.

**Changed**
- `artifacts/api-server/src/lib/vault-backup-delivery.ts` —
  `deliverSnapshotByWebhook()` calls `assertPublicHttpsUrl()` before
  sending, and no longer follows redirects.
- `artifacts/api-server/src/routes/vault-backup-schedule.ts` — `PUT
  /vault/backup/schedule` validates `webhookUrl` via `assertPublicHttpsUrl()`
  instead of the old scheme-only `isHttpUrl()` (removed).

**New**
- `artifacts/api-server/src/lib/ssrf-guard.ts` — `assertPublicHttpsUrl()`,
  the guard described above.

## Verification

- IPv4/IPv6 range classification was unit-tested standalone (17 cases:
  cloud metadata, RFC1918, loopback, link-local, CGNAT, TEST-NET ranges,
  multicast, IPv4-mapped IPv6, a real public IPv6 address) — all passed.
- Ran `assertPublicHttpsUrl()` end-to-end against real DNS in this sandbox:
  `https://example.com` and `https://api.github.com` are allowed;
  `https://169.254.169.254`, `https://localhost`, and `http://example.com`
  are all correctly rejected.
- Not possible in this sandbox (no DB/network access to the real app):
  confirming a live schedule with an `https://` webhook still delivers
  successfully end-to-end, and that a schedule saved before this round
  with an `http://` URL now shows a clear failed-delivery row rather than
  silently succeeding or crashing the cron sweep.
