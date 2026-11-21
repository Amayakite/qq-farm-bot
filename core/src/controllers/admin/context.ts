import type { Application } from 'express';
import type { Server } from 'node:http';
import type { Server as SocketIOServer } from 'socket.io';
import type { createScanCoordinator } from '../../services/account-scan/coordinator';
export {};

const { createSessionStore } = require('../../models/session-store');

/**
 * AdminContext factory
 * Creates and holds all shared state for the admin server.
 */

export interface AdminContext {
    /** token -> { userId, role, expiresAt } */
    tokens: ReturnType<typeof createSessionStore>;
    app: Application | null;
    server: Server | null;
    io: SocketIOServer | null;
    provider: any;
    scanTasks?: ReturnType<typeof createScanCoordinator>;
}

function createAdminContext(dataProvider: any): AdminContext {
    const tokens = createSessionStore();
    return {
        tokens,
        app: null,
        server: null,
        io: null,
        provider: dataProvider,
    };
}

module.exports = { createAdminContext };
