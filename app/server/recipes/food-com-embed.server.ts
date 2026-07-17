function recipeSlug(name: string) {
  return name
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function foodComRecipeUrl(name: string, id: string) {
  const slug = recipeSlug(name);
  const recipeId = id.trim();

  if (!slug || !recipeId) {
    throw new Error("Food.com recipe link requires a non-empty recipe name and ID");
  }

  return `https://www.food.com/recipe/${slug}-${encodeURIComponent(recipeId)}`;
}

function metaAttribute(tag: string, name: string) {
  const attribute = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "iu").exec(tag);
  return attribute?.[1] ?? null;
}

export function extractFoodComOpenGraphImage(html: string, recipeUrl: string) {
  const openGraphMetaTag = html
    .match(/<meta\b[^>]*>/giu)
    ?.find((tag) => metaAttribute(tag, "name") === "og:image" || metaAttribute(tag, "property") === "og:image");
  const image = openGraphMetaTag ? metaAttribute(openGraphMetaTag, "content") : null;

  if (!image) {
    throw new Error(`Food.com recipe did not publish an OpenGraph image: ${recipeUrl}`);
  }

  return image.replace(/&amp;/gu, "&");
}

export async function getFoodComOpenGraphImage(recipeUrl: string) {
  let response: Response;

  try {
    response = await fetch(recipeUrl, {
      headers: {
        Accept: "text/html",
        "User-Agent": "FridgeFriend recipe card image resolver",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Food.com recipe image request failed for ${recipeUrl}: ${message}`);
  }

  if (!response.ok) {
    throw new Error(`Food.com recipe image request returned HTTP ${response.status}: ${recipeUrl}`);
  }

  return extractFoodComOpenGraphImage(await response.text(), recipeUrl);
}
