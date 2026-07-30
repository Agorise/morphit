-- Morphit indexer — Postgres init.
--
-- Run ONCE as the postgres superuser to create the role and
-- database that the indexer connects to. The password is taken
-- from the MORPHIT_INDEXER_DB_PASSWORD environment variable; the
-- script aborts with a non-zero exit code if it's unset, empty,
-- or one of the well-known placeholder sentinels (e.g. left over
-- from a copy-paste of the example .env file).
--
-- Example:
--
--   MORPHIT_INDEXER_DB_PASSWORD='<your-strong-password>' \
--       sudo -E -u postgres psql -f ops/postgres/init.sql
--
-- The `-E` flag preserves the env var across the sudo boundary;
-- alternatively pass it inline:
--
--   sudo -u postgres MORPHIT_INDEXER_DB_PASSWORD='<your-pw>' \
--       psql -f ops/postgres/init.sql
--
-- Schema is NOT in this file — after the role/database exist, run
-- `npm run migrate` from apps/indexer/ to apply src/db/schema.sql.
--
-- See `docs/OPERATIONS.md` §0 ("Initial account setup") and
-- `docs/RUN-A-MORPHIT-NODE.md` step 7 ("Set up the database") for
-- the full deployment walkthrough.

\set ON_ERROR_STOP on

-- Default the psql variable to an empty string. If the env var
-- exists, \getenv overwrites; if it doesn't, the variable stays
-- empty and the server-side check below catches it. This is
-- cleaner than \if :{?var} + \quit because \quit returns exit
-- code 0, which automated runners would misread as success.
\set morphit_db_password ''
\getenv morphit_db_password MORPHIT_INDEXER_DB_PASSWORD

-- Stash into a session GUC so the DO block can read it without
-- macro-expansion. (Putting :'morphit_db_password' directly into
-- the DO body would interpolate at the client side, which makes
-- the code harder to read and creates a quoting hazard if the
-- password contains a single quote.)
SET morphit.init_password TO :'morphit_db_password';

-- Reject empty or known-placeholder passwords. Every spelling
-- that has ever appeared in this repo's example configs is
-- listed so a copy-paste of an .env.example string fails loudly
-- here rather than silently provisioning a guessable production
-- password.
DO $$
BEGIN
    IF current_setting('morphit.init_password') = '' THEN
        RAISE EXCEPTION
            'MORPHIT_INDEXER_DB_PASSWORD is unset or empty. '
            'Set it to a strong password and re-run, e.g.: '
            'MORPHIT_INDEXER_DB_PASSWORD=''<pw>'' sudo -E -u postgres '
            'psql -f ops/postgres/init.sql';
    ELSIF current_setting('morphit.init_password') IN (
        'CHANGEME',
        'CHANGE_ME',
        'CHANGE_ME_BEFORE_PRODUCTION',
        '__SET_BEFORE_DEPLOY__',
        'password',
        'postgres'
    ) THEN
        RAISE EXCEPTION
            'MORPHIT_INDEXER_DB_PASSWORD is set to a known placeholder '
            '(%); pick a real password.', current_setting('morphit.init_password');
    END IF;
END $$;

\echo 'Password sanity check passed. Creating role and database...'

CREATE ROLE morphit_indexer LOGIN PASSWORD :'morphit_db_password';

CREATE DATABASE morphit_indexer
    WITH OWNER = morphit_indexer
         ENCODING = 'UTF8'
         LC_COLLATE = 'en_US.UTF-8'
         LC_CTYPE = 'en_US.UTF-8'
         TEMPLATE = template0;

-- The indexer uses text[] array-overlap queries (&&) for
-- payment-method filtering. This is GIN-index-backed in the
-- schema, no extension needed. If future work adds full-text
-- search we'll turn on pg_trgm here.

-- Grant only what the indexer needs. The role owns the database
-- so it can create tables via migrations; it does NOT have
-- superuser or role-creation rights.
ALTER ROLE morphit_indexer NOSUPERUSER NOCREATEDB NOCREATEROLE;

-- Reset the GUC so the password doesn't linger in the session.
RESET morphit.init_password;

\echo
\echo 'Done. Next steps:'
\echo '  1. Set MORPHIT_INDEXER_DATABASE_URL in your indexer.env'
\echo '     using the password you just provisioned.'
\echo '  2. Run `npm run migrate` from apps/indexer/.'
\echo '  3. Treat the password as a secret: do NOT commit'
\echo '     indexer.env or relay.env (both are .gitignored).'
