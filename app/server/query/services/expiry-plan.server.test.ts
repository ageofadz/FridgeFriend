import { describe, expect, it } from "vitest";

import { buildExpiryPlan } from "./expiry-plan.server";

describe("expiry plan", () => {
  it("prioritizes urgent food, excludes duplicate household entries, and keeps expired food out of recipe priorities", () => {
    const plan = buildExpiryPlan({
      scannedItems: [
        {
          id: "milk-1",
          displayName: "Milk",
          canonicalName: "milk",
          category: "dairy",
          subcategory: null,
          location: { zoneType: "shelf" },
          attributes: { opened: true, expirationDate: "2026-07-18", expirationDateSource: "observed" },
        },
        {
          id: "chicken-1",
          displayName: "Chicken",
          canonicalName: "chicken breast",
          category: "meat",
          subcategory: "chicken",
          location: { zoneType: "shelf" },
          attributes: { opened: null, expirationDate: "2026-07-16", expirationDateSource: "user" },
        },
      ],
      householdItems: [
        { id: "milk-memory", name: "Milk", canonicalName: "milk", storageLocation: "fridge", status: "available", expirationDate: "2026-07-18" },
        { id: "pasta", name: "Pasta", canonicalName: "pasta", storageLocation: "pantry", status: "available", expirationDate: null },
      ],
      now: new Date("2026-07-17T00:00:00.000Z"),
    });

    expect(plan.priorityItems.map((item) => item.id)).toEqual(["milk-1"]);
    expect(plan.expiredItems.map((item) => item.id)).toEqual(["chicken-1"]);
    expect(plan.items.map((item) => item.id)).not.toContain("household:milk-memory");
  });
});
