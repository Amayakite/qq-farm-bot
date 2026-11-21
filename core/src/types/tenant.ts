export {};

export type UserRole = 'owner' | 'tenant';
export type UserStatus = 'active' | 'disabled';
export type ActivationCodeType = 'new' | 'renew';
export type ActivationCodeStatus = 'unused' | 'redeemed' | 'revoked' | 'expired';

export interface UserRecord {
    id: string;
    username: string;
    password: string;
    role: UserRole;
    status: UserStatus;
    createdAt: number;
    /** null 表示永不过期（仅 owner）。 */
    expiresAt: number | null;
    /** 0 表示不限制（仅 owner）。 */
    maxAccounts: number;
    mustChangePassword?: boolean;
    note?: string;
    lastLoginAt?: number;
}

export interface PublicUser {
    id: string;
    username: string;
    role: UserRole;
    status: UserStatus;
    createdAt: number;
    expiresAt: number | null;
    maxAccounts: number;
    mustChangePassword: boolean;
    note: string;
    lastLoginAt: number | null;
}

export interface ActivationCodeRecord {
    id: string;
    codeHash: string;
    encryptedCode: string | null;
    /** 仅用于后台辨认，例如末四位。 */
    codeHint: string;
    type: ActivationCodeType;
    days: number;
    maxAccounts: number;
    /** 兑换截止时间；null 表示不限制。 */
    redeemBefore: number | null;
    createdAt: number;
    createdBy: string;
    batchId: string;
    note: string;
    targetTenantId: string | null;
    replacesId: string | null;
    replacedBy: string | null;
    redeemedAt: number | null;
    redeemedBy: string | null;
    revokedAt: number | null;
}

export interface PublicActivationCode extends Omit<ActivationCodeRecord, 'codeHash' | 'encryptedCode'> {
    status: ActivationCodeStatus;
    hasFullCode: boolean;
}

export interface AuthSession {
    token: string;
    userId: string;
    role: UserRole;
    createdAt: number;
    expiresAt: number;
}

export interface AuthContext {
    session: AuthSession;
    user: UserRecord;
}

/** 现有账号在迁移后全部归属 owner。 */
export const OWNER_ID = 'owner';
