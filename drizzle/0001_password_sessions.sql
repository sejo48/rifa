CREATE TABLE admin_sessions (
    token_hash TEXT PRIMARY KEY NOT NULL,
    expires_at INTEGER NOT NULL,
    auth_version TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX admin_sessions_expiry ON admin_sessions (expires_at);
--> statement-breakpoint
CREATE TABLE login_attempts (
    id TEXT PRIMARY KEY NOT NULL,
    window_start INTEGER NOT NULL,
    attempts INTEGER NOT NULL
);
