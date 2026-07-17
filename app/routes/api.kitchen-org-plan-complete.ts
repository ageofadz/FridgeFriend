import type { ActionFunctionArgs } from "react-router";

import { completeOrganizationPlan } from "../server/organization/repository.server";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: `Unsupported method ${request.method}` }, { status: 405 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: `Kitchen organization completion body was not valid JSON: ${message}` }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || !("planId" in body) || typeof body.planId !== "string" || body.planId.trim().length === 0) {
    return Response.json({ error: "Kitchen organization completion requires planId" }, { status: 400 });
  }
  try {
    const result = completeOrganizationPlan(body.planId.trim());
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes("is stale") ? 409 : message.includes("was not found") ? 404 : 409;
    return Response.json({ error: message }, { status });
  }
}
