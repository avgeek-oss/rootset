-- Granular grants need fresh consent rather than a broader implicit grant.
UPDATE rootset_control.oauth_grants
SET revoked_at = COALESCE(revoked_at, now())
WHERE EXISTS (
  SELECT 1 FROM unnest(scopes) AS scope
  WHERE scope NOT IN ('viewer', 'member', 'admin')
);

UPDATE rootset_control.oauth_requests
SET status = 'denied'
WHERE status IN ('pending', 'approved') AND EXISTS (
  SELECT 1 FROM unnest(scopes) AS scope
  WHERE scope NOT IN ('viewer', 'member', 'admin')
);
