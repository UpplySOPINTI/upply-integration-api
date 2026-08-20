import { BULLHORN_READ_ENTITIES, readBullhornEntity } from './bullhorn-client.js';
import { getBullhornRestSession } from './bullhorn-session.js';
import { supabaseRest } from './supabase-admin.js';

const UPSERT_BATCH_SIZE = 100;

function batches(items, size = UPSERT_BATCH_SIZE) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

export async function saveBullhornEntitySnapshots({ entity, records, syncedAt = new Date() }) {
  if (!BULLHORN_READ_ENTITIES[entity]) {
    throw new Error(`Bullhorn entity is not allowlisted: ${entity}`);
  }

  const timestamp = syncedAt.toISOString();
  const validRecords = records.filter((record) => record?.id !== undefined && record?.id !== null);

  for (const batch of batches(validRecords)) {
    await supabaseRest('crm_sync', {
      method: 'POST',
      query: {
        on_conflict: 'system,entity_type,external_id',
      },
      body: batch.map((record) => ({
        system: 'bullhorn',
        entity_type: entity,
        external_id: String(record.id),
        sync_direction: 'inbound',
        sync_status: 'synced',
        last_synced_at: timestamp,
        last_error: null,
        metadata: {
          source: 'live_rest',
          bullhornDateLastModified: record.dateLastModified ?? null,
          isDeleted: record.isDeleted ?? null,
          payload: record,
        },
        updated_at: timestamp,
      })),
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
  }

  return validRecords.length;
}

export async function syncBullhornReadEntities({
  entities = Object.keys(BULLHORN_READ_ENTITIES),
  maxRecordsPerEntity = 5000,
  apply = false,
} = {}) {
  const unknownEntities = entities.filter((entity) => !BULLHORN_READ_ENTITIES[entity]);
  if (unknownEntities.length) {
    throw new Error(`Bullhorn entities are not allowlisted: ${unknownEntities.join(', ')}`);
  }

  const session = await getBullhornRestSession();
  const results = [];

  for (const entity of entities) {
    try {
      const records = await readBullhornEntity({
        entity,
        session,
        maxRecords: maxRecordsPerEntity,
      });
      const persisted = apply
        ? await saveBullhornEntitySnapshots({ entity, records })
        : 0;

      results.push({
        entity,
        ok: true,
        read: records.length,
        persisted,
        truncated: records.length >= maxRecordsPerEntity,
      });
    } catch (error) {
      results.push({
        entity,
        ok: false,
        read: 0,
        persisted: 0,
        error: error instanceof Error ? error.message : 'Unknown sync error',
      });
    }
  }

  return {
    ok: results.every((result) => result.ok),
    mode: apply ? 'apply' : 'dry-run',
    restHost: new URL(session.restUrl).host,
    entities: results,
  };
}
