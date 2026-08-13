resource "google_cloud_scheduler_job" "operational_evidence_sample" {
  name             = "nearyou-operational-evidence-sample"
  region           = local.region
  schedule         = "* * * * *"
  time_zone        = "Etc/UTC"
  paused           = !var.evidence_collection_approved
  attempt_deadline = "30s"

  retry_config {
    retry_count          = 3
    max_retry_duration   = "60s"
    min_backoff_duration = "5s"
    max_backoff_duration = "20s"
    max_doublings        = 2
  }
  http_target {
    uri         = "${var.scheduler_audience}/api/internal/operational-evidence/sample"
    http_method = "POST"

    oidc_token {
      service_account_email = google_service_account.scheduler.email
      audience              = var.scheduler_audience
    }
  }
  depends_on = [google_project_service.required]
}
