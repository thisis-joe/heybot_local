const configuredSecrets = new Set<string>();
export function maskSecret(value: string | undefined): void {
  if (value && value.length >= 8) configuredSecrets.add(value);
}
export function redact(value: string): string {
  let clean = value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, match => match.replace(/[^\r\n]/g, '*'))
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[\w-]{15,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[\w-]{12,}|eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+)\b/g, '[REDACTED_CREDENTIAL]')
    .replace(/(\b[\w-]*(?:password|(?:api|private|access|secret)[_-]?key|(?:auth|access|client|refresh)[_-]?token|client[_-]?secret)["']?\s*[:=]\s*)(["'`])([^\r\n]{4,}?)(\2)/gi, '$1$2[REDACTED_CREDENTIAL]$4')
    .replace(/(https?:\/\/)[^\s/@"':]+:[^\s/@]+@/gi, '$1[REDACTED_CREDENTIAL]@');
  for (const secret of configuredSecrets) clean = clean.split(secret).join('[REDACTED_CREDENTIAL]');
  return clean;
}
