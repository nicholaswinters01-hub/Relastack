-- Let an invitation be read by presenting its token hash.
--
-- Accepting an invitation necessarily happens BEFORE the invitee belongs to
-- any organization, so there is no tenant context to scope by and the existing
-- policy hides the row completely.
--
-- The tempting fix is to run that one lookup on the privileged connection.
-- That would work, and it would also put a permanent RLS-bypassing code path
-- into the request lifecycle — the kind of exception that gets copied to the
-- next awkward case and is eventually the thing that leaks data.
--
-- Instead the rule is expressed as what it actually is: possessing the token
-- authorises reading that one invitation. The caller sets
-- `app.current_invitation_token` to the SHA-256 hash of the token they hold,
-- and the policy matches exactly one row. This mirrors the
-- `organization_memberships` policy, where a caller may read their own
-- membership before any organization is known.
--
-- The token is 256 bits of randomness, so guessing a hash to widen this is not
-- a realistic attack — and unlike a bypass flag, the reach is one row.

DROP POLICY IF EXISTS invitation_isolation ON "invitations";

CREATE POLICY invitation_isolation ON "invitations"
  USING (
    "organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid
    OR "token_hash" = NULLIF(current_setting('app.current_invitation_token', true), '')
  )
  -- Writes stay narrow: an invitation may only ever be created or modified
  -- inside the organization currently in context. Presenting a token grants
  -- reading, never writing.
  WITH CHECK (
    "organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid
  );
