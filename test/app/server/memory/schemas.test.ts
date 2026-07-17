import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DietaryRestrictionCandidateSchema,
  GoalCandidateSchema,
  MemoryCandidateSchema,
  MemoryExtractionResultSchema,
} from "../../../../app/server/memory/schemas";

const restrictionCandidate = {
  kind: "dietary_restriction",
  scope: "user",
  action: "upsert",
  restrictionType: "allergy",
  subject: "peanuts",
  severity: "strict_avoid",
  notes: null,
  explicit: true,
};

describe("memory candidate schemas", () => {
  it("exposes named per-kind schemas that agree with the union", () => {
    expect(DietaryRestrictionCandidateSchema.parse(restrictionCandidate))
      .toEqual(MemoryCandidateSchema.parse(restrictionCandidate));
    expect(GoalCandidateSchema.shape.kind.value).toBe("goal");
  });

  it("rejects kind/action combinations outside each kind's enum", () => {
    expect(MemoryCandidateSchema.safeParse({
      ...restrictionCandidate,
      action: "consume",
    }).success).toBe(false);
    expect(MemoryCandidateSchema.safeParse({
      kind: "goal",
      scope: "user",
      action: "remove",
      goalType: "high_protein",
      description: "Eat more protein",
      explicit: true,
    }).success).toBe(false);
  });
});

describe("MemoryExtractionResultSchema", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps valid candidates while dropping invalid ones with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const parsed = MemoryExtractionResultSchema.parse({
      candidates: [
        restrictionCandidate,
        {
          kind: "dietary_restriction",
          scope: "user",
          action: "consume",
          restrictionType: "allergy",
          subject: "shellfish",
          severity: "avoid",
          explicit: true,
        },
      ],
    });

    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.candidates[0]).toMatchObject({ subject: "peanuts" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("kind=dietary_restriction action=consume");
  });

  it("normalizes provider preference sentiment vocabulary before strict parsing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const parsed = MemoryExtractionResultSchema.parse({
      candidates: [
        {
          kind: "preference",
          scope: "user",
          action: "upsert",
          subject: "bright acidic food",
          sentiment: "enjoy",
          strength: 4,
          notes: null,
          explicit: true,
        },
        {
          kind: "preference",
          scope: "user",
          action: "upsert",
          subject: "crisp vegetables",
          sentiment: "positive",
          strength: 4,
          notes: null,
          explicit: true,
        },
        {
          kind: "preference",
          scope: "user",
          action: "upsert",
          subject: "bitter greens",
          sentiment: "negative",
          strength: 5,
          notes: null,
          explicit: true,
        },
      ],
    });

    expect(parsed.candidates).toEqual([
      expect.objectContaining({
        kind: "preference",
        sentiment: "like",
        subject: "bright acidic food",
      }),
      expect.objectContaining({
        kind: "preference",
        sentiment: "like",
        subject: "crisp vegetables",
      }),
      expect.objectContaining({
        kind: "preference",
        sentiment: "dislike",
        subject: "bitter greens",
      }),
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("stores LLM-classified dietary identities with valid restriction severity", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const parsed = MemoryExtractionResultSchema.parse({
      candidates: [
        {
          kind: "dietary_restriction",
          scope: "user",
          action: "upsert",
          restrictionType: "other",
          subject: "vegetarian",
          severity: "vegetarian",
          notes: null,
          explicit: true,
        },
      ],
    });

    expect(parsed.candidates).toEqual([
      expect.objectContaining({
        kind: "dietary_restriction",
        scope: "user",
        action: "upsert",
        restrictionType: "other",
        subject: "vegetarian",
        severity: "strict_avoid",
        explicit: true,
      }),
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("stores explicit LLM-classified dietary restrictions when severity is not a storage enum", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const parsed = MemoryExtractionResultSchema.parse({
      candidates: [
        {
          kind: "dietary_restriction",
          scope: "user",
          action: "upsert",
          restrictionType: "other",
          subject: "vegetarian",
          severity: "required diet",
          notes: null,
          explicit: true,
        },
      ],
    });

    expect(parsed.candidates).toEqual([
      expect.objectContaining({
        kind: "dietary_restriction",
        scope: "user",
        action: "upsert",
        restrictionType: "other",
        subject: "vegetarian",
        severity: "strict_avoid",
        explicit: true,
      }),
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("normalizes provider preference sentiment objects before strict parsing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const parsed = MemoryExtractionResultSchema.parse({
      candidates: [
        {
          kind: "preference",
          scope: "user",
          action: "upsert",
          subject: "spicy food",
          sentiment: { value: "likes" },
          strength: 4,
          notes: null,
          explicit: true,
        },
        {
          kind: "preference",
          scope: "user",
          action: "upsert",
          subject: "bitter food",
          sentiment: { polarity: "hates" },
          strength: 4,
          notes: null,
          explicit: true,
        },
      ],
    });

    expect(parsed.candidates).toEqual([
      expect.objectContaining({
        kind: "preference",
        subject: "spicy food",
        sentiment: "like",
      }),
      expect.objectContaining({
        kind: "preference",
        subject: "bitter food",
        sentiment: "dislike",
      }),
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("repairs explicit preference candidates with unmappable sentiment values", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const parsed = MemoryExtractionResultSchema.parse({
      candidates: [
        {
          kind: "preference",
          scope: "user",
          action: "upsert",
          subject: "mystery food",
          sentiment: "sometimes",
          strength: 3,
          notes: null,
          explicit: true,
        },
      ],
    });

    expect(parsed.candidates).toEqual([
      expect.objectContaining({
        kind: "preference",
        scope: "user",
        action: "upsert",
        subject: "mystery food",
        sentiment: "like",
        strength: 3,
        explicit: true,
      }),
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("defaults missing candidates to an empty list", () => {
    expect(MemoryExtractionResultSchema.parse({})).toEqual({ candidates: [] });
  });
});
