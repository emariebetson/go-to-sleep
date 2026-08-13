# NearYou Waitlist Operations

The application database is authoritative. The private native Google Sheet `NearYou Waitlist` in the founder's main Drive is the marketing mirror.

## Launch gate

1. Apply migration `0016_marketing_waitlist`.
2. Configure a random 32-byte hexadecimal `MARKETING_WAITLIST_ENCRYPTION_KEY`.
3. Create a least-privilege Google service account with Sheets access only.
4. Share only the `NearYou Waitlist` Sheet with the service-account email.
5. Configure `GOOGLE_WAITLIST_SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, and the server-only private key.
6. Configure a random 32+ character `MARKETING_SYNC_SECRET`.
7. Provision an external one-minute POST to `/api/internal/marketing-waitlist-sync` with `Authorization: Bearer <secret>` because Sites does not provide a production cron declaration.
8. Submit one canary and confirm one encrypted D1 contact, one interest set, one completed sync operation, and one Sheet row.

Do not put an email address in logs, URLs, analytics, error text, or scheduler payloads. Do not share the Sheet publicly or by public link. A sync outage may queue signups in D1; alert on pending operations older than five minutes and any dead-letter row.

## Sheet contract

The `Waitlist` tab uses columns A–H: hidden contact ID, Email, Product interests, Signup source, Consent version, Consented at, Status, and Last synced at. The sync worker owns rows and uses the opaque contact ID rather than searching by email.
