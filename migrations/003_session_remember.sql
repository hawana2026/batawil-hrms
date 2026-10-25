-- Session persistence metadata (remember-me sessions use a longer idle window)
ALTER TABLE sessions ADD COLUMN remember boolean NOT NULL DEFAULT false;
