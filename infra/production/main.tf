locals {



  region = var.data_residency == "US" ? "us-central1" : "northamerica-northeast1"



  secondary_region = var.data_residency == "US" ? "us-east1" : "northamerica-northeast2"



  apis = toset(["artifactregistry.googleapis.com", "cloudkms.googleapis.com", "compute.googleapis.com", "logging.googleapis.com", "run.googleapis.com", "secretmanager.googleapis.com", "sqladmin.googleapis.com", "servicenetworking.googleapis.com", "cloudscheduler.googleapis.com", "cloudtasks.googleapis.com", "monitoring.googleapis.com", "billingbudgets.googleapis.com", "iamcredentials.googleapis.com"])



  secrets_ready = try(var.secret_bootstrap_evidence.complete, false)



  migration_ready = try(var.migration_evidence.status, "") == "succeeded" && try(var.migration_evidence.release_id, "") == var.release_id && try(var.migration_evidence.schema_checksum, "") == var.schema_checksum



  services_ready = false

  scheduler_ready = false

  catalog_ready = (
    can(regex("^[a-f0-9]{64}$", local.catalog_manifest_checksum)) &&
    local.catalog_manifest_checksum != "0000000000000000000000000000000000000000000000000000000000000000" &&
    try(local.catalog_manifest.generatedFrom, "") == "reviewed-supported-postgresql-16" &&
    try(local.catalog_manifest.reviewRequired, true) == false &&
    try(local.catalog_manifest.migrationHead, "") == "0006_private_canary_observation" &&
    try(local.catalog_manifest.schema, "") == "nearyou" &&
    try(local.catalog_manifest.forbidPublicExecute, false) == true &&
    try(local.catalog_manifest.requireForcedRls, []) == ["household_members", "tenant_records"] &&
    try(local.catalog_manifest.requiredKinds, []) == ["schema", "table", "column", "constraint", "index", "trigger", "policy", "function", "sequence", "extension", "role", "membership"]
  )
}
provider "google" {



  project = var.project_id



  region = local.region
}
provider "google-beta" {



  project = var.project_id



  region = local.region
}
resource "terraform_data" "approval_gate" {




  lifecycle {




    precondition {



      condition = var.deployment_approved



      error_message = "A separately reviewed production plan requires explicit approval."



    }



  }
}
resource "google_project_service" "required" {



  for_each = local.apis



  service = each.value



  disable_on_destroy = false

  depends_on = [terraform_data.approval_gate]
}
resource "google_project_iam_audit_config" "all_services" {


  project = var.project_id


  service = "allServices"


  audit_log_config {

    log_type = "ADMIN_READ"

  }


  audit_log_config {

    log_type = "DATA_READ"

  }


  audit_log_config {

    log_type = "DATA_WRITE"

  }


  depends_on = [terraform_data.approval_gate]
}
resource "google_artifact_registry_repository" "containers" {



  location = local.region



  repository_id = "nearyou-production"



  format = "DOCKER"



  cleanup_policy_dry_run = false




  cleanup_policies {



    id = "keep-release"



    action = "KEEP"




    most_recent_versions {



      keep_count = 20



    }



  }




  lifecycle {



    prevent_destroy = true



  }



  depends_on = [google_project_service.required, terraform_data.approval_gate]
}
resource "google_artifact_registry_repository_iam_member" "ci_writer" {

  project    = var.project_id
  location   = google_artifact_registry_repository.containers.location
  repository = google_artifact_registry_repository.containers.name

  role   = "roles/artifactregistry.writer"
  member = "serviceAccount:${google_service_account.ci.email}"

  depends_on = [terraform_data.approval_gate]
}
resource "google_artifact_registry_repository_iam_member" "legacy_reader" {

  project    = var.project_id
  location   = google_artifact_registry_repository.containers.location
  repository = google_artifact_registry_repository.containers.name

  role   = "roles/artifactregistry.reader"
  member = "serviceAccount:${google_service_account.legacy.email}"

  depends_on = [terraform_data.approval_gate]
}
resource "google_artifact_registry_repository_iam_member" "pad_reader" {

  project    = var.project_id
  location   = google_artifact_registry_repository.containers.location
  repository = google_artifact_registry_repository.containers.name

  role   = "roles/artifactregistry.reader"
  member = "serviceAccount:${google_service_account.pad.email}"

  depends_on = [terraform_data.approval_gate]
}
resource "google_artifact_registry_repository_iam_member" "migration_reader" {

  project    = var.project_id
  location   = google_artifact_registry_repository.containers.location
  repository = google_artifact_registry_repository.containers.name

  role   = "roles/artifactregistry.reader"
  member = "serviceAccount:${google_service_account.migration.email}"

  depends_on = [terraform_data.approval_gate]
}
resource "google_service_account" "app" {



  account_id = "nearyou-prod-app"




  depends_on = [terraform_data.approval_gate]
}
resource "google_service_account" "legacy" {



  account_id = "nearyou-prod-legacy"




  depends_on = [terraform_data.approval_gate]
}
resource "google_service_account" "pad" {



  account_id = "nearyou-prod-pad"




  depends_on = [terraform_data.approval_gate]
}
resource "google_service_account" "scheduler" {



  account_id = "nearyou-prod-scheduler"




  depends_on = [terraform_data.approval_gate]
}
resource "google_service_account" "ci" {



  account_id = "nearyou-prod-ci"




  depends_on = [terraform_data.approval_gate]
}
resource "google_service_account" "cloudflare" {



  account_id = "nearyou-prod-cloudflare"




  depends_on = [terraform_data.approval_gate]
}
resource "google_service_account" "migration" {


  account_id = "nearyou-prod-migration"


  depends_on = [terraform_data.approval_gate]
}
resource "google_compute_network" "private" {



  name = "nearyou-production"



  auto_create_subnetworks = false



  depends_on = [terraform_data.approval_gate]
}
resource "google_compute_subnetwork" "private" {



  name = "nearyou-production"



  region = local.region



  network = google_compute_network.private.id



  ip_cidr_range = "10.32.0.0/20"



  private_ip_google_access = true




  depends_on = [terraform_data.approval_gate]
}
resource "google_compute_global_address" "private_service_access" {



  name = "nearyou-private-services"



  purpose = "VPC_PEERING"



  address_type = "INTERNAL"



  prefix_length = 16



  network = google_compute_network.private.id




  depends_on = [terraform_data.approval_gate]
}
resource "google_service_networking_connection" "private" {



  network = google_compute_network.private.id



  service = "servicenetworking.googleapis.com"



  reserved_peering_ranges = [google_compute_global_address.private_service_access.name]




  depends_on = [terraform_data.approval_gate]
}
resource "google_kms_key_ring" "primary" {



  name = "nearyou-primary"



  location = local.region




  depends_on = [terraform_data.approval_gate]
}
resource "google_kms_key_ring" "secondary" {



  name = "nearyou-secondary"



  location = local.secondary_region




  depends_on = [terraform_data.approval_gate]
}
resource "google_kms_crypto_key" "database" {



  name = "database"



  key_ring = google_kms_key_ring.primary.id



  rotation_period = "7776000s"




  lifecycle {



    prevent_destroy = true



  }




  depends_on = [terraform_data.approval_gate]
}
resource "google_kms_crypto_key" "secrets_primary" {



  name = "secrets"



  key_ring = google_kms_key_ring.primary.id



  rotation_period = "7776000s"




  lifecycle {



    prevent_destroy = true



  }




  depends_on = [terraform_data.approval_gate]
}
resource "google_kms_crypto_key" "secrets_secondary" {



  name = "secrets"



  key_ring = google_kms_key_ring.secondary.id



  rotation_period = "7776000s"




  lifecycle {



    prevent_destroy = true



  }




  depends_on = [terraform_data.approval_gate]
}
resource "google_project_service_identity" "sql" {



  provider = google-beta



  service = "sqladmin.googleapis.com"




  depends_on = [terraform_data.approval_gate]
}
resource "google_project_service_identity" "secretmanager" {



  provider = google-beta



  service = "secretmanager.googleapis.com"




  depends_on = [terraform_data.approval_gate]
}
resource "google_kms_crypto_key_iam_member" "sql" {



  crypto_key_id = google_kms_crypto_key.database.id



  role = "roles/cloudkms.cryptoKeyEncrypterDecrypter"



  member = google_project_service_identity.sql.member




  depends_on = [terraform_data.approval_gate]
}
resource "google_kms_crypto_key_iam_member" "secretmanager_primary" {



  crypto_key_id = google_kms_crypto_key.secrets_primary.id



  role = "roles/cloudkms.cryptoKeyEncrypterDecrypter"



  member = google_project_service_identity.secretmanager.member




  depends_on = [terraform_data.approval_gate]
}
resource "google_kms_crypto_key_iam_member" "secretmanager_secondary" {



  crypto_key_id = google_kms_crypto_key.secrets_secondary.id



  role = "roles/cloudkms.cryptoKeyEncrypterDecrypter"



  member = google_project_service_identity.secretmanager.member




  depends_on = [terraform_data.approval_gate]
}
resource "google_sql_database_instance" "primary" {



  name = "nearyou-production"



  database_version = "POSTGRES_16"



  region = local.region



  deletion_protection = true



  encryption_key_name = google_kms_crypto_key.database.id



  settings {



    tier = "db-custom-2-7680"



    availability_type = "REGIONAL"




    backup_configuration {



      enabled = true



      point_in_time_recovery_enabled = true



      transaction_log_retention_days = 7




      backup_retention_settings {



        retained_backups = 30



        retention_unit = "COUNT"



      }



    }




    ip_configuration {



      ipv4_enabled = false



      private_network = google_compute_network.private.self_link



    }




    database_flags {



      name = "cloudsql.iam_authentication"



      value = "on"



    }



  }




  lifecycle {



    prevent_destroy = true



  }



  depends_on = [google_kms_crypto_key_iam_member.sql, google_service_networking_connection.private, terraform_data.approval_gate]
}
resource "google_secret_manager_secret" "app" {



  secret_id = "nearyou-prod-app"




  replication {




    user_managed {




      replicas {



        location = local.region




        customer_managed_encryption {



          kms_key_name = google_kms_crypto_key.secrets_primary.id



        }



      }




      replicas {



        location = local.secondary_region




        customer_managed_encryption {



          kms_key_name = google_kms_crypto_key.secrets_secondary.id



        }



      }



    }



  }




  lifecycle {



    prevent_destroy = true



  }



  depends_on = [google_kms_crypto_key_iam_member.secretmanager_primary, google_kms_crypto_key_iam_member.secretmanager_secondary, terraform_data.approval_gate]
}
resource "google_secret_manager_secret" "legacy" {



  secret_id = "nearyou-prod-legacy"




  replication {




    user_managed {




      replicas {



        location = local.region




        customer_managed_encryption {



          kms_key_name = google_kms_crypto_key.secrets_primary.id



        }



      }




      replicas {



        location = local.secondary_region




        customer_managed_encryption {



          kms_key_name = google_kms_crypto_key.secrets_secondary.id



        }



      }



    }



  }




  lifecycle {



    prevent_destroy = true



  }



  depends_on = [google_kms_crypto_key_iam_member.secretmanager_primary, google_kms_crypto_key_iam_member.secretmanager_secondary, terraform_data.approval_gate]
}
resource "google_secret_manager_secret" "pad" {



  secret_id = "nearyou-prod-pad"




  replication {




    user_managed {




      replicas {



        location = local.region




        customer_managed_encryption {



          kms_key_name = google_kms_crypto_key.secrets_primary.id



        }



      }




      replicas {



        location = local.secondary_region




        customer_managed_encryption {



          kms_key_name = google_kms_crypto_key.secrets_secondary.id



        }



      }



    }



  }




  lifecycle {



    prevent_destroy = true



  }



  depends_on = [google_kms_crypto_key_iam_member.secretmanager_primary, google_kms_crypto_key_iam_member.secretmanager_secondary, terraform_data.approval_gate]
}
resource "google_secret_manager_secret_iam_member" "app" {



  secret_id = google_secret_manager_secret.app.id



  role = "roles/secretmanager.secretAccessor"



  member = "serviceAccount:${google_service_account.app.email}"




  depends_on = [terraform_data.approval_gate]
}
resource "google_secret_manager_secret_iam_member" "legacy" {



  secret_id = google_secret_manager_secret.legacy.id



  role = "roles/secretmanager.secretAccessor"



  member = "serviceAccount:${google_service_account.legacy.email}"




  depends_on = [terraform_data.approval_gate]
}
resource "google_secret_manager_secret_iam_member" "pad" {



  secret_id = google_secret_manager_secret.pad.id



  role = "roles/secretmanager.secretAccessor"



  member = "serviceAccount:${google_service_account.pad.email}"




  depends_on = [terraform_data.approval_gate]
}
resource "google_project_iam_member" "legacy_sql" {



  project = var.project_id



  role = "roles/cloudsql.client"



  member = "serviceAccount:${google_service_account.legacy.email}"




  depends_on = [terraform_data.approval_gate]
}
resource "google_project_iam_member" "pad_sql" {



  project = var.project_id



  role = "roles/cloudsql.client"



  member = "serviceAccount:${google_service_account.pad.email}"




  depends_on = [terraform_data.approval_gate]
}
resource "google_project_iam_member" "app_sql_client" {


  project = var.project_id


  role = "roles/cloudsql.client"


  member = "serviceAccount:${google_service_account.app.email}"


  depends_on = [terraform_data.approval_gate]
}
resource "google_project_iam_member" "app_sql_instance" {


  project = var.project_id


  role = "roles/cloudsql.instanceUser"


  member = "serviceAccount:${google_service_account.app.email}"


  depends_on = [terraform_data.approval_gate]
}
resource "google_project_iam_member" "legacy_sql_instance" {


  project = var.project_id


  role = "roles/cloudsql.instanceUser"


  member = "serviceAccount:${google_service_account.legacy.email}"


  depends_on = [terraform_data.approval_gate]
}
resource "google_project_iam_member" "pad_sql_instance" {


  project = var.project_id


  role = "roles/cloudsql.instanceUser"


  member = "serviceAccount:${google_service_account.pad.email}"


  depends_on = [terraform_data.approval_gate]
}
resource "google_project_iam_member" "migration_sql_client" {


  project = var.project_id


  role = "roles/cloudsql.client"


  member = "serviceAccount:${google_service_account.migration.email}"


  depends_on = [terraform_data.approval_gate]
}
resource "google_project_iam_member" "migration_sql_instance" {


  project = var.project_id


  role = "roles/cloudsql.instanceUser"


  member = "serviceAccount:${google_service_account.migration.email}"


  depends_on = [terraform_data.approval_gate]
}
resource "google_cloud_run_v2_service" "legacy" {



  count = local.services_ready ? 1 : 0



  name = "nearlegacy-processor"



  location = local.region



  ingress = "INGRESS_TRAFFIC_INTERNAL_ONLY"



  deletion_protection = true




  template {



    service_account = google_service_account.legacy.email




    vpc_access {




      network_interfaces {



        network = google_compute_network.private.name



        subnetwork = google_compute_subnetwork.private.name



      }



      egress = "PRIVATE_RANGES_ONLY"



    }




    scaling {



      min_instance_count = 1



      max_instance_count = 20



    }




    volumes {



      name = "db-secret"




      secret {



        secret = google_secret_manager_secret.legacy.secret_id




        items {



          version = try(var.secret_bootstrap_evidence.legacy_version, "0")



          path = "database-url"



        }



      }



    }




    containers {



      image = var.legacy_image_digest
      env {
        name  = "EVIDENCE_COLLECTION_APPROVED"
        value = tostring(var.evidence_collection_approved)
      }

      env {
        name  = "OUTCOME_RUNTIME"
        value = "cloudrun"
      }

      env {
        name  = "OUTCOME_ENDPOINT"
        value = "${var.scheduler_audience}/api/internal/product-outcomes"
      }

      env {
        name  = "OUTCOME_AUDIENCE"
        value = var.scheduler_audience
      }




      volume_mounts {



        name = "db-secret"



        mount_path = "/var/run/secrets/nearyou"



      }



    }



  }



  depends_on = [terraform_data.approval_gate, google_project_iam_member.legacy_sql]
}
resource "google_cloud_run_v2_service" "pad" {



  count = local.services_ready ? 1 : 0



  name = "nearyou-pad"



  location = local.region



  ingress = "INGRESS_TRAFFIC_INTERNAL_ONLY"



  deletion_protection = true




  template {



    service_account = google_service_account.pad.email




    vpc_access {




      network_interfaces {



        network = google_compute_network.private.name



        subnetwork = google_compute_subnetwork.private.name



      }



      egress = "PRIVATE_RANGES_ONLY"



    }




    scaling {



      min_instance_count = 1



      max_instance_count = 20



    }




    volumes {



      name = "db-secret"




      secret {



        secret = google_secret_manager_secret.pad.secret_id




        items {



          version = try(var.secret_bootstrap_evidence.pad_version, "0")



          path = "database-url"



        }



      }



    }




    containers {



      image = var.pad_image_digest




      volume_mounts {



        name = "db-secret"



        mount_path = "/var/run/secrets/nearyou"



      }



    }



  }



  depends_on = [terraform_data.approval_gate, google_project_iam_member.pad_sql]
}
