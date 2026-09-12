export type TransactionKind = 'purchase' | 'refund' | 'transfer';
export type AssignmentSource = 'manual' | 'rule' | 'uncategorized';

export type Account = {
  id: string;
  name: string;
  institution: string;
  lastFour: string;
  balance: number;
  kind: 'checking' | 'savings' | 'card';
  color: string;
};

export type Category = {
  id: string;
  name: string;
  color: string;
  description: string;
  system?: boolean;
};

export type Transaction = {
  id: string;
  date: string;
  merchant: string;
  accountId: string;
  amount: number;
  kind: TransactionKind;
  categoryId?: string;
  source: AssignmentSource;
  assignmentReason?: string;
  note?: string;
  correctedAt?: string;
};

export type Budget = {
  id: string;
  categoryId: string;
  month: string;
  limit: number;
};

export type CategoryRule = {
  id: string;
  merchantPattern: string;
  categoryId: string;
  enabled: boolean;
  matches: number;
  updatedAt: string;
};

export type ImportBatch = {
  id: string;
  fileName: string;
  accountId: string;
  importedAt: string;
  status: 'review' | 'complete';
  rows: number;
  added: number;
  warnings: { id: string; message: string; detail: string; severity: 'attention' | 'info' }[];
};