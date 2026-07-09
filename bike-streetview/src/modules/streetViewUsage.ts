const STORAGE_KEY = "bike-streetview:street-view-monthly-usage";

export const STREET_VIEW_MONTHLY_FREE_CAP = 5_000;

export type StreetViewMonthlyUsage = {
  month: string;
  count: number;
};

function currentMonthKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function emptyUsage(): StreetViewMonthlyUsage {
  return {
    month: currentMonthKey(),
    count: 0,
  };
}

export function loadStreetViewMonthlyUsage(): StreetViewMonthlyUsage {
  try {
    const currentMonth = currentMonthKey();
    const storedValue = window.localStorage.getItem(STORAGE_KEY);
    if (!storedValue) return emptyUsage();

    const parsed = JSON.parse(storedValue) as Partial<StreetViewMonthlyUsage>;
    if (
      parsed.month !== currentMonth ||
      typeof parsed.count !== "number" ||
      !Number.isFinite(parsed.count) ||
      parsed.count < 0
    ) {
      return emptyUsage();
    }

    return {
      month: parsed.month,
      count: Math.floor(parsed.count),
    };
  } catch {
    return emptyUsage();
  }
}

export function recordStreetViewUsage(
  increment = 1
): StreetViewMonthlyUsage {
  const currentUsage = loadStreetViewMonthlyUsage();
  const nextUsage = {
    ...currentUsage,
    count: currentUsage.count + Math.max(0, Math.floor(increment)),
  };

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextUsage));
  return nextUsage;
}
