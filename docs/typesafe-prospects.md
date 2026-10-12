# TypeSafe prospect assessment for Upply

## Implemented scope

`POST /api/prospects/evaluate` adds an internal assessment step to the existing integration API. It takes one normalized company, up to 20 sourced vacancies and up to 10 anonymous candidate/vacancy pairs. It returns dimensions, vacancy classifications, candidate dispositions, contact priority and a proposed queue. The default `preview` performs no inference, incurs no TypeSafe API usage and persists nothing. Explicit `mode: evaluate` makes one bounded TypeSafe request. Neither mode sends outreach or writes to Bullhorn, Sheets or Supabase.

This repository currently contains the Bullhorn connector rather than the complete prospect-list orchestration. The calling prospect workflow must supply sourced inputs and consume the result. Installing an agent skill alone does not connect that workflow to the TypeSafe service.

## Configuration and activation

1. Review and merge this change; deploy through the existing repository workflow.
2. Configure server-side `TYPESAFE_API_KEY`; optionally pin `TYPESAFE_MODEL` instead of the `jev-latest` default. Use the existing `INTEGRATION_ADMIN_KEY` for endpoint access.
3. Map the current prospect account, vacancy and candidate sources to the input below. Preserve existing account IDs, source URLs, timestamps and CRM statuses; do not create a parallel company universe. Bullhorn remains the CRM system of record. Never map a generic Bullhorn `Active` account directly to `Cold prospect`: resolve the relationship first.
4. Call preview for a small account sample and check completeness. Evaluate 20 companies first; manually label vacancy relevance, ICP fit and match usefulness. These are model quality checks, not just software tests.
5. Calibrate the provisional thresholds on Upply data. Then add results to the current list/dashboard by company ID: dimension points, total, queue, model, rubric version, input hash, evaluation time, review reasons, vacancy evidence and match dispositions. The current endpoint does not persist these automatically.
6. Sort eligible `call` records by descending total; use candidate shortlist presence as a tie-breaker, without silently changing the canonical score. `research` records need missing-source work; `relationship_review` belongs to the relationship owner rather than cold outbound. Low scores go to `low_priority`.

The API key and workflow wiring are required before existing lists can use live TypeSafe assessments. No production list is changed by merging this code alone.

## Input example (synthetic, no real candidate information)

```json
{
  "mode": "preview",
  "company": {
    "id": "existing-account-id",
    "name": "Example Infrastructure BV",
    "employeeCount": 50,
    "relationship": "Cold prospect",
    "relationshipCheckedAt": "2026-10-12T15:00:00Z",
    "evidence": [{
      "id": "company-website",
      "url": "https://example.test/about",
      "text": "Verified source text about the employer’s infrastructure services and hiring footprint.",
      "checkedAt": "2026-10-12T15:00:00Z"
    }]
  },
  "jobs": [{
    "id": "existing-job-id",
    "title": "System Engineer",
    "description": "Manage Windows Server, Active Directory and VMware infrastructure.",
    "url": "https://example.test/jobs/system-engineer",
    "status": "open",
    "checkedAt": "2026-10-12T15:00:00Z"
  }],
  "candidates": [{
    "id": "opaque-pair-reference",
    "jobId": "existing-job-id",
    "profile": "Anonymous professional summary: five years of Windows Server, AD and VMware experience.",
    "checkedAt": "2026-10-12T15:00:00Z",
    "checks": {
      "commute": "pass",
      "salary": "unknown",
      "languages": "pass",
      "availability": "unknown",
      "employmentType": "pass"
    }
  }]
}
```

Submit JSON with `Authorization: Bearer <INTEGRATION_ADMIN_KEY>`. `evaluate` is explicit because it sends evidence to the provider and uses API tokens. Never include names, emails, phone numbers, exact addresses, raw CVs or sensitive personal details in `profile`. The adapter drops unrecognized fields, but cannot anonymize identifying information embedded inside supplied text. Only professional skill/seniority evidence is used for technical matching. Source mapping owns normalization and anonymization; this endpoint does not invent structured vacancy requirements from absent source text.

The caller computes the hard checks from verified commute limits/routes, comparable gross salary/package units, required language proficiency, availability dates and employment preferences. Missing or stale facts must become `unknown`, not `pass`. Each check accepts `pass`, `fail` or `unknown`. A failure blocks the pair; unknown requires review. A technical match never overrides a hard check. Shortlists remain recruiter suggestions and do not automatically reject or submit candidates.

## Preserved rules and provisional defaults

| Rule | Behavior |
| --- | --- |
| Canonical score | ICP 0–40, Hiring 0–30, Commercial 0–20, Strategic 0–10 |
| Missing evidence | Null dimension and null total; no imputed or renormalized points |
| Source freshness | Company evidence/candidate summary within 30 days; open vacancies/CRM relationship within 7 days; future timestamps invalid |
| Model uncertainty | Dimension requires known-evidence Choice and Score confidence at least 0.7 |
| Cold eligibility | Current, explicit `Cold prospect` relationship only |
| Call eligibility | Complete score at least 60 and at least one current, confidently relevant vacancy |
| Role scope | Support, System, Network, Cloud, Security, Workplace and infrastructure DevOps |
| Excluded roles | Application development, HVAC, facilities and physical datacenter maintenance |
| Contact priority | 200+ employees: relevant hiring manager/teamlead; smaller: director/C-level; missing size: verify |
| Candidate output | Strong/current technical fit + passing hard checks + relevant vacancy: shortlist for recruiter review |
| Traceability | Source job IDs/URLs, raw distributions, model, rubric version and input hash |

The size cutoff, freshness windows, confidence gate and minimum score are initial implementation choices, not measured performance claims. Vacancy counts reflect observed data, not proven hiring pressure or willingness to work with an agency. Reposts and expansion must be verified upstream; job age alone is not a repost. Protected characteristics must never enter the scoring rubric.

Provider errors, malformed responses and rate limits produce a safe failure with no score applied. The caller should retry transient failures with bounded backoff, and cache reusable assessments by input hash + rubric version + returned model. Re-check freshness and CRM eligibility before queue execution even if using cached raw judgments. Preserve failures and missing-data states instead of replacing a previously good score with zero.

## Validation

`npm test` covers suppression, stale/future timestamps, missing evidence, candidate hard checks, contact priority, response validation, authentication and provider failure. Provider calls in tests are synthetic; live model quality and Dutch/French domain performance require the pilot above.

Implementation references: [API contract](https://docs.typesafe.ai/api), [Score](https://docs.typesafe.ai/primitives/score), [composite scoring](https://docs.typesafe.ai/patterns/composite-scoring), [reranking cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe).
