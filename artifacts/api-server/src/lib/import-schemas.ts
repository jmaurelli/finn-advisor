import { z } from "zod";
import {
  BulkSetImportRowTypeBody, BulkSetImportRowTypeResponse, CreateImportResponse, GetImportResponse,
  ListImportFormatsResponse, ListImportRowsResponse, ListImportsQueryParams, ListImportsResponse,
  RefreshImportResponse, UpdateImportRowBody, UpdateImportRowResponse,
} from "@workspace/api-zod";

/** The contract's own names for the import payloads this stage serves. */
export const ImportFormatList = ListImportFormatsResponse;
export const ImportPage = ListImportsResponse;
export const ImportListQuery = ListImportsQueryParams;
export const ImportCreateResult = CreateImportResponse;
export const ImportBatchDto = GetImportResponse;
export const ImportRowPage = ListImportRowsResponse;
export const ImportRowPatch = UpdateImportRowBody;
export const ImportRowResult = UpdateImportRowResponse;
export const BulkTypeBody = BulkSetImportRowTypeBody;
export const BulkTypeResult = BulkSetImportRowTypeResponse;
export const ImportRefreshResult = RefreshImportResponse;

export type ImportBatchDto = z.infer<typeof GetImportResponse>;
export type ImportCreateResult = z.infer<typeof CreateImportResponse>;
export type ImportListQuery = z.infer<typeof ListImportsQueryParams>;
export type ImportRowPage = z.infer<typeof ListImportRowsResponse>;
export type ImportRowPatch = z.infer<typeof UpdateImportRowBody>;
