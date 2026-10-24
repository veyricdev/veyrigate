# Vault Agent for the IdP (EXAMPLE, run 53c; see runbook-deploy §8/§9). AppRole auto-auth; the token
# is written to the shared tmpfs volume the app mounts read-only (VAULT_TOKEN_FILE=/run/vault/token).
# The token carries only the `idp-signer` policy (ops/vault/idp-signer.hcl).
vault {
  address = "https://<vault-host>:8200"
}

auto_auth {
  method "approle" {
    config = {
      role_id_file_path                   = "/vault/approle/role_id"
      secret_id_file_path                 = "/vault/approle/secret_id"
      remove_secret_id_file_after_reading = false
    }
  }

  sink "file" {
    config = {
      path = "/run/vault/token"
      mode = 0440 # group 1000 = the app user's group (volume gid)
    }
  }
}
