resource "google_iam_workload_identity_pool" "external" {
  workload_identity_pool_id = "nearyou-production"

  depends_on = [terraform_data.approval_gate]
}
resource "google_iam_workload_identity_pool_provider" "ci" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.external.workload_identity_pool_id
  workload_identity_pool_provider_id = "ci-production"
  attribute_mapping = { "google.subject" = "assertion.sub", "attribute.repository" = "assertion.repository", "attribute.ref" = "assertion.ref", "attribute.environment" = "assertion.environment", "attribute.workflow" = "assertion.job_workflow_ref"
  }
  attribute_condition = "attribute.repository == \"${var.ci_repository}\" && attribute.ref == \"${var.ci_ref}\" && attribute.environment == \"${var.ci_environment}\" && attribute.workflow == \"${var.ci_workflow}\""

  oidc {
    issuer_uri        = var.ci_oidc_issuer
    allowed_audiences = [var.ci_oidc_audience]
  }

  depends_on = [terraform_data.approval_gate]
}
resource "google_iam_workload_identity_pool_provider" "cloudflare" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.external.workload_identity_pool_id
  workload_identity_pool_provider_id = "cloudflare"
  attribute_mapping = { "google.subject" = "assertion.sub", "attribute.account_id" = "assertion.account_id"
  }
  attribute_condition = "attribute.account_id == \"${var.cloudflare_account_tag}\" && assertion.sub == \"${var.cloudflare_worker_subject}\""

  oidc {
    issuer_uri        = var.cloudflare_oidc_issuer
    allowed_audiences = [var.cloudflare_oidc_audience]
  }

  depends_on = [terraform_data.approval_gate]
}
resource "google_service_account_iam_member" "ci" {
  service_account_id = google_service_account.ci.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.external.name}/attribute.repository/${var.ci_repository}"

  depends_on = [terraform_data.approval_gate]
}
resource "google_service_account_iam_member" "cloudflare" {
  service_account_id = google_service_account.cloudflare.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.external.name}/attribute.account_id/${var.cloudflare_account_tag}"

  depends_on = [terraform_data.approval_gate]
}
resource "google_cloud_run_v2_service_iam_member" "scheduler_legacy" {
  count    = local.scheduler_ready ? 1 : 0
  location = local.region
  name     = google_cloud_run_v2_service.legacy[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"

  depends_on = [terraform_data.approval_gate]
}
resource "google_cloud_scheduler_job" "story" {
  count    = 0
  name     = "nearstory-worker"
  schedule = "* * * * *"
  paused   = var.scheduler_paused

  http_target {
    uri         = "${var.scheduler_audience}/api/internal/nearstory-worker"
    http_method = "POST"

    oidc_token {
      service_account_email = google_service_account.scheduler.email
      audience              = var.scheduler_audience
    }
  }

  depends_on = [terraform_data.approval_gate]
}
resource "google_cloud_scheduler_job" "legacy" {
  count    = local.scheduler_ready ? 1 : 0
  name     = "nearlegacy-worker"
  schedule = "* * * * *"
  paused   = var.scheduler_paused

  http_target {
    uri         = "${var.scheduler_audience}/api/internal/nearlegacy-worker"
    http_method = "POST"

    oidc_token {
      service_account_email = google_service_account.scheduler.email
      audience              = var.scheduler_audience
    }
  }

  depends_on = [terraform_data.approval_gate]
}
resource "google_monitoring_notification_channel" "ops" {
  display_name = "NearYou operations"
  type         = "email"
  labels = {
    email_address = var.notification_email
  }

  depends_on = [terraform_data.approval_gate]
}
resource "google_monitoring_alert_policy" "sql_cpu" {
  display_name          = "SQL CPU"
  combiner              = "OR"
  notification_channels = [google_monitoring_notification_channel.ops.name]

  conditions {
    display_name = "CPU"

    condition_threshold {
      filter          = "metric.type=\"cloudsql.googleapis.com/database/cpu/utilization\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0.8
      duration        = "300s"
    }
  }

  depends_on = [terraform_data.approval_gate]
}
resource "google_monitoring_alert_policy" "run_errors" {
  display_name          = "Run errors"
  combiner              = "OR"
  notification_channels = [google_monitoring_notification_channel.ops.name]

  conditions {
    display_name = "Errors"

    condition_threshold {
      filter          = "metric.type=\"run.googleapis.com/request_count\""
      comparison      = "COMPARISON_GT"
      threshold_value = 5
      duration        = "60s"
    }
  }

  depends_on = [terraform_data.approval_gate]
}
resource "google_monitoring_alert_policy" "sql_disk" {
  display_name          = "SQL disk"
  combiner              = "OR"
  notification_channels = [google_monitoring_notification_channel.ops.name]

  conditions {
    display_name = "Disk"

    condition_threshold {
      filter          = "metric.type=\"cloudsql.googleapis.com/database/disk/utilization\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0.8
      duration        = "300s"
    }
  }

  depends_on = [terraform_data.approval_gate]
}
resource "google_billing_budget" "production" {
  billing_account = var.billing_account

  amount {

    specified_amount {
      currency_code = "USD"
      units         = tostring(var.budget_usd)
    }
  }

  threshold_rules {
    threshold_percent = 0.5
  }

  threshold_rules {
    threshold_percent = 0.8
  }

  threshold_rules {
    threshold_percent = 1.0
  }

  depends_on = [terraform_data.approval_gate]
}
