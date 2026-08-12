# NearLegacy media processor

Private FastAPI/FFmpeg service used by NearLegacy before any consent evidence or recording is accepted. It validates bounded audio, checks its real duration and decoded signal, computes a normalized-audio fingerprint, and uses ElevenLabs transcription to match the server-issued one-use liveness phrase.

Deploy the container on a private HTTPS service, set `NEARYOU_PROCESSOR_TOKEN` and `ELEVENLABS_API_KEY`, then configure the web service with the same token in `NEARYOU_LEGACY_MEDIA_PROCESSOR_TOKEN` and the `/probe` URL. Health probes use `/healthz`; readiness probes use `/readyz`. Rotate the bearer token before enabling `NEARYOU_ENABLE_LEGACY_ARCHIVE`.

The application remains dark unless the web app has the processor URL/token, MFA, archive flags, migrations, and a fresh worker heartbeat. Production also requires the external one-minute worker scheduler described in the operations runbook.
