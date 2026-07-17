export type FreshnessInput = {
  category: string;
  storageLocation?: string | null;
  opened?: boolean | null;
  expirationDate?: string | null;
  expirationDateSource?: "user" | "observed" | null;
};

export type FreshnessAssessment = {
  urgency: "fresh" | "use_soon" | "urgent" | "expired" | "unknown";
  source: "user_date" | "observed_date" | "recorded_date" | "estimated";
  confidence: "high" | "medium" | "low";
  date: string;
  label: string;
  dateIssue: string | null;
};

function addDays(now: Date, days: number) {
  const result = new Date(now);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function estimatedDays(input: FreshnessInput) {
  if (input.storageLocation === "freezer") return 90;
  if (input.category === "meat" || input.category === "seafood") return 2;
  if (input.category === "prepared_food" || input.category === "leftovers") return 3;
  if (input.category === "produce") return 5;
  if (input.category === "dairy") return 7;
  if (input.category === "eggs") return 21;
  if (input.category === "beverage") return input.opened ? 14 : 60;
  if (input.category === "condiment") return input.opened ? 30 : 90;
  return 30;
}

export function assessFreshness(input: FreshnessInput, now = new Date()): FreshnessAssessment {
  const parsedDate = input.expirationDate ? new Date(`${input.expirationDate}T23:59:59.999Z`) : null;
  const hasExplicitDate = parsedDate !== null && !Number.isNaN(parsedDate.valueOf());
  const dateIssue = input.expirationDate && !hasExplicitDate
    ? `Recorded expiry date ${input.expirationDate} is invalid.`
    : null;
  const target = hasExplicitDate ? parsedDate : addDays(now, estimatedDays(input));
  const days = Math.floor((target.valueOf() - now.valueOf()) / 86_400_000);
  const urgency = days < 0 ? "expired" : days <= 1 ? "urgent" : days <= 3 ? "use_soon" : "fresh";
  const source = input.expirationDateSource === "user"
    ? "user_date"
    : input.expirationDateSource === "observed"
      ? "observed_date"
      : hasExplicitDate
        ? "recorded_date"
      : "estimated";
  const confidence = source === "user_date" ? "high" : source === "observed_date" || source === "recorded_date" ? "medium" : "low";

  return {
    urgency,
    source,
    confidence,
    date: target.toISOString().slice(0, 10),
    label: dateIssue
      ? `${dateIssue} Estimated use by ${target.toISOString().slice(0, 10)}`
      : source === "estimated"
        ? `Estimated use by ${target.toISOString().slice(0, 10)}`
        : `Use by ${target.toISOString().slice(0, 10)}`,
    dateIssue,
  };
}
