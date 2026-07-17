import {
  createOrLoadOrganizationPlan,
  getOrganizationPlanByRequestId,
} from "../../organization/repository.server";
import { getFridgeInventoryForImage } from "../../inventories.server";
import type { Inventory } from "../../scan/schemas/inventory";
import type { QueryGraphDependencies } from "../schemas/query";
import { conversationContextFromState } from "../services/conversation-context.server";
import type { FridgeQueryStateValue } from "../state";

function correctionError(state: FridgeQueryStateValue, error: string) {
  return { context: { ...state.context, organizationPlan: null, organizationPlanError: error } };
}

function center(box: { x: number; y: number; width: number; height: number }) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function directionalIntent(query: string) {
  const normalized = query.toLowerCase();
  if (/\b(down|lower|below|bottom)\b/u.test(normalized)) return "down";
  if (/\b(up|upper|above|top)\b/u.test(normalized)) return "up";
  if (/\b(left)\b/u.test(normalized)) return "left";
  if (/\b(right)\b/u.test(normalized)) return "right";
  if (/\b(other side|opposite side|across)\b/u.test(normalized)) return "other_side";
  return null;
}

function selectedItemIds(state: FridgeQueryStateValue) {
  const context = conversationContextFromState(state);
  return [...new Set([
    ...context.selectedItemIds,
    ...context.seededItems.map((item) => item.itemId),
  ])];
}

function selectedZoneIds(state: FridgeQueryStateValue) {
  return [...new Set(conversationContextFromState(state).selectedZoneIds)];
}

function closestDirectionalZone(input: {
  inventory: Inventory;
  fromZoneId: string;
  direction: NonNullable<ReturnType<typeof directionalIntent>>;
}) {
  const fromZone = input.inventory.zones.find((zone) => zone.id === input.fromZoneId);
  if (!fromZone) return null;
  const fromCenter = center(fromZone.boundingBox);
  const candidates = input.inventory.zones
    .filter((zone) => zone.id !== fromZone.id && zone.type === fromZone.type)
    .map((zone) => ({ zone, center: center(zone.boundingBox) }));

  if (input.direction === "down") {
    return candidates
      .filter((candidate) => candidate.center.y > fromCenter.y)
      .sort((a, b) => a.center.y - b.center.y)[0]?.zone ?? null;
  }

  if (input.direction === "up") {
    return candidates
      .filter((candidate) => candidate.center.y < fromCenter.y)
      .sort((a, b) => b.center.y - a.center.y)[0]?.zone ?? null;
  }

  if (input.direction === "left") {
    return candidates
      .filter((candidate) => candidate.center.x < fromCenter.x)
      .sort((a, b) => b.center.x - a.center.x)[0]?.zone ?? null;
  }

  if (input.direction === "right") {
    return candidates
      .filter((candidate) => candidate.center.x > fromCenter.x)
      .sort((a, b) => a.center.x - b.center.x)[0]?.zone ?? null;
  }

  return candidates
    .sort((a, b) => Math.abs(b.center.x - fromCenter.x) - Math.abs(a.center.x - fromCenter.x))[0]?.zone ?? null;
}

function readableDirection(direction: NonNullable<ReturnType<typeof directionalIntent>>) {
  return direction === "other_side" ? "to the other side" : direction;
}

export function createPlanPlacementCorrectionNode(deps: QueryGraphDependencies = {}) {
  return async function planPlacementCorrectionNode(state: FridgeQueryStateValue) {
    if (!state.requestId) return correctionError(state, "Inventory correction requires a request ID.");
    if (!state.imageId) return correctionError(state, "Inventory correction requires a scanned fridge image.");

    const existing = getOrganizationPlanByRequestId(state.requestId);
    if (existing) {
      return {
        context: {
          ...state.context,
          organizationPlan: existing,
          organizationPlanError: null,
          workspaceActions: existing.status === "pending" ? [{
            type: "preview_reorganization" as const,
            placements: existing.moves.map((move) => ({ itemId: move.itemId, zoneId: move.toZoneId })),
          }] : [],
        },
      };
    }

    const inventory = deps.loadInventoryForImage
      ? await deps.loadInventoryForImage(state.imageId)
      : getFridgeInventoryForImage(state.imageId);
    if (!inventory) return correctionError(state, "Inventory correction requires a saved scanned inventory.");

    const itemIds = selectedItemIds(state).filter((itemId) => inventory.items.some((item) => item.id === itemId));
    if (itemIds.length !== 1) {
      return correctionError(state, "Inventory correction needs exactly one selected item to move.");
    }

    const item = inventory.items.find((candidate) => candidate.id === itemIds[0])!;
    if (!item.loc.zoneId) {
      return correctionError(state, `Inventory correction cannot move ${item.label} because it has no current shelf or zone.`);
    }

    const selectedTargetZones = selectedZoneIds(state).filter((zoneId) => zoneId !== item.loc.zoneId && inventory.zones.some((zone) => zone.id === zoneId));
    const direction = directionalIntent(state.query);
    const targetZone = selectedTargetZones.length === 1
      ? inventory.zones.find((zone) => zone.id === selectedTargetZones[0]) ?? null
      : direction
        ? closestDirectionalZone({ inventory, fromZoneId: item.loc.zoneId, direction })
        : null;

    if (!targetZone) {
      return correctionError(state, direction
        ? `Inventory correction could not find a valid ${readableDirection(direction)} zone for ${item.label}.`
        : `Inventory correction needs a target direction or selected destination zone for ${item.label}.`);
    }

    const fromZone = inventory.zones.find((zone) => zone.id === item.loc.zoneId);
    if (!fromZone) {
      return correctionError(state, `Inventory correction cannot move ${item.label} because its current zone ${item.loc.zoneId} is not in the scanned inventory.`);
    }

    const plan = createOrLoadOrganizationPlan({
      requestId: state.requestId,
      userId: state.userId,
      fridgeId: state.fridgeId,
      imageId: state.imageId,
      inventory,
      priority: "placement_correction",
      draft: {
        summary: `Move ${item.label} from ${fromZone.label || fromZone.id} to ${targetZone.label || targetZone.id}.`,
        moves: [{
          itemId: item.id,
          fromZoneId: fromZone.id,
          toZoneId: targetZone.id,
          rationale: direction ? `User correction: move ${readableDirection(direction)}.` : "User correction: move to the selected zone.",
        }],
      },
    });

    return {
      context: {
        ...state.context,
        organizationPlan: plan,
        organizationPlanError: null,
        workspaceActions: [{
          type: "preview_reorganization" as const,
          placements: plan.moves.map((move) => ({ itemId: move.itemId, zoneId: move.toZoneId })),
        }],
      },
    };
  };
}
