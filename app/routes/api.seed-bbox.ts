import { z } from "zod";
import type { ActionFunctionArgs } from "react-router";

import { BoundingBox } from "../server/scan/schemas/inventory";
import { seedInventoryBoundingBox } from "../server/query/services/seeded-bounding-box.server";

const SeedBoundingBoxRequest = z.object({
  imageId: z.string().min(1),
  boundingBox: BoundingBox,
});

function jsonError(error: string, status: number) {
  return Response.json({ error }, { status });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return jsonError("Seed bounding box request must use POST", 405);
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonError(`Seed bounding box request body is invalid JSON: ${message}`, 400);
  }

  const parsed = SeedBoundingBoxRequest.safeParse(body);

  if (!parsed.success) {
    return jsonError(
      `Seed bounding box request is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      400,
    );
  }

  try {
    const result = await seedInventoryBoundingBox(parsed.data);
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonError(`Seed bounding box request failed: ${message}`, 500);
  }
}
