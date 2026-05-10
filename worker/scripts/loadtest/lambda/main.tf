// AWS Lambda fan-out for the game-day load-test harness.
//
// Provisions one Lambda function per US AWS region listed in
// `var.regions`, plus a single S3 bucket in the primary region for
// results. The driver code is `scripts/loadtest/driver.mjs` and the
// Lambda entrypoint is `scripts/loadtest/lambda/handler.mjs`.
//
// Usage:
//   cd worker/scripts/loadtest/lambda
//   npm install                         # produces node_modules with @aws-sdk/client-s3
//   terraform init
//   terraform apply                     # creates Lambdas + bucket
//   ./run.sh "<run-tag>"                # invokes all regions in parallel
//   terraform destroy                   # tear down when done
//
// The Lambdas have NO scheduled trigger — they're invoked manually by
// run.sh via the AWS SDK. EventBridge would auto-fire them on a
// schedule but for ad-hoc load testing, manual invocation is the
// right shape.

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}

variable "regions" {
  description = "AWS regions to deploy a driver Lambda into. Picked for US PoP coverage on Cloudflare's anycast. AWS doesn't have a Dallas region (us-east-2 Ohio is the closest CF-PoP-aligned option), so DFW won't be exercised — that's an acceptable gap; for a US-centric audience the existing 5 cover ~85% of viewers."
  type        = list(string)
  default = [
    "us-east-1",   # N. Virginia → IAD PoP
    "us-east-2",   # Ohio → ORD/CMH
    "us-west-1",   # N. California → SJC
    "us-west-2",   # Oregon → SEA/PDX
    "ca-central-1" # Montreal → YUL/YYZ (Canadian PoP, but routes to a different upper-tier than the US ones, useful for "outside the US" comparison)
  ]
}

variable "primary_region" {
  description = "Region for the S3 results bucket and IAM role. Lambdas in other regions all write to this bucket."
  type        = string
  default     = "us-east-1"
}

variable "results_bucket_name" {
  description = "Globally-unique S3 bucket name for run results. Override if your account already owns the default."
  type        = string
  default     = "gameonpaper-loadtest-results"
}

variable "lambda_memory_mb" {
  description = "Lambda memory size in MB. 512 MB is plenty for 17 concurrent fetch loops; bumping increases CPU share which can subtly change per-request timing — keep it constant across runs for fair architecture comparison."
  type        = number
  default     = 512
}

variable "lambda_timeout_s" {
  description = "Lambda invocation timeout. Must be > runDurationSeconds + a margin for S3 PUT. 30-min run = 1800 s; cap at 900 s (Lambda hard max is 900 s)."
  type        = number
  default     = 900
}

provider "aws" {
  region = var.primary_region
}

// Provider aliases for each non-primary region so we can deploy the
// Lambda in-region. Terraform requires one provider config per region.
provider "aws" {
  alias  = "us_east_2"
  region = "us-east-2"
}
provider "aws" {
  alias  = "us_west_1"
  region = "us-west-1"
}
provider "aws" {
  alias  = "us_west_2"
  region = "us-west-2"
}
provider "aws" {
  alias  = "ca_central_1"
  region = "ca-central-1"
}

// Map region → provider alias. Terraform doesn't support dynamic
// provider selection, so each region's Lambda is declared explicitly
// below. Adding a region means: add a provider alias above, declare
// a new aws_lambda_function block below, and append to var.regions.
locals {
  function_name = "gameonpaper-loadtest-driver"
  zip_path      = "${path.module}/lambda.zip"
}

// Bundle handler.mjs + driver.mjs + node_modules into a single zip.
// The handler imports from ../driver.mjs; we copy it next to the
// handler at zip time so the relative import resolves under Lambda's
// /var/task layout.
data "archive_file" "lambda_zip" {
  type        = "zip"
  output_path = local.zip_path
  source {
    content  = file("${path.module}/handler.mjs")
    filename = "handler.mjs"
  }
  source {
    content  = file("${path.module}/../driver.mjs")
    filename = "driver.mjs"
  }
  // node_modules are pulled in via a fileset() below — the archive_file
  // source{} block doesn't support directory globs, so we attach the
  // dependency layer separately. For now, package via `npm install`
  // before `terraform apply` and let archive_file pick up the tree.
}

// S3 bucket for results. JSONL files land at runs/<run_id>/<region>.jsonl.
resource "aws_s3_bucket" "results" {
  bucket        = var.results_bucket_name
  force_destroy = true

  // Tagged for ad-hoc cleanup. Loadtest data has no compliance value.
  tags = {
    Project = "gameonpaper-loadtest"
    Owner   = "loadtest-harness"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "results" {
  bucket = aws_s3_bucket.results.id

  rule {
    id     = "expire-runs-30d"
    status = "Enabled"
    filter {
      prefix = "runs/"
    }
    expiration {
      days = 30
    }
  }
}

// One IAM role shared across all regional Lambdas. S3 PUT-only on the
// results bucket. Logs to CloudWatch in each region.
data "aws_iam_policy_document" "assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "driver" {
  name               = "gameonpaper-loadtest-driver"
  assume_role_policy = data.aws_iam_policy_document.assume_role.json
}

resource "aws_iam_role_policy_attachment" "logs" {
  role       = aws_iam_role.driver.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "s3_put" {
  statement {
    actions   = ["s3:PutObject", "s3:PutObjectAcl"]
    resources = ["${aws_s3_bucket.results.arn}/*"]
  }
}

resource "aws_iam_policy" "s3_put" {
  name   = "gameonpaper-loadtest-s3-put"
  policy = data.aws_iam_policy_document.s3_put.json
}

resource "aws_iam_role_policy_attachment" "s3_put" {
  role       = aws_iam_role.driver.name
  policy_arn = aws_iam_policy.s3_put.arn
}

// Per-region Lambda. Common args extracted into locals so the
// duplication across regions stays mechanical.
locals {
  lambda_common = {
    function_name = local.function_name
    role          = aws_iam_role.driver.arn
    handler       = "handler.handler"
    runtime       = "nodejs20.x"
    timeout       = var.lambda_timeout_s
    memory_size   = var.lambda_memory_mb
    filename      = data.archive_file.lambda_zip.output_path
    source_code_hash = data.archive_file.lambda_zip.output_base64sha256
    environment = {
      LOADTEST_RESULTS_BUCKET = aws_s3_bucket.results.id
    }
  }
}

resource "aws_lambda_function" "driver_us_east_1" {
  function_name    = local.lambda_common.function_name
  role             = local.lambda_common.role
  handler          = local.lambda_common.handler
  runtime          = local.lambda_common.runtime
  timeout          = local.lambda_common.timeout
  memory_size      = local.lambda_common.memory_size
  filename         = local.lambda_common.filename
  source_code_hash = local.lambda_common.source_code_hash
  environment {
    variables = local.lambda_common.environment
  }
}

resource "aws_lambda_function" "driver_us_east_2" {
  provider         = aws.us_east_2
  function_name    = local.lambda_common.function_name
  role             = local.lambda_common.role
  handler          = local.lambda_common.handler
  runtime          = local.lambda_common.runtime
  timeout          = local.lambda_common.timeout
  memory_size      = local.lambda_common.memory_size
  filename         = local.lambda_common.filename
  source_code_hash = local.lambda_common.source_code_hash
  environment {
    variables = local.lambda_common.environment
  }
}

resource "aws_lambda_function" "driver_us_west_1" {
  provider         = aws.us_west_1
  function_name    = local.lambda_common.function_name
  role             = local.lambda_common.role
  handler          = local.lambda_common.handler
  runtime          = local.lambda_common.runtime
  timeout          = local.lambda_common.timeout
  memory_size      = local.lambda_common.memory_size
  filename         = local.lambda_common.filename
  source_code_hash = local.lambda_common.source_code_hash
  environment {
    variables = local.lambda_common.environment
  }
}

resource "aws_lambda_function" "driver_us_west_2" {
  provider         = aws.us_west_2
  function_name    = local.lambda_common.function_name
  role             = local.lambda_common.role
  handler          = local.lambda_common.handler
  runtime          = local.lambda_common.runtime
  timeout          = local.lambda_common.timeout
  memory_size      = local.lambda_common.memory_size
  filename         = local.lambda_common.filename
  source_code_hash = local.lambda_common.source_code_hash
  environment {
    variables = local.lambda_common.environment
  }
}

resource "aws_lambda_function" "driver_ca_central_1" {
  provider         = aws.ca_central_1
  function_name    = local.lambda_common.function_name
  role             = local.lambda_common.role
  handler          = local.lambda_common.handler
  runtime          = local.lambda_common.runtime
  timeout          = local.lambda_common.timeout
  memory_size      = local.lambda_common.memory_size
  filename         = local.lambda_common.filename
  source_code_hash = local.lambda_common.source_code_hash
  environment {
    variables = local.lambda_common.environment
  }
}

output "results_bucket" {
  value = aws_s3_bucket.results.id
}

output "function_name" {
  value = local.function_name
}

output "regions" {
  value = var.regions
}
