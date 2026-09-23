import { z } from "zod";
import {
  ArchiveCategoryBody as GeneratedArchiveCategoryBody,
  ArchiveCategoryResponse as GeneratedArchiveCategoryResult,
  CreateRuleBody as GeneratedCreateBody,
  CreateRuleResponse as GeneratedResult,
  GetCategoryArchiveImpactResponse as GeneratedImpact,
  GetRuleHistoryResponse as GeneratedHistory,
  GetRuleResponse as GeneratedRule,
  ListRulesResponse as GeneratedList,
  ReorderRulesBody as GeneratedReorderBody,
  UpdateRuleBody as GeneratedUpdateBody,
} from "@workspace/api-zod";
import { categoryName, GetCategoryResponse, wellFormed } from "./category-schemas.js";

// As for categories: OpenAPI lengths count code points, generated max() counts
// UTF-16 units. Only the text fields are corrected; everything else is generated.
export const rulePattern = z.string().regex(/\S/u).refine(value => [...value].length <= 256,
  "Use at most 256 characters.").refine(wellFormed, "Use valid Unicode text.");
const pattern = rulePattern;

export const CreateRuleBody = GeneratedCreateBody.extend({ pattern });
export const UpdateRuleBody = GeneratedUpdateBody.extend({ pattern: pattern.optional() });
export const ReorderRulesBody = GeneratedReorderBody;
export const Rule = GeneratedRule.extend({ pattern });
export const RuleResult = GeneratedResult.extend({ rule: Rule });
export const RuleList = GeneratedList.extend({ items: z.array(Rule).max(2000) });
const revision = GeneratedHistory.shape.revisions.element.extend({ pattern, categoryNameAtRevision: categoryName });
export const RuleHistory = GeneratedHistory.extend({ revisions: z.array(revision).max(1000) });

const impactRule = GeneratedImpact.shape.activeRules.element.extend({ pattern });
export const CategoryArchiveImpact = GeneratedImpact.extend({ activeRules: z.array(impactRule).max(1000) });
export const ArchiveCategoryBody = GeneratedArchiveCategoryBody;
export const ArchiveCategoryResult = GeneratedArchiveCategoryResult.extend({
  category: GetCategoryResponse, rulesChanged: z.array(Rule).max(1000),
});
