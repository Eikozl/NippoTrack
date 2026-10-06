 # Phase 7 backend perf decisions trgm and cursor
 
 Date 2026-10-06 Phase v6.1 backend only no frontend.
 
 ## 1 pg_trgm evaluation decision SKIP migration 043
 
 Verdict SKIP additive migration 043 in this pass. Do not add CREATE EXTENSION.
 
 Why not verifiably safe:
 - Migrations run as POSTGRES admin user via pooler, not as jlt_runtime.
   jlt_runtime is least privilege with no superuser and no createdb, so it cannot create extensions.
 - Supabase preview uses Supavisor pooler in transaction mode. CREATE EXTENSION via pooler is not proven here.
   pg_trgm is allowlisted on Supabase in general, but enablement is normally via dashboard extensions schema.
   No repo migration has ever used CREATE EXTENSION, so the runner path for extensions is untested.
 - Runner wraps all files in one transaction with advisory lock and checksum gate.
   A failed extension create would roll back and block later migrations on preview.
   That would break postgres migrate on preview, which the task forbids.
 - No measured slow search. Community tables are small, search limits are capped at 20, ILIKE with ESCAPE is bounded.
   GIN trgm indexes would add write overhead without evidence of benefit.
   Per performance rules, indexes need real access patterns, not theory.
 - jlt_runtime would need EXECUTE on trgm functions for similarity ops, plus USAGE on extensions schema.
   Current grants do not cover that, and changing grants needs DBA review.
 
 What to do instead DBA step:
 1. DBA enables pg_trgm on preview via Supabase dashboard extensions, in extensions schema, outside the migration runner.
 2. Verify with a safe probe as admin that the extension exists and GIN opclasses are available.
 3. Measure a slow search with EXPLAIN ANALYZE on realistic data before adding indexes.
 4. If measured slow, add migration 043 additive with IF NOT EXISTS only, no CONCURRENTLY inside the runner transaction.
    Example targets username and display_name on user_profile, title plus body plus japanese_text on community_posts.
    Use plain CREATE INDEX IF NOT EXISTS with GIN trgm ops, plus revised grants for jlt_runtime if needed.
 5. Run postgres migrate on preview first, confirm JSON applied list, then promote.
 
 ## 2 Cursor pagination decision keep offset, no rewrite
 
 Verdict Keep offset paging for latest feed plus notifications in this pass. No cursor param added.
 Why offset stays:
 - Limits are bounded at 30 for feeds and notifications, with ORDER BY id tiebreak deterministic.
   Latest and following order by id desc, discover tab orders by like_count desc plus id desc.
   Notifications order by id desc. All have total order, no nondeterministic pages.
 - Deep pages are rare in community use. No measured OFFSET cost at current scale.
   Rewriting without evidence would violate no blind optimization.
 - Discover popular ranks by score in JS from a 50 row pool, not by a stable DB order.
   A created_at plus id cursor does not map to score order, so cursor would need new ranking contract.
 - Backwards compat would require optional cursor alongside page, plus client adoption next task.
   Adding it now without client use adds code and tests for no benefit.
 - Offset clients in frontend use page and limit today. Leaving code untouched keeps them working.
 
 When to revisit cursor:
 - If feeds show OFFSET slowdown on deep pages with EXPLAIN, or live insertion causes page drift complaints.
   Then add optional cursor for latest feed plus notifications only, keeping page as fallback.
 
 ## 3 Query counts before and after per request
 
 - getPost 1 round trip before and after. Before had 2 correlated COUNT plus EXISTS per row in SQL.
   After has LEFT JOIN plus GROUP BY with COUNT DISTINCT and MAX CASE, no per-row subplans.
 - listFeed 2 trips count plus page, 3 with author lookup, before and after.
   Page no longer has correlated subqueries, same placeholders, same mapPost shape.
 - getDiscover 5 parallel section queries plus 1 edge query, before and after.
   Popular and questions now use JOIN counts, learners decks readings untouched.
 - listNotifications unchanged 3 trips total plus unread plus page. New unread-count is 1 trip.
   New endpoint uses single COUNT with user_id and NOT is_read, covered by existing index.
 - listBlockedUsers was 1 unbounded scan, now 2 bounded count plus page with default 20 max 50.
   Empty inbox skips page query, like feeds.
