/**
 * Storage adapter factory — resolves the correct backend from config.
 */

import type { StorageAdapter, StorageConfig } from "./interface.ts";
import { JsonFileAdapter } from "./json-file.ts";
import { CosmosDbAdapter } from "./cosmosdb.ts";
import { AzureSqlAdapter } from "./azuresql.ts";
import { SharePointAdapter } from "./sharepoint.ts";

const adapterCache = new Map<string, StorageAdapter>();

export async function getStorageAdapter(config: StorageConfig): Promise<StorageAdapter> {
  const key = config.provider + ":" + JSON.stringify(config);

  if (adapterCache.has(key)) {
    return adapterCache.get(key)!;
  }

  let adapter: StorageAdapter;

  switch (config.provider) {
    case "json-file":
      adapter = new JsonFileAdapter(config);
      break;
    case "cosmosdb":
      adapter = new CosmosDbAdapter(config);
      break;
    case "azuresql":
      adapter = new AzureSqlAdapter(config);
      break;
    case "sharepoint":
      adapter = new SharePointAdapter(config);
      break;
    case "supabase":
      throw new Error("Supabase adapter runs natively in Supabase Edge Functions — use the supabase/ directory instead");
    default:
      throw new Error("Unknown storage provider: " + config.provider);
  }

  await adapter.init();
  adapterCache.set(key, adapter);
  return adapter;
}
