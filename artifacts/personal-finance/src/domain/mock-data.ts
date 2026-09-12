import type { Account, Budget, Category, CategoryRule, ImportBatch, Transaction } from './finance';

export const accounts: Account[] = [
  { id: 'acct-everyday', name: 'Everyday checking', institution: 'Harbor Bank', lastFour: '1842', balance: 6420.18, kind: 'checking', color: '#4e8f89' },
  { id: 'acct-reserve', name: 'Rainy day reserve', institution: 'Harbor Bank', lastFour: '9027', balance: 12850.4, kind: 'savings', color: '#d59b4c' },
  { id: 'acct-card', name: 'Daily card', institution: 'Northline', lastFour: '4416', balance: -1184.62, kind: 'card', color: '#b9665c' },
];

export const categories: Category[] = [
  { id: 'cat-home', name: 'Home', color: '#4e8f89', description: 'Rent, utilities, and household care' },
  { id: 'cat-food', name: 'Food & drink', color: '#d59b4c', description: 'Groceries, coffee, and meals out' },
  { id: 'cat-move', name: 'Getting around', color: '#6d83ad', description: 'Transit, fuel, and parking' },
  { id: 'cat-life', name: 'Life & fun', color: '#b9665c', description: 'Things that make the week feel like yours' },
  { id: 'cat-health', name: 'Health', color: '#759b72', description: 'Care, wellness, and prescriptions' },
  { id: 'cat-income', name: 'Income', color: '#4c8a73', description: 'Paychecks and other inflows', system: true },
  { id: 'cat-uncat', name: 'Uncategorized', color: '#9c968b', description: 'Needs a quick look', system: true },
];

export const transactions: Transaction[] = [
  { id: 'txn-01', date: '2025-03-28', merchant: 'Juniper Market', accountId: 'acct-card', amount: 84.72, kind: 'purchase', categoryId: 'cat-food', source: 'rule', assignmentReason: 'Merchant rule · “Juniper”', note: 'Weekly groceries' },
  { id: 'txn-02', date: '2025-03-27', merchant: 'Moss & Pine', accountId: 'acct-card', amount: 16.5, kind: 'purchase', categoryId: 'cat-food', source: 'manual', correctedAt: '2025-03-28', note: 'Coffee with Mira' },
  { id: 'txn-03', date: '2025-03-26', merchant: 'Luma Electric', accountId: 'acct-everyday', amount: 112.4, kind: 'purchase', categoryId: 'cat-home', source: 'rule', assignmentReason: 'Merchant rule · “Luma”' },
  { id: 'txn-04', date: '2025-03-25', merchant: 'Cedar Pharmacy', accountId: 'acct-card', amount: 38.16, kind: 'purchase', categoryId: 'cat-health', source: 'rule', assignmentReason: 'Merchant rule · “Pharmacy”' },
  { id: 'txn-05', date: '2025-03-24', merchant: 'Greenline Books', accountId: 'acct-card', amount: 42, kind: 'purchase', categoryId: 'cat-life', source: 'manual', correctedAt: '2025-03-25' },
  { id: 'txn-06', date: '2025-03-23', merchant: 'Northline Card payment', accountId: 'acct-everyday', amount: 680, kind: 'transfer', categoryId: undefined, source: 'manual', note: 'Card payment — not spending' },
  { id: 'txn-07', date: '2025-03-22', merchant: 'Wander Cab', accountId: 'acct-card', amount: 24.8, kind: 'purchase', categoryId: 'cat-move', source: 'rule', assignmentReason: 'Merchant rule · “Wander”' },
  { id: 'txn-08', date: '2025-03-20', merchant: 'Juniper Market', accountId: 'acct-card', amount: 63.22, kind: 'purchase', categoryId: 'cat-food', source: 'rule', assignmentReason: 'Merchant rule · “Juniper”' },
  { id: 'txn-09', date: '2025-03-18', merchant: 'Solace Studio', accountId: 'acct-card', amount: 78, kind: 'purchase', categoryId: undefined, source: 'uncategorized' },
  { id: 'txn-10', date: '2025-03-16', merchant: 'Brightside Payroll', accountId: 'acct-everyday', amount: 3240, kind: 'purchase', categoryId: 'cat-income', source: 'rule', assignmentReason: 'Merchant rule · “Payroll”' },
  { id: 'txn-11', date: '2025-03-13', merchant: 'Moss & Pine', accountId: 'acct-card', amount: 9.85, kind: 'purchase', categoryId: 'cat-food', source: 'rule', assignmentReason: 'Merchant rule · “Moss”' },
  { id: 'txn-12', date: '2025-03-11', merchant: 'Bloom & Co.', accountId: 'acct-card', amount: -22.5, kind: 'refund', categoryId: 'cat-life', source: 'manual', note: 'Returned candle' },
  { id: 'txn-13', date: '2025-03-08', merchant: 'Harbor Bank transfer', accountId: 'acct-reserve', amount: 400, kind: 'transfer', source: 'manual', note: 'Monthly reserve transfer' },
  { id: 'txn-14', date: '2025-03-06', merchant: 'Kindred Gym', accountId: 'acct-card', amount: 64, kind: 'purchase', categoryId: 'cat-health', source: 'uncategorized' },
];

export const budgets: Budget[] = [
  { id: 'budget-home', categoryId: 'cat-home', month: '2025-03', limit: 420 },
  { id: 'budget-food', categoryId: 'cat-food', month: '2025-03', limit: 300 },
  { id: 'budget-move', categoryId: 'cat-move', month: '2025-03', limit: 180 },
  { id: 'budget-life', categoryId: 'cat-life', month: '2025-03', limit: 150 },
  { id: 'budget-health', categoryId: 'cat-health', month: '2025-03', limit: 100 },
];

export const rules: CategoryRule[] = [
  { id: 'rule-juniper', merchantPattern: 'Juniper', categoryId: 'cat-food', enabled: true, matches: 8, updatedAt: 'Mar 28' },
  { id: 'rule-luma', merchantPattern: 'Luma', categoryId: 'cat-home', enabled: true, matches: 3, updatedAt: 'Mar 26' },
  { id: 'rule-pharmacy', merchantPattern: 'Pharmacy', categoryId: 'cat-health', enabled: true, matches: 4, updatedAt: 'Mar 25' },
  { id: 'rule-moss', merchantPattern: 'Moss', categoryId: 'cat-food', enabled: false, matches: 6, updatedAt: 'Mar 18' },
];

export const importBatches: ImportBatch[] = [
  {
    id: 'import-01',
    fileName: 'harbor-march-2025.csv',
    accountId: 'acct-everyday',
    importedAt: 'Mar 29, 2025 · 9:42 AM',
    status: 'review',
    rows: 48,
    added: 46,
    warnings: [
      { id: 'warn-01', message: '2 rows need a closer look', detail: 'A duplicate-looking transfer and a missing merchant were held back.', severity: 'attention' },
      { id: 'warn-02', message: 'Date format understood', detail: '48 dates matched the expected YYYY-MM-DD format.', severity: 'info' },
    ],
  },
];