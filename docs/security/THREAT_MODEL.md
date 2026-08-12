# NearYou threat model

Status: pre-production controls; child microphone, Postgres cutover, mobile billing, integrations, and posthumous synthesis remain disabled.

## Assets and trust boundaries

- Adult identity, household membership, consent receipts, child profiles, voice samples, generated media, archive memories, billing entitlements, provider tokens, and deletion/export records.
- Browser/mobile → NearYou API → D1/PostgreSQL/R2/queues → OpenAI/ElevenLabs/Stripe/RevenueCat/Spotify/YouTube.
- Every resource is tenant-bound by `household_id`; provider secrets and raw OAuth tokens remain server-side.

## Primary threats and required controls

- Voice impersonation: adult-owned liveness evidence, versioned purpose/audience consent, revocation, no child cloning, provenance and audit logs.
- Child microphone capture: parent-started co-use, visible microphone, transient rolling buffer, jurisdiction kill switch, no retention by default.
- Cross-household access: server membership checks plus forced PostgreSQL RLS and negative tests under least-privilege roles.
- Posthumous misuse: synthesis off after death-state transition until consent/custodian review; never claim AI is the person.
- Malicious source URLs: fixed provider origins, IDs not arbitrary URLs, MIME/magic/checksum validation, no YouTube ripping.
- Billing fraud/replay: signed raw-body webhooks, event-id uniqueness, ordering, app/environment/product allowlists, opaque account mapping.
- Administrator abuse: MFA, reason-coded time-bound support access, immutable audit events, no unrestricted media browser.
- Media worker compromise: unprivileged container, isolated canonical paths, restricted ffmpeg protocols, bounded work, partial cleanup, no public listener.

Residual legal gates require specialist COPPA, GDPR/UK GDPR, biometric/voice, publicity/estate, subscription, tax, and app-store review before country activation.
