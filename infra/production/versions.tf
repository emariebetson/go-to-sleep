terraform {

  required_version = "= 1.9.8"


  required_providers {

    google = {
      source  = "hashicorp/google",
      version = "= 6.16.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta",
      version = "= 6.16.0"
    }

    cloudflare = {
      source  = "cloudflare/cloudflare",
      version = "= 5.1.0"
    }

  }
  backend "gcs" {}
}
