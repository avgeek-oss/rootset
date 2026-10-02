export function reportError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .split("\nCall log:")[0]
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(
      /(?:cookie|authorization|set-cookie)\s*:[^\r\n]*/gi,
      "[redacted credential header]",
    )
    .replace(
      /\b(?:rs_(?:key|live)_[A-Za-z0-9_-]+|rootset\.session_token=[^\s;]+)/g,
      "[redacted credential]",
    )
    .replace(
      /([?&](?:token|code|client_secret|secret|recovery_code|password|access_token|refresh_token)=)[^\s&#"<>]+/gi,
      "$1[redacted]",
    );
}
