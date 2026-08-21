-- Stores Bullhorn's reusable REST session token with the same application-level
-- AES-256-GCM encryption used for OAuth access and refresh tokens.
alter table public.integration_connections
  add column if not exists rest_token_ciphertext text;
