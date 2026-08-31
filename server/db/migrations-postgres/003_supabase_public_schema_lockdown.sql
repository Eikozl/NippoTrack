-- JLT has no browser-to-PostgREST access. Remove inherited public-schema access
-- after jlt_runtime has received its explicit USAGE grant.
REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC;
