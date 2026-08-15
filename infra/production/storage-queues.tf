provider "cloudflare" {}

locals {


  r2_location = var.data_residency == "US" ? "ENAM" : "WNAM"
}

resource "cloudflare_r2_bucket" "audio" {


  count = var.data_residency == "US" ? 1 : 0


  account_id = var.cloudflare_account_id


  name = "nearyou-production-audio"


  location = local.r2_location


  storage_class = "Standard"


  lifecycle {


    prevent_destroy = true


  }


  depends_on = [terraform_data.approval_gate]
}
resource "cloudflare_r2_bucket" "exports" {


  count = var.data_residency == "US" ? 1 : 0


  account_id = var.cloudflare_account_id


  name = "nearyou-production-exports"


  location = local.r2_location


  storage_class = "Standard"


  lifecycle {


    prevent_destroy = true


  }


  depends_on = [terraform_data.approval_gate]
}
resource "cloudflare_r2_bucket" "checkpoints" {


  count = var.data_residency == "US" ? 1 : 0


  account_id = var.cloudflare_account_id


  name = "nearyou-production-checkpoints"


  location = local.r2_location


  storage_class = "Standard"


  lifecycle {


    prevent_destroy = true


  }


  depends_on = [terraform_data.approval_gate]
}

resource "cloudflare_queue" "jobs" {

  count = var.data_residency == "US" ? 1 : 0


  account_id = var.cloudflare_account_id


  queue_name = "nearyou-production-jobs"


  settings = {


    message_retention_period = 1209600


  }


  lifecycle {


    prevent_destroy = true


  }


  depends_on = [terraform_data.approval_gate]
}
resource "cloudflare_queue" "dead_letters" {

  count = var.data_residency == "US" ? 1 : 0


  account_id = var.cloudflare_account_id


  queue_name = "nearyou-production-dead-letters"


  settings = {


    message_retention_period = 1209600


  }


  lifecycle {


    prevent_destroy = true


  }


  depends_on = [terraform_data.approval_gate]
}
resource "cloudflare_queue_consumer" "jobs" {

  count = var.data_residency == "US" ? 1 : 0


  account_id = var.cloudflare_account_id


  queue_id = cloudflare_queue.jobs[0].id


  script_name = var.cloudflare_worker_script_name


  dead_letter_queue = cloudflare_queue.dead_letters[0].queue_name


  settings = {


    batch_size = 10


    max_retries = 5


    max_concurrency = 20


    max_wait_time_ms = 5000


    retry_delay = 30


    visibility_timeout_ms = 120000


  }


  depends_on = [terraform_data.approval_gate]
}

resource "google_cloud_tasks_queue" "jobs" {


  name = "nearyou-production-jobs"


  location = local.region


  rate_limits {


    max_concurrent_dispatches = 20


    max_dispatches_per_second = 10


  }


  retry_config {


    max_attempts = 5


    max_retry_duration = "3600s"


    min_backoff = "5s"


    max_backoff = "300s"


    max_doublings = 5


  }


  stackdriver_logging_config {


    sampling_ratio = 1


  }


  depends_on = [terraform_data.approval_gate]
}
resource "google_cloud_tasks_queue" "dead_letters" {


  count = 0


  name = "nearyou-production-dead-letters"


  location = local.region


  rate_limits {


    max_concurrent_dispatches = 1


    max_dispatches_per_second = 1


  }


  retry_config {


    max_attempts = 1


  }


  stackdriver_logging_config {


    sampling_ratio = 1


  }


  depends_on = [terraform_data.approval_gate]
}

resource "google_sql_database" "application" {


  name = "nearyou"


  instance = google_sql_database_instance.primary.name


  deletion_policy = "ABANDON"


  depends_on = [terraform_data.approval_gate]
}
resource "google_sql_user" "application" {


  name = google_service_account.app.email


  instance = google_sql_database_instance.primary.name


  type = "CLOUD_IAM_SERVICE_ACCOUNT"


  deletion_policy = "ABANDON"


  depends_on = [terraform_data.approval_gate]
}
resource "google_sql_user" "legacy" {

  name = google_service_account.legacy.email

  instance = google_sql_database_instance.primary.name

  type = "CLOUD_IAM_SERVICE_ACCOUNT"

  deletion_policy = "ABANDON"

  depends_on = [terraform_data.approval_gate]
}
resource "google_sql_user" "pad" {

  name = google_service_account.pad.email

  instance = google_sql_database_instance.primary.name

  type = "CLOUD_IAM_SERVICE_ACCOUNT"

  deletion_policy = "ABANDON"

  depends_on = [terraform_data.approval_gate]
}
resource "google_sql_user" "migration" {

  name = google_service_account.migration.email

  instance = google_sql_database_instance.primary.name

  type = "CLOUD_IAM_SERVICE_ACCOUNT"

  deletion_policy = "ABANDON"

  depends_on = [terraform_data.approval_gate]
}

resource "google_cloud_run_v2_job" "migrations" {


  count = local.secrets_ready && local.catalog_ready ? 1 : 0



  name = "nearyou-production-migrations"


  location = local.region


  deletion_protection = true



  template {


    task_count = 1


    template {


      service_account = google_service_account.migration.email


      timeout = "900s"


      max_retries = 0


      vpc_access {


        network_interfaces {


          network = google_compute_network.private.name


          subnetwork = google_compute_subnetwork.private.name


        }


        egress = "PRIVATE_RANGES_ONLY"


      }


      volumes {


        name = "migration-admin-secret"


        secret {


          secret = google_secret_manager_secret.migration_admin.secret_id


          items {


            version = var.migration_admin_secret_version


            path = "database-url"


          }


        }


      }


      containers {


        image = var.migration_image_digest


        command = ["node", "/app/dist/scripts/migrate.js"]


        args = ["--register-rollout-controller", "--release", var.release_id, "--schema-checksum", trimprefix(var.schema_checksum, "sha256:"), "--catalog-checksum", local.catalog_manifest_checksum, "--database-url-file", "/var/run/secrets/nearyou/database-url"]


        env {

          name = "NEARYOU_RELEASE_ID"

          value = var.release_id

        }
        env {
          name  = "NEARYOU_READINESS_DATABASE_USER"
          value = local.readiness_controller_database_user
        }
        env {
          name  = "NEARYOU_READINESS_OIDC_PRINCIPAL"
          value = local.readiness_controller_oidc_principal
        }
        env {
          name  = "NEARYOU_PRIVATE_TESTER_BASELINE_DATABASE_USER"
          value = local.private_tester_baseline_database_user
        }
        env {
          name  = "NEARYOU_PRIVATE_TESTER_BASELINE_OIDC_PRINCIPAL"
          value = local.private_tester_baseline_oidc_principal
        }


        env {

          name = "NEARYOU_SCHEMA_CHECKSUM"

          value = var.schema_checksum

        }


        resources {


          limits = {


            cpu = "2",


            memory = "2Gi"


          }


        }


        volume_mounts {


          name = "db-secret"


          mount_path = "/var/run/secrets/nearyou"


        }


      }


    }


  }



  lifecycle {


    prevent_destroy = true


  }



  depends_on = [terraform_data.approval_gate, google_sql_database.application, google_sql_user.application]
}
