export interface CredentialView {
  id: string;
  clientId: string;
  clientSecretHint: string;
  status: "active" | "revoked";
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** Returned exactly once, when a credential is created or rotated. Never re-readable afterwards. */
export interface IssuedCredential {
  credential: CredentialView;
  clientSecret: string;
  webhookSecret: string;
}
