# CDX Filter Lambda

AWS Lambda function that filters Common Crawl CDX index files for `.docx` URLs.

## Why a Separate Service?

Common Crawl's HTTPS API is heavily rate-limited (503/429 errors). But their data lives in S3 (`s3://commoncrawl` in us-east-1), and AWS services in the same region can access it directly with **no rate limits**.

| Approach | Speed | Cost |
|----------|-------|------|
| Local (HTTPS) | Days | Rate-limited |
| Lambda (S3) | Minutes | ~$3/crawl |

## Setup

### 1. Create IAM role

```bash
# Create role
aws iam create-role --role-name lambda-cdx-filter \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "lambda.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'

# Attach policies
aws iam attach-role-policy --role-name lambda-cdx-filter \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

aws iam create-policy --policy-name commoncrawl-read \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:ListBucket"],
      "Resource": ["arn:aws:s3:::commoncrawl", "arn:aws:s3:::commoncrawl/*"]
    }]
  }'

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
aws iam attach-role-policy --role-name lambda-cdx-filter \
  --policy-arn arn:aws:iam::${ACCOUNT_ID}:policy/commoncrawl-read
```

### 2. Deploy

```bash
npm install
npm run build

source ../../.env
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

aws lambda create-function \
  --function-name cdx-filter \
  --runtime nodejs20.x \
  --handler index.handler \
  --zip-file fileb://function.zip \
  --role arn:aws:iam::${ACCOUNT_ID}:role/lambda-cdx-filter \
  --memory-size 2048 \
  --timeout 900 \
  --architectures arm64 \
  --region us-east-1 \
  --environment "Variables={R2_ACCOUNT_ID=${CLOUDFLARE_ACCOUNT_ID},R2_ACCESS_KEY_ID=${R2_ACCESS_KEY_ID},R2_SECRET_ACCESS_KEY=${R2_SECRET_ACCESS_KEY},R2_BUCKET_NAME=${R2_BUCKET_NAME:-docx-corpus}}"
```

### 3. Update (after code changes)

```bash
npm run build
aws lambda update-function-code \
  --function-name cdx-filter \
  --region us-east-1 \
  --zip-file fileb://function.zip
```

## Usage

```bash
# Process all CDX files for a crawl
./invoke-all.sh CC-MAIN-2025-51

# Monitor progress
aws logs tail /aws/lambda/cdx-filter --follow --region us-east-1
```

Output is stored in R2 at `cdx-filtered/{crawl-id}/*.jsonl`.
