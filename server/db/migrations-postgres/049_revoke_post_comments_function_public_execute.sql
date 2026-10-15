-- 049 revokes PUBLIC execution of the post_comments single-level trigger
-- function. Trigger functions run with the privileges of the invoking write,
-- so jlt_runtime keeps working through its table grants; only the default
-- PUBLIC execute grant is removed, matching the project's least-privilege
-- posture (cf. REVOKE ... FROM PUBLIC / anon, authenticated in 041).
-- Forward-only, idempotent (REVOKE IF EXISTS equivalent: revoking an absent
-- grant is a no-op NOTICE, never an error).
REVOKE EXECUTE ON FUNCTION public.jlt_post_comments_one_level() FROM PUBLIC;
