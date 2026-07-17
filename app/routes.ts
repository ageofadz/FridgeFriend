import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("./routes/home.tsx"),
  route("api/scan-stream", "./routes/api.scan-stream.ts"),
  route("api/chats", "./routes/api.chats.ts"),
  route("api/query", "./routes/api.query.ts"),
  route("api/kitchen-org-plan/complete", "./routes/api.kitchen-org-plan-complete.ts"),
  route("api/inventory-crop", "./routes/api.inventory-crop.ts"),
  route("api/seed-bbox", "./routes/api.seed-bbox.ts"),
  route("api/recipe-image", "./routes/api.recipe-image.ts"),
] satisfies RouteConfig;
