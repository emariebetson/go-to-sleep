variable "product_release_evidence_digest" {
  type    = string
  default = ""
  validation {
    condition     = var.product_release_evidence_digest == "" || can(regex("^[0-9a-f]{64}$", var.product_release_evidence_digest))
    error_message = "Evidence digest must be empty (dark) or an authenticated 64-hex digest."
  }
}
variable "nearstory_rollout_percent" {
  type    = number
  default = 0
  validation {
    condition     = var.nearstory_rollout_percent == 0
    error_message = "Terraform cannot unlock NearStory; use authenticated readiness service."
  }
}
variable "nearfamily_rollout_percent" {
  type    = number
  default = 0
  validation {
    condition     = var.nearfamily_rollout_percent == 0
    error_message = "Terraform cannot unlock NearFamily; use authenticated readiness service."
  }
}
variable "nearlegacy_rollout_percent" {
  type    = number
  default = 0
  validation {
    condition     = var.nearlegacy_rollout_percent == 0
    error_message = "Terraform cannot unlock NearLegacy; use authenticated readiness service."
  }
}
locals {
  product_rollouts_default_dark = { nearstory = 0, nearfamily = 0, nearlegacy = 0 }
}
locals {
  catalog_manifest          = jsondecode(file("${path.module}/../../postgres/catalog-manifest.json"))
  catalog_manifest_checksum = local.catalog_manifest.catalogChecksum
}
variable "migration_admin_secret_version" {
  type      = string
  sensitive = true
  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.migration_admin_secret_version))
    error_message = "Exact migration admin secret version required."
  }
}
resource "google_secret_manager_secret" "migration_admin" {
  secret_id = "nearyou-prod-migration-admin"
  replication {
    user_managed {
      replicas {
        location = local.region
      }
    }
  }
}
resource "google_secret_manager_secret_iam_member" "migration_admin_accessor" {
  secret_id = google_secret_manager_secret.migration_admin.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.migration.email}"
}

resource "google_service_account" "readiness_controller" {
  account_id   = "nearyou-readiness-ctl"
  display_name = "NearYou readiness controller"
}
resource "google_project_iam_member" "readiness_controller_cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.readiness_controller.email}"
}
resource "google_project_iam_member" "readiness_controller_cloudsql_user" {
  project = var.project_id
  role    = "roles/cloudsql.instanceUser"
  member  = "serviceAccount:${google_service_account.readiness_controller.email}"
}
resource "google_sql_user" "readiness_controller" {
  name     = google_service_account.readiness_controller.email
  instance = google_sql_database_instance.primary.name
  type     = "CLOUD_IAM_SERVICE_ACCOUNT"
}
locals {
  readiness_controller_database_user  = google_service_account.readiness_controller.email
  readiness_controller_oidc_principal = "service:nearyou-readiness-controller"
}
