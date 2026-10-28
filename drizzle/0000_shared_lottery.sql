CREATE TABLE app_state (
    id TEXT PRIMARY KEY NOT NULL,
    data TEXT NOT NULL CHECK (json_valid(data)),
    revision TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE administrators (
    id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
    user_id TEXT NOT NULL UNIQUE
);
