# Bullhorn read integration: go-live runbook

This runbook activates the prepared read-only Bullhorn integration without changing the canonical Upply Jobs Sales Layer architecture. Bullhorn remains the CRM and system of record. The Sales Layer continues to own external signals, scoring, prioritisation, suppression and workflow intelligence.

## Scope and safeguards

- Allowed Bullhorn entities: `ClientCorporation`, `ClientContact`, `Candidate`, `JobOrder`, `Opportunity`, `Note`, and `Task`.
- No Bullhorn write-back is implemented.
- Explicit field lists are used; wildcard reads are rejected by design.
- Imported records are mirrored inbound into the existing `crm_sync` table under RLS.
- Dry-run is the default. Persisting data requires the explicit JSON value `"mode": "apply"`.
- Readiness, sync, and legacy diagnostics require `Authorization: Bearer <INTEGRATION_ADMIN_KEY>`.

## One-time environment check

Set `INTEGRATION_ADMIN_KEY` in the Vercel Production environment to a long random value. Do not commit or paste the value into tickets, logs, or documentation. Confirm `/api/config-check` returns:

```json
{
  "ok": true,
  "internalAdminConfigured": true
}
```

The stable Bullhorn redirect URI must remain exactly:

```text
https://upply-integration-api.vercel.app/api/bullhorn/oauth/callback
```

## Activation after Bullhorn resolves OAuth

1. After the dedicated read-only API user has accepted Bullhorn's terms once, open `https://upply-integration-api.vercel.app/api/bullhorn/connect`. The service authorizes that API user server-side and forwards only the authorization-code callback to the browser; the username and password are never placed in the browser URL.
2. Confirm `GET /api/bullhorn/status` reports a connected Bullhorn connection.
3. Probe all allowed entity permissions without returning entity payloads:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer $INTEGRATION_ADMIN_KEY" \
  https://upply-integration-api.vercel.app/api/bullhorn/readiness
```

4. Run a capped dry-run. This establishes a REST session and counts readable records but writes nothing:

```bash
curl --fail-with-body \
  -X POST \
  -H "Authorization: Bearer $INTEGRATION_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"maxRecordsPerEntity":500}' \
  https://upply-integration-api.vercel.app/api/bullhorn/sync
```

5. Apply the lower-sensitivity CRM and vacancy entities first:

```bash
curl --fail-with-body \
  -X POST \
  -H "Authorization: Bearer $INTEGRATION_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"mode":"apply","entities":["ClientCorporation","ClientContact","JobOrder","Opportunity"],"maxRecordsPerEntity":5000}' \
  https://upply-integration-api.vercel.app/api/bullhorn/sync
```

6. Validate counts and a small sample in `crm_sync`, then explicitly approve the second batch before importing `Candidate`, `Note`, or `Task` data.
7. Run the sensitive second batch only after that validation and approval.

## Acceptance criteria

- OAuth callback finishes and `/api/bullhorn/status` is `connected`.
- Readiness reports each entitled entity independently; one unavailable entity does not hide the others.
- Dry-run persists zero records.
- Repeating an apply run updates the same `crm_sync` keys instead of duplicating them.
- `system = bullhorn`, `sync_direction = inbound`, and `sync_status = synced` are preserved.
- No Bullhorn fields or statuses are translated into Sales Layer statuses during ingestion.
- No write request is sent to Bullhorn.

## Current intentional limitation

The initial import uses Bullhorn's documented `start`/`count` pagination and a per-entity safety cap. Incremental `dateLastModified` checkpoints should be added only after the live tenant confirms the exact field and query behaviour for every entitled entity.
