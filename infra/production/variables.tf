variable "project_id" {



  type = string




  validation {



    condition = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))



    error_message = "Invalid project ID."



  }
}
variable "data_residency" {



  type = string




  validation {



    condition = contains(["US", "CANADA"], var.data_residency)



    error_message = "Residency must be US or CANADA."



  }
}
variable "deployment_approved" {



  type = bool



  default = false
}
variable "evidence_collection_approved" {
  type        = bool
  default     = false
  description = "Separate reviewed approval for operational evidence sampling only; never enables products."
}
variable "scheduler_paused" {

  type = bool

  default = true

  validation {

    condition = var.scheduler_paused

    error_message = "IaC only creates paused schedulers."

  }
}
variable "scheduler_evidence" {

  type = object({

    verified = bool,

    artifact_digest = string,

    principal = string,

    audience = string,

    verified_at = string

  })

  default = null

  validation {

    condition = var.scheduler_evidence == null || (try(var.scheduler_evidence.verified, false) && can(regex("^sha256:[0-9a-f]{64}$", try(var.scheduler_evidence.artifact_digest, ""))) && try(var.scheduler_evidence.audience, "") == var.scheduler_audience && can(timecmp(try(var.scheduler_evidence.verified_at, ""), timestamp())))

    error_message = "Verified scheduler evidence must bind artifact, principal, audience and time."

  }
}
variable "secret_bootstrap_evidence" {

  type = object({

    complete = bool,

    app_version = string,

    legacy_version = string,

    pad_version = string,

    checksum = string,

    verified_at = string

  })

  default = null

  sensitive = true

  validation {

    condition = var.secret_bootstrap_evidence == null || (try(var.secret_bootstrap_evidence.complete, false) && can(regex("^[1-9][0-9]*$", try(var.secret_bootstrap_evidence.app_version, ""))) && can(regex("^[1-9][0-9]*$", try(var.secret_bootstrap_evidence.legacy_version, ""))) && can(regex("^[1-9][0-9]*$", try(var.secret_bootstrap_evidence.pad_version, ""))) && can(regex("^sha256:[0-9a-f]{64}$", try(var.secret_bootstrap_evidence.checksum, ""))))

    error_message = "Secret bootstrap evidence must reference immutable versions and checksum."

  }
}
variable "migration_evidence" {

  type = object({

    status = string,

    release_id = string,

    schema_checksum = string,

    artifact_digest = string,

    completed_at = string

  })

  default = null

  validation {

    condition = var.migration_evidence == null || (try(var.migration_evidence.status, "") == "succeeded" && try(var.migration_evidence.release_id, "") == var.release_id && try(var.migration_evidence.schema_checksum, "") == var.schema_checksum && try(var.migration_evidence.artifact_digest, "") == trimprefix(var.migration_image_digest, "@"))

    error_message = "Migration evidence must match release, schema, and artifact."

  }
}
variable "migration_image_digest" {

  type = string

  validation {

    condition = can(regex("@sha256:[0-9a-f]{64}$", var.migration_image_digest))

    error_message = "Immutable migration image digest required."

  }
}
variable "release_id" {

  type = string

  validation {

    condition = can(regex("^[A-Za-z0-9._-]{8,128}$", var.release_id))

    error_message = "Invalid release ID."

  }
}
variable "schema_checksum" {

  type = string

  validation {

    condition = can(regex("^sha256:[0-9a-f]{64}$", var.schema_checksum))

    error_message = "Invalid schema checksum."

  }
}
variable "legacy_image_digest" {



  type = string




  validation {



    condition = can(regex("@sha256:[0-9a-f]{64}$", var.legacy_image_digest))



    error_message = "An immutable image digest is required."



  }
}
variable "pad_image_digest" {
  type = string
  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.pad_image_digest))
    error_message = "An immutable PAD image digest is required."
  }
}
variable "readiness_decision_image_digest" {
  type = string
  validation {
    condition     = can(regex("^.+@sha256:[0-9a-f]{64}$", var.readiness_decision_image_digest))
    error_message = "An immutable readiness-decision image digest is required."
  }
}
variable "readiness_gateway_disposable" {
  type    = bool
  default = false
}
variable "readiness_gateway_proof_approved" {
  type    = bool
  default = false
}
variable "readiness_decision_hostname" {
  type = string
  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$", var.readiness_decision_hostname)) && !strcontains(var.readiness_decision_hostname, "example")
    error_message = "A reviewed readiness decision hostname is required."
  }
}
variable "readiness_controller_image_digest" {
  type = string
  validation {
    condition     = can(regex("^.+@sha256:[0-9a-f]{64}$", var.readiness_controller_image_digest))
    error_message = "An immutable readiness-controller image digest is required."
  }
}
variable "readiness_decision_secret_name" {
  type = string
}
variable "readiness_decision_secret_version" {
  type = string
  validation {
    condition     = can(regex("^[0-9]+$", var.readiness_decision_secret_version))
    error_message = "A numeric readiness decision secret version is required."
  }
}
variable "readiness_decision_key_not_before" {
  type = number
  validation {
    condition     = var.readiness_decision_key_not_before > 0
    error_message = "A positive readiness decision key start is required."
  }
}
variable "readiness_decision_key_not_after" {
  type = number
  validation {
    condition     = var.readiness_decision_key_not_after > var.readiness_decision_key_not_before
    error_message = "The readiness decision key end must follow its start."
  }
}
variable "readiness_controller_service_audience" {
  type = string
  validation {
    condition     = startswith(var.readiness_controller_service_audience, "https://") && !strcontains(var.readiness_controller_service_audience, "example")
    error_message = "A real readiness controller audience is required."
  }
}
variable "readiness_controller_caller_service_account_email" {
  type = string
  validation {
    condition     = can(regex("^[a-z0-9-]{3,100}@[a-z][a-z0-9-]{4,28}\\.iam\\.gserviceaccount\\.com$", var.readiness_controller_caller_service_account_email))
    error_message = "An exact readiness controller caller service account is required."
  }
}
variable "readiness_kill_caller_service_account_email" {
  type = string
  validation {
    condition     = can(regex("^[a-z0-9-]{3,100}@[a-z][a-z0-9-]{4,28}\\.iam\\.gserviceaccount\\.com$", var.readiness_kill_caller_service_account_email)) && var.readiness_kill_caller_service_account_email != var.readiness_controller_caller_service_account_email
    error_message = "A distinct readiness emergency caller service account is required."
  }
}
variable "readiness_kill_service_audience" {
  type = string
  validation {
    condition     = length(var.readiness_kill_service_audience) >= 16 && !strcontains(var.readiness_kill_service_audience, "example")
    error_message = "A real readiness emergency kill audience is required."
  }
}
variable "provenance_evidence" {
  type = object({
    signed_predicate_uri = string,
    sbom_uri             = string,
    builder_identity     = string,
    verified_at          = string
  })
  default     = null
  description = "Reference-only supply-chain evidence; it cannot unlock runtime resources."
}
variable "ci_oidc_issuer" {



  type = string




  validation {



    condition = startswith(var.ci_oidc_issuer, "https://") && !strcontains(var.ci_oidc_issuer, "example")



    error_message = "A real HTTPS CI issuer is required."



  }
}
variable "ci_oidc_audience" {



  type = string




  validation {



    condition = length(var.ci_oidc_audience) >= 16 && !strcontains(var.ci_oidc_audience, "example")



    error_message = "A real CI audience is required."



  }
}
variable "ci_repository" {



  type = string




  validation {



    condition = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.ci_repository))



    error_message = "Repository must be owner/name."



  }
}
variable "ci_ref" {

  type = string

  validation {

    condition = startswith(var.ci_ref, "refs/heads/")

    error_message = "CI branch ref required."

  }
}
variable "ci_environment" {

  type = string

  validation {

    condition = length(var.ci_environment) >= 3

    error_message = "CI environment required."

  }
}
variable "ci_workflow" {

  type = string

  validation {

    condition = length(var.ci_workflow) >= 8

    error_message = "CI workflow claim required."

  }
}
variable "cloudflare_worker_subject" {

  type = string

  validation {

    condition = length(var.cloudflare_worker_subject) >= 8

    error_message = "Exact worker subject required."

  }
}
variable "cloudflare_oidc_issuer" {



  type = string




  validation {



    condition = startswith(var.cloudflare_oidc_issuer, "https://") && !strcontains(var.cloudflare_oidc_issuer, "example")



    error_message = "A real HTTPS Cloudflare issuer is required."



  }
}
variable "cloudflare_oidc_audience" {



  type = string




  validation {



    condition = length(var.cloudflare_oidc_audience) >= 16 && !strcontains(var.cloudflare_oidc_audience, "example")



    error_message = "A real Cloudflare audience is required."



  }
}
variable "cloudflare_account_tag" {



  type = string



  sensitive = true




  validation {



    condition = can(regex("^[0-9a-f]{32}$", var.cloudflare_account_tag))



    error_message = "Invalid Cloudflare account tag."



  }
}
variable "scheduler_audience" {



  type = string




  validation {



    condition = startswith(var.scheduler_audience, "https://") && !strcontains(var.scheduler_audience, "example")



    error_message = "A real HTTPS scheduler audience is required."



  }
}
variable "billing_account" {



  type = string



  sensitive = true
}
variable "budget_usd" {



  type = number



  default = 2000




  validation {



    condition = var.budget_usd >= 100



    error_message = "Budget must be at least USD 100."



  }
}
variable "notification_email" {



  type = string



  sensitive = true




  validation {



    condition = can(regex("^[^@]+@[^@]+\\.[^@]+$", var.notification_email)) && !endswith(var.notification_email, ".invalid")



    error_message = "A real notification email is required."



  }
}
variable "cloudflare_account_id" {


  type = string


  sensitive = true


  validation {


    condition = can(regex("^[0-9a-f]{32}$", var.cloudflare_account_id))


    error_message = "Invalid Cloudflare account ID."


  }
}
variable "cloudflare_worker_script_name" {


  type = string


  validation {


    condition = can(regex("^[a-z0-9-]{3,63}$", var.cloudflare_worker_script_name))


    error_message = "Invalid worker script name."


  }
}
