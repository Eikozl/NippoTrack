// Active review minutes: wall-clock elapsed rewards leaving sessions
// open for days (a real 22h+ case hit production), so study time is measured
// from grading evidence instead. Per completed session: every gap between
// consecutive grades — including session-start to first grade — capped at 5
// minutes, summed. Idle days contribute nothing; instant grade bursts count
// ~0. from is the review_sessions alias in the caller's query.
function sessionActiveMinutes(from = 'rs') {
  return `COALESCE((
    SELECT SUM(LEAST(5, EXTRACT(EPOCH FROM (e.reviewed_at - e.prev_at)) / 60.0))
    FROM (
      SELECT re.reviewed_at,
        COALESCE(
          LAG(re.reviewed_at) OVER (ORDER BY re.reviewed_at, re.id_review_event),
          ${from}.started_at
        ) AS prev_at
      FROM review_events re
      WHERE re.id_review_session = ${from}.id_review_session
    ) e
    WHERE e.prev_at IS NOT NULL
  ), 0)`;
}

module.exports = { sessionActiveMinutes };
