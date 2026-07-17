import type { LoaderFunctionArgs } from "react-router";

import { jsonError } from "../server/http.server";
import {
  foodComRecipeUrl,
  getFoodComOpenGraphImage,
} from "../server/recipes/food-com-embed.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const name = url.searchParams.get("name")?.trim() ?? "";
  const id = url.searchParams.get("id")?.trim() ?? "";

  if (!name || !id) {
    return jsonError("Recipe image request requires name and id query parameters", 400);
  }

  let recipeUrl: string;

  try {
    recipeUrl = foodComRecipeUrl(name, id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonError(message, 400);
  }

  try {
    const imageUrl = await getFoodComOpenGraphImage(recipeUrl);
    return Response.redirect(imageUrl, 302);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonError(`Food.com recipe image could not be embedded: ${message}`, 502);
  }
}
