import { z } from "zod";
import {
  CreateCategoryBody as GeneratedCreateBody,
  UpdateCategoryBody as GeneratedUpdateBody,
  GetCategoryResponse as GeneratedCategory,
  CreateCategoryResponse as GeneratedResult,
  ListCategoriesResponse as GeneratedList,
} from "@workspace/api-zod";

// OpenAPI lengths count code points; generated Zod max() counts UTF-16 units.
// Keep the generated object constraints, correcting only these text fields.
// A lone UTF-16 surrogate cannot be stored as UTF-8 without being replaced;
// refuse it rather than save something other than what was sent.
export const wellFormed = (value: string) => !/\p{Cs}/u.test(value);
export const categoryName = z.string().regex(/\S/u).refine(value => [...value].length <= 60,
  "Use at most 60 characters.").refine(wellFormed, "Use valid Unicode text.");
const name = categoryName;
const description = z.string().refine(value => [...value].length <= 280,
  "Use at most 280 characters.").refine(wellFormed, "Use valid Unicode text.");

export const CreateCategoryBody = GeneratedCreateBody.extend({ name, description: description.nullish() });
export const UpdateCategoryBody = GeneratedUpdateBody.extend({ name: name.optional(), description: description.nullish() });
export const GetCategoryResponse = GeneratedCategory.extend({ name, description: description.nullable() });
export const CreateCategoryResponse = GeneratedResult.extend({ category: GetCategoryResponse });
export const UpdateCategoryResponse = CreateCategoryResponse;
export const ReactivateCategoryResponse = CreateCategoryResponse;
export const ListCategoriesResponse = GeneratedList.extend({ items: z.array(GetCategoryResponse).max(1000) });
