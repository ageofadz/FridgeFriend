import { createHash, randomUUID } from "node:crypto";

import { Inventory as InventorySchema, type Inventory } from "../scan/schemas/inventory";
import { withDatabase } from "../sqlite.server";
import { OrganizationPlanSchema, type OrganizationPlan, type OrganizationPlanDraft } from "./schemas";

function fingerprintInventory(inventory: Inventory) {
  return createHash("sha256").update(JSON.stringify(inventory)).digest("hex");
}

function parsePlan(value: string, id: string) {
  try {
    return OrganizationPlanSchema.parse(JSON.parse(value));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Kitchen organization plan ${id} is invalid: ${message}`);
  }
}

export function getOrganizationPlanByRequestId(requestId: string) {
  return withDatabase((_db, sqlite) => {
    const row = sqlite.prepare("select id, plan_json from kitchen_organization_plans where request_id = ?").get(requestId) as { id: string; plan_json: string } | undefined;
    return row ? parsePlan(row.plan_json, row.id) : null;
  });
}

export function createOrLoadOrganizationPlan(input: {
  requestId: string;
  userId: string;
  fridgeId: string;
  imageId: string;
  inventory: Inventory;
  draft: OrganizationPlanDraft;
  priority?: OrganizationPlan["priority"];
}) {
  return withDatabase((_db, sqlite) => {
    const existing = sqlite.prepare("select id, plan_json from kitchen_organization_plans where request_id = ?").get(input.requestId) as { id: string; plan_json: string } | undefined;
    if (existing) return parsePlan(existing.plan_json, existing.id);

    const now = new Date().toISOString();
    const plan: OrganizationPlan = {
      ...input.draft,
      id: randomUUID(),
      requestId: input.requestId,
      userId: input.userId,
      fridgeId: input.fridgeId,
      imageId: input.imageId,
      inventoryFingerprint: fingerprintInventory(input.inventory),
      priority: input.priority ?? "food_safety_freshness",
      status: "pending",
      createdAt: now,
      completedAt: null,
    };
    const create = sqlite.transaction(() => {
      sqlite.prepare("update kitchen_organization_plans set status = 'superseded' where fridge_id = ? and status = 'pending'").run(input.fridgeId);
      sqlite.prepare("insert into kitchen_organization_plans (id, request_id, user_id, fridge_id, image_id, inventory_fingerprint, status, plan_json, created_at, completed_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        plan.id,
        plan.requestId,
        plan.userId,
        plan.fridgeId,
        plan.imageId,
        plan.inventoryFingerprint,
        plan.status,
        JSON.stringify(plan),
        plan.createdAt,
        null,
      );
    });
    create();
    return plan;
  });
}

export function completeOrganizationPlan(planId: string) {
  return withDatabase((_db, sqlite) => {
    const complete = sqlite.transaction(() => {
      const row = sqlite.prepare("select plan_json from kitchen_organization_plans where id = ?").get(planId) as { plan_json: string } | undefined;
      if (!row) throw new Error(`Kitchen organization plan ${planId} was not found`);
      const plan = parsePlan(row.plan_json, planId);
      if (plan.status === "completed") return { plan, inventory: null };
      if (plan.status !== "pending") throw new Error(`Kitchen organization plan ${planId} cannot be completed because it is ${plan.status}`);
      const inventoryRow = sqlite.prepare("select inventory_json from fridge_inventories where image_id = ?").get(plan.imageId) as { inventory_json: string } | undefined;
      if (!inventoryRow) throw new Error(`Kitchen organization plan ${planId} cannot be completed because inventory for image ${plan.imageId} was not found`);
      const inventory = InventorySchema.parse(JSON.parse(inventoryRow.inventory_json));
      const markStale = () => {
        const stalePlan = { ...plan, status: "stale" as const };
        sqlite.prepare("update kitchen_organization_plans set status = ?, plan_json = ? where id = ?").run(stalePlan.status, JSON.stringify(stalePlan), plan.id);
        throw new Error(`Kitchen organization plan ${planId} is stale because the recorded inventory changed after planning`);
      };
      if (fingerprintInventory(inventory) !== plan.inventoryFingerprint) markStale();
      const zones = new Map(inventory.zones.map((zone) => [zone.id, zone]));
      const items = new Map(inventory.items.map((item) => [item.id, item]));
      for (const move of plan.moves) {
        const item = items.get(move.itemId);
        if (!item || item.loc.zoneId !== move.fromZoneId || !zones.has(move.toZoneId)) markStale();
      }
      const now = new Date().toISOString();
      const moved = new Map(plan.moves.map((move) => [move.itemId, move]));
      const updatedInventory: Inventory = {
        ...inventory,
        items: inventory.items.map((item) => {
          const move = moved.get(item.id);
          if (!move) return item;
          const zone = zones.get(move.toZoneId)!;
          return {
            ...item,
            stack: undefined,
            ...(item.scene?.status === "placed" ? {
              scene: {
                ...item.scene,
                supportKind: "zone" as const,
                supportId: zone.id,
              },
            } : {}),
            loc: {
              ...item.loc,
              status: "matched",
              zoneId: zone.id,
              zoneType: zone.type,
              assignment: { source: "user_confirmed", planId: plan.id, updatedAt: now },
            },
          };
        }),
      };
      const completedPlan: OrganizationPlan = { ...plan, status: "completed", completedAt: now };
      sqlite.prepare("update fridge_inventories set inventory_json = ?, updated_at = ? where image_id = ?").run(JSON.stringify(updatedInventory), now, plan.imageId);
      sqlite.prepare("update kitchen_organization_plans set status = ?, plan_json = ?, completed_at = ? where id = ?").run(completedPlan.status, JSON.stringify(completedPlan), now, plan.id);
      return { plan: completedPlan, inventory: updatedInventory };
    });
    return complete();
  });
}
