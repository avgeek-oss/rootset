-- Earlier protocol digests were unkeyed and cannot safely protect password input.
-- Pending approval payloads expire without executing; consumed outcomes stay readable.
UPDATE rootset_control.account_actions
 SET digest='',expires_at=LEAST(expires_at,now()-interval '1 second'),payload_encrypted='',
 result=CASE WHEN consumed_at IS NULL THEN jsonb_build_object('reason','approval_protocol_updated','message','This request expired after a security update; start a new account action.') ELSE result END;
-- The installation stays claimed. Old setup retries cannot reuse an unkeyed digest;
-- verification can be resent through the existing authentication flow.
UPDATE rootset_control.bootstrap SET claim_digest=NULL WHERE claim_digest IS NOT NULL;
