## Summary
<!-- One or two sentences: what changed, for whom, and why now? -->

## Context / Motivation
<!-- Link issues/specs/figma/docs. What problem are we solving? What success looks like. -->

## Changes
<!-- High-level bullets of what this PR does. Prefer nouns/verbs over file lists. -->
- [ ] …

### API / Contracts
<!-- New endpoints, request/response shapes, status codes, events. -->
- **Endpoint(s):** …
- **Breaking?** Yes / No

### Data / Migrations
<!-- Schema changes, indexes, seeds, data backfills. -->
- **Migration:** Yes / No
- **Rollback path:** …

### Config / Env
<!-- New or changed env vars, feature flags, secrets management. -->
- **Env vars:** …

### Security / Privacy
<!-- AuthZ, sensitive data, PII, rate limits, abuse vectors, token scopes. -->
- Notes: …

### Observability
<!-- Logs, metrics, traces, dashboards, alerts. -->
- Notes: …

## Testing
- [ ] Ran locally (`npm run dev`) and exercised the change
- [ ] Unit tests added/updated
- [ ] Integration/E2E tests (if applicable)
- [ ] Typecheck/lint pass

### Verification Steps (copy-paste if helpful)
```bash
# example
curl -s -X POST http://localhost:3001/... -H "Content-Type: application/json" -d '{...}'
