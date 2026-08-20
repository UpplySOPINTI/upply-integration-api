-- Required for idempotent Bullhorn inbound snapshots in public.crm_sync.
-- public.crm_sync already has RLS enabled and intentionally has no anon/authenticated policies.
create unique index if not exists crm_sync_system_entity_external_unique
  on public.crm_sync (system, entity_type, external_id);
