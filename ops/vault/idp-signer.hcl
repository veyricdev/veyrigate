# Vault policy for the IdP token signer (run 53, plan D9, runbook-deploy §8).
#
# Placeholders: replace <mount> with VAULT_TRANSIT_MOUNT (default "transit") and <key> with
# VAULT_TRANSIT_KEY before `vault policy write idp-signer idp-signer.hcl`.
#
# Least privilege: sign with ONE key, read its public metadata, rotate it, and move its version
# floors (emergency rotation). No export, backup, delete, create, or any other key/path.
# `allowed_parameters` is what stops this token from flipping `exportable`, `deletion_allowed`,
# `allow_plaintext_backup` or `auto_rotate_period` through the config endpoint (test V6).

path "<mount>/sign/<key>" {
  capabilities = ["update"]
}

path "<mount>/keys/<key>" {
  capabilities = ["read"]
}

path "<mount>/keys/<key>/rotate" {
  capabilities = ["update"]
}

path "<mount>/keys/<key>/config" {
  capabilities = ["update"]
  allowed_parameters = {
    "min_decryption_version" = []
    "min_encryption_version" = []
  }
}

path "<mount>/keys/<key>/trim" {
  capabilities = ["update"]
  allowed_parameters = {
    "min_available_version" = []
  }
}
