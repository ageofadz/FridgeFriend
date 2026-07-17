export function jsonError(error: string, status: number) {
  return Response.json({ error }, { status });
}
