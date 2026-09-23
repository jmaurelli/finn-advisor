import { z } from "zod";
import { CreateRuleRunBody as GeneratedBody, CreateRuleRunResponse, ApplyRuleRunResponse,
  ListRuleRunRowsResponse } from "@workspace/api-zod";
import { codepointText } from "./transaction-schemas.js";

const id = z.string().uuid().transform(value => value.toLowerCase()).nullable();
export const CreateRuleRunBody = GeneratedBody.extend({
  scope: GeneratedBody.shape.scope.extend({ accountId: id, categoryId: id }),
});
export const RuleRun = CreateRuleRunResponse;
export const RuleRunResult = ApplyRuleRunResponse;
export const RuleRunRow = ListRuleRunRowsResponse.shape.items.element.extend({ merchant: codepointText(2000) });
export const RuleRunRows = ListRuleRunRowsResponse.extend({ items: z.array(RuleRunRow).max(200) });
export type RuleRun = z.infer<typeof RuleRun>;
export type RuleRunRow = z.infer<typeof RuleRunRow>;
export type RuleRunScope = z.infer<typeof CreateRuleRunBody>["scope"];
