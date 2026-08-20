resource "google_service_account" "readiness_decision" {
  count        = local.readiness_gateway_proof_ready ? 1 : 0
  account_id   = "nearyou-readiness-decision"
  display_name = "NearYou readiness decision"

  depends_on = [terraform_data.approval_gate]
}

resource "google_service_account" "readiness_controller_kill" {
  count        = local.readiness_gateway_proof_ready ? 1 : 0
  account_id   = "nearyou-readiness-kill"
  display_name = "NearYou readiness controller kill"

  depends_on = [terraform_data.approval_gate]
}

resource "google_project_iam_member" "readiness_decision_cloudsql_client" {
  count   = local.readiness_gateway_proof_ready ? 1 : 0
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.readiness_decision[0].email}"

  depends_on = [terraform_data.approval_gate]
}

resource "google_project_iam_member" "readiness_decision_cloudsql_user" {
  count   = local.readiness_gateway_proof_ready ? 1 : 0
  project = var.project_id
  role    = "roles/cloudsql.instanceUser"
  member  = "serviceAccount:${google_service_account.readiness_decision[0].email}"

  depends_on = [terraform_data.approval_gate]
}

resource "google_project_iam_member" "readiness_controller_kill_cloudsql_client" {
  count   = local.readiness_gateway_proof_ready ? 1 : 0
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.readiness_controller_kill[0].email}"

  depends_on = [terraform_data.approval_gate]
}

resource "google_project_iam_member" "readiness_controller_kill_cloudsql_user" {
  count   = local.readiness_gateway_proof_ready ? 1 : 0
  project = var.project_id
  role    = "roles/cloudsql.instanceUser"
  member  = "serviceAccount:${google_service_account.readiness_controller_kill[0].email}"

  depends_on = [terraform_data.approval_gate]
}

resource "google_sql_user" "readiness_decision" {
  count    = local.readiness_gateway_proof_ready ? 1 : 0
  name     = google_service_account.readiness_decision[0].email
  instance = google_sql_database_instance.primary.name
  type     = "CLOUD_IAM_SERVICE_ACCOUNT"

  depends_on = [terraform_data.approval_gate]
}

resource "google_sql_user" "readiness_controller_kill" {
  count    = local.readiness_gateway_proof_ready ? 1 : 0
  name     = google_service_account.readiness_controller_kill[0].email
  instance = google_sql_database_instance.primary.name
  type     = "CLOUD_IAM_SERVICE_ACCOUNT"

  depends_on = [terraform_data.approval_gate]
}

locals {
  readiness_gateway_proof_ready            = var.readiness_gateway_disposable && var.readiness_gateway_proof_approved
  readiness_decision_database_user         = local.readiness_gateway_proof_ready ? trimsuffix(google_service_account.readiness_decision[0].email, ".gserviceaccount.com") : null
  readiness_controller_kill_database_user  = local.readiness_gateway_proof_ready ? trimsuffix(google_service_account.readiness_controller_kill[0].email, ".gserviceaccount.com") : null
  readiness_decision_oidc_principal        = "service:nearyou-readiness-decision"
  readiness_controller_kill_oidc_principal = "service:nearyou-readiness-controller-kill"
}

resource "google_cloud_run_v2_service" "readiness_decision" {
  provider = google-beta
  count    = local.readiness_gateway_proof_ready ? 1 : 0

  name     = "nearyou-readiness-decision"
  location = local.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"

  launch_stage         = "BETA"
  default_uri_disabled = true
  # The external Application Load Balancer has no Google IAM identity. Ingress
  # and the disabled default URL prevent this from making a direct public path.
  invoker_iam_disabled = true

  deletion_protection = true

  template {
    service_account = google_service_account.readiness_decision[0].email
    timeout         = "2s"
    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }
    max_instance_request_concurrency = 10

    volumes {
      name = "readiness-db-url"
      secret {
        secret = var.readiness_decision_secret_name
        items {
          version = var.readiness_decision_secret_version
          path    = "database-url"
        }
      }
    }

    vpc_access {
      network_interfaces {
        network    = google_compute_network.private.name
        subnetwork = google_compute_subnetwork.private.name
      }
      egress = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = var.readiness_decision_image_digest

      volume_mounts {
        name       = "readiness-db-url"
        mount_path = "/var/run/secrets/nearyou"
      }

      env {
        name  = "NEARYOU_READINESS_DECISION_DATABASE_USER"
        value = local.readiness_decision_database_user
      }
      env {
        name  = "NEARYOU_READINESS_DECISION_OIDC_PRINCIPAL"
        value = local.readiness_decision_oidc_principal
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
      }
    }
  }

  depends_on = [terraform_data.approval_gate, google_sql_user.readiness_decision[0], google_project_iam_member.readiness_decision_cloudsql_user[0]]
}

resource "google_cloud_run_v2_service" "readiness_controller" {
  count = local.readiness_gateway_proof_ready ? 1 : 0

  name     = "nearyou-readiness-controller"
  location = local.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  deletion_protection = true

  template {
    service_account = google_service_account.readiness_controller.email
    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }

    volumes {
      name = "readiness-db-url"
      secret {
        secret = var.readiness_controller_secret_name
        items {
          version = var.readiness_controller_secret_version
          path    = "database-url"
        }
      }
    }

    vpc_access {
      network_interfaces {
        network    = google_compute_network.private.name
        subnetwork = google_compute_subnetwork.private.name
      }
      egress = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = var.readiness_controller_image_digest

      volume_mounts {
        name       = "readiness-db-url"
        mount_path = "/var/run/secrets/nearyou"
      }

      env {
        name  = "NEARYOU_READINESS_CONTROLLER_DATABASE_USER"
        value = local.readiness_controller_database_user
      }
      env {
        name  = "NEARYOU_READINESS_CONTROLLER_OIDC_PRINCIPAL"
        value = local.readiness_controller_oidc_principal
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
      }
    }
  }

  depends_on = [terraform_data.approval_gate, google_project_iam_member.readiness_controller_cloudsql_user]
}

resource "google_compute_region_network_endpoint_group" "readiness_decision" {
  count                 = local.readiness_gateway_proof_ready ? 1 : 0
  name                  = "nearyou-readiness-decision"
  region                = local.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = google_cloud_run_v2_service.readiness_decision[0].name
  }

  depends_on = [terraform_data.approval_gate]
}

resource "google_compute_security_policy" "readiness_decision" {
  count = local.readiness_gateway_proof_ready ? 1 : 0
  name  = "nearyou-readiness-decision"

  rule {
    priority = 1000
    action   = "throttle"

    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }

    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "IP"
      rate_limit_threshold {
        count        = 60
        interval_sec = 60
      }
    }
  }

  rule {
    priority = 2147483647
    action   = "allow"
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
  }

  depends_on = [terraform_data.approval_gate]
}

resource "google_compute_backend_service" "readiness_decision" {
  count                 = local.readiness_gateway_proof_ready ? 1 : 0
  name                  = "nearyou-readiness-decision"
  protocol              = "HTTP"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  security_policy       = google_compute_security_policy.readiness_decision[0].id

  backend {
    group = google_compute_region_network_endpoint_group.readiness_decision[0].id
  }

  depends_on = [terraform_data.approval_gate]
}

resource "google_compute_url_map" "readiness_decision" {
  count           = local.readiness_gateway_proof_ready ? 1 : 0
  name            = "nearyou-readiness-decision"
  default_service = google_compute_backend_service.readiness_decision[0].id

  host_rule {
    hosts        = [var.readiness_decision_hostname]
    path_matcher = "decision"
  }

  path_matcher {
    name            = "decision"
    default_service = google_compute_backend_service.readiness_decision[0].id
  }

  depends_on = [terraform_data.approval_gate]
}

resource "google_compute_managed_ssl_certificate" "readiness_decision" {
  count = local.readiness_gateway_proof_ready ? 1 : 0
  name  = "nearyou-readiness-decision"

  managed {
    domains = [var.readiness_decision_hostname]
  }

  depends_on = [terraform_data.approval_gate]
}

resource "google_compute_target_https_proxy" "readiness_decision" {
  count            = local.readiness_gateway_proof_ready ? 1 : 0
  name             = "nearyou-readiness-decision"
  url_map          = google_compute_url_map.readiness_decision[0].id
  ssl_certificates = [google_compute_managed_ssl_certificate.readiness_decision[0].id]

  depends_on = [terraform_data.approval_gate]
}

resource "google_compute_global_address" "readiness_decision" {
  count        = local.readiness_gateway_proof_ready ? 1 : 0
  name         = "nearyou-readiness-decision"
  address_type = "EXTERNAL"
  ip_version   = "IPV4"

  depends_on = [terraform_data.approval_gate]
}

resource "google_compute_global_forwarding_rule" "readiness_decision" {
  count                 = local.readiness_gateway_proof_ready ? 1 : 0
  name                  = "nearyou-readiness-decision"
  ip_address            = google_compute_global_address.readiness_decision[0].address
  ip_protocol           = "TCP"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  port_range            = "443"
  target                = google_compute_target_https_proxy.readiness_decision[0].id

  depends_on = [terraform_data.approval_gate]
}

resource "google_cloud_run_v2_service" "readiness_controller_kill" {
  count = local.readiness_gateway_proof_ready ? 1 : 0

  name     = "nearyou-readiness-controller-kill"
  location = local.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  deletion_protection = true

  template {
    service_account = google_service_account.readiness_controller_kill[0].email
    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }

    volumes {
      name = "readiness-db-url"
      secret {
        secret = var.readiness_kill_secret_name
        items {
          version = var.readiness_kill_secret_version
          path    = "database-url"
        }
      }
    }

    vpc_access {
      network_interfaces {
        network    = google_compute_network.private.name
        subnetwork = google_compute_subnetwork.private.name
      }
      egress = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = var.readiness_controller_image_digest

      volume_mounts {
        name       = "readiness-db-url"
        mount_path = "/var/run/secrets/nearyou"
      }

      env {
        name  = "NEARYOU_READINESS_KILL_DATABASE_USER"
        value = local.readiness_controller_kill_database_user
      }
      env {
        name  = "NEARYOU_READINESS_KILL_AUDIENCE"
        value = var.readiness_kill_service_audience
      }
      env {
        name  = "NEARYOU_READINESS_KILL_OIDC_PRINCIPAL"
        value = local.readiness_controller_kill_oidc_principal
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
      }
    }
  }

  depends_on = [terraform_data.approval_gate, google_project_iam_member.readiness_controller_kill_cloudsql_user[0]]
}
