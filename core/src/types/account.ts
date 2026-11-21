export {};
export type AccountIssueReason = 'login_required' | 'kicked' | 'session_lost' | 'disconnected' | 'worker_failed';

export interface AccountIssue {
  reason: AccountIssueReason;
  at: number;
}

export function requiresNewCode(issue: AccountIssue | null | undefined): boolean {
  return issue?.reason === 'login_required' || issue?.reason === 'kicked' || issue?.reason === 'session_lost';
}

export interface Account {
  id: string;
  name: string;
  code: string;
  platform: string;
  uin: string;
  qq: string;
  avatar: string;
  nick?: string;
  /** 账号归属的租户/用户；旧数据迁移后默认为 owner。 */
  ownerId: string;
  runEnabled: boolean;
  codeConsumed: boolean;
  lastRunIssue: AccountIssue | null;
  createdAt: number;
  updatedAt: number;
}

export interface AccountsData {
  accounts: Account[];
  nextId: number;
}
