resource "google_logging_metric" "scheduler_failures" {


  name = "nearyou/scheduler_failures"


  filter = "resource.type=\"cloud_scheduler_job\" AND severity>=ERROR"


  metric_descriptor {

    metric_kind = "DELTA"

    value_type = "INT64"

    unit = "1"

  }


  depends_on = [terraform_data.approval_gate]
}
resource "google_logging_metric" "sensitive_access" {


  name = "nearyou/sensitive_access"


  filter = "protoPayload.serviceName=(\"cloudkms.googleapis.com\" OR \"secretmanager.googleapis.com\") AND protoPayload.methodName:(\"Decrypt\" OR \"AccessSecretVersion\")"


  metric_descriptor {

    metric_kind = "DELTA"

    value_type = "INT64"

    unit = "1"

  }


  depends_on = [terraform_data.approval_gate]
}
resource "google_monitoring_alert_policy" "scheduler_failures" {


  display_name = "Scheduler failures"


  combiner = "OR"


  notification_channels = [google_monitoring_notification_channel.ops.name]


  conditions {

    display_name = "Scheduler error logs"

    condition_threshold {

      filter = "metric.type=\"logging.googleapis.com/user/nearyou/scheduler_failures\""

      comparison = "COMPARISON_GT"

      threshold_value = 0

      duration = "0s"

    }

  }


  depends_on = [terraform_data.approval_gate]
}
resource "google_monitoring_alert_policy" "task_queue_depth" {


  display_name = "Cloud Tasks queue depth"


  combiner = "OR"


  notification_channels = [google_monitoring_notification_channel.ops.name]


  conditions {

    display_name = "Queue depth"

    condition_threshold {

      filter = "metric.type=\"cloudtasks.googleapis.com/queue/depth\""

      comparison = "COMPARISON_GT"

      threshold_value = 100

      duration = "300s"

    }

  }


  depends_on = [terraform_data.approval_gate]
}
resource "google_monitoring_alert_policy" "run_latency" {


  display_name = "Cloud Run p95 latency"


  combiner = "OR"


  notification_channels = [google_monitoring_notification_channel.ops.name]


  conditions {

    display_name = "Latency"

    condition_threshold {

      filter = "metric.type=\"run.googleapis.com/request_latencies\""

      comparison = "COMPARISON_GT"

      threshold_value = 5000

      duration = "300s"

      aggregations {

        alignment_period = "60s"

        per_series_aligner = "ALIGN_PERCENTILE_95"

      }

    }

  }


  depends_on = [terraform_data.approval_gate]
}
resource "google_monitoring_alert_policy" "backup_failures" {

  count = 0


  display_name = "Cloud SQL backup failures"


  combiner = "OR"


  notification_channels = [google_monitoring_notification_channel.ops.name]


  conditions {

    display_name = "Backup unsuccessful"

    condition_threshold {

      filter = "metric.type=\"cloudsql.googleapis.com/database/available_for_failover\""

      comparison = "COMPARISON_LT"

      threshold_value = 1

      duration = "600s"

    }

  }


  depends_on = [terraform_data.approval_gate]
}
resource "google_monitoring_alert_policy" "heartbeat_absent" {

  count = 0


  display_name = "Production worker heartbeat absent"


  combiner = "OR"


  notification_channels = [google_monitoring_notification_channel.ops.name]


  conditions {

    display_name = "Heartbeat missing"

    condition_absent {

      filter = "metric.type=\"custom.googleapis.com/nearyou/worker_heartbeat\""

      duration = "300s"

    }

  }


  depends_on = [terraform_data.approval_gate]
}

resource "google_logging_project_bucket_config" "production" {


  project = var.project_id

  location = local.region

  retention_days = 365

  bucket_id = "nearyou-production-audit"

  enable_analytics = true

  locked = true


  cmek_settings {

    kms_key_name = google_kms_crypto_key.secrets_primary.id

  }


  lifecycle {

    prevent_destroy = true

  }


  depends_on = [terraform_data.approval_gate]
}
resource "google_logging_project_sink" "production" {


  name = "nearyou-production-audit"

  destination = "logging.googleapis.com/${google_logging_project_bucket_config.production.id}"

  filter = "resource.type=(\"cloud_run_revision\" OR \"cloudsql_database\" OR \"cloud_scheduler_job\" OR \"cloud_tasks_queue\") OR protoPayload.serviceName=(\"cloudkms.googleapis.com\" OR \"secretmanager.googleapis.com\")"


  depends_on = [terraform_data.approval_gate]
}
resource "google_project_iam_member" "log_sink_writer" {

  project = var.project_id

  role = "roles/logging.bucketWriter"

  member = google_logging_project_sink.production.writer_identity

  depends_on = [terraform_data.approval_gate]
}
