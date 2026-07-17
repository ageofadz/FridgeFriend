import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("./routes/home.tsx"),
  route("api/query", "./routes/api.query.ts"),
  route("api/inventory-crop", "./routes/api.inventory-crop.ts"),
  route("api/seed-bbox", "./routes/api.seed-bbox.ts"),
  route("api/recipe-image", "./routes/api.recipe-image.ts"),
] satisfies RouteConfig;
