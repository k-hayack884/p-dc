const STORAGE_PREFIX = "bike-streetview:";
const EXPORT_SCHEMA = "bike-streetview-local-data";
const EXPORT_VERSION = 1;

export type AppDataExport = {
  schema: typeof EXPORT_SCHEMA;
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  items: Record<string, string>;
};

export type ImportAppDataResult = {
  importedCount: number;
  skippedCount: number;
};

export function exportAppData(storage: Storage): AppDataExport {
  const items: Record<string, string> = {};

  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(STORAGE_PREFIX)) continue;

    const value = storage.getItem(key);
    if (value === null) continue;

    items[key] = value;
  }

  return {
    schema: EXPORT_SCHEMA,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    items,
  };
}

export function serializeAppDataExport(data: AppDataExport): string {
  return JSON.stringify(data, null, 2);
}

export function appDataExportFilename(date = new Date()): string {
  const timestamp = date
    .toISOString()
    .replaceAll(":", "")
    .replace(/\.\d{3}Z$/, "Z");
  return `bike-streetview-data-${timestamp}.json`;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.entries(value).every(
    ([key, item]) => typeof key === "string" && typeof item === "string"
  );
}

export function parseAppDataExport(jsonText: string): AppDataExport {
  const parsed = JSON.parse(jsonText) as Partial<AppDataExport>;

  if (
    parsed.schema !== EXPORT_SCHEMA ||
    parsed.version !== EXPORT_VERSION ||
    typeof parsed.exportedAt !== "string" ||
    !isStringRecord(parsed.items)
  ) {
    throw new Error("Bike Street Viewの移行データではありません");
  }

  return {
    schema: parsed.schema,
    version: parsed.version,
    exportedAt: parsed.exportedAt,
    items: parsed.items,
  };
}

export function importAppData(
  storage: Storage,
  data: AppDataExport
): ImportAppDataResult {
  let importedCount = 0;
  let skippedCount = 0;
  const existingKeys = Array.from({ length: storage.length }, (_, index) =>
    storage.key(index)
  ).filter((key): key is string => Boolean(key?.startsWith(STORAGE_PREFIX)));

  existingKeys.forEach((key) => storage.removeItem(key));

  Object.entries(data.items).forEach(([key, value]) => {
    if (!key.startsWith(STORAGE_PREFIX)) {
      skippedCount++;
      return;
    }

    storage.setItem(key, value);
    importedCount++;
  });

  return { importedCount, skippedCount };
}
