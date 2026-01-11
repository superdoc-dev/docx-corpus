#!/bin/bash
set -e

CRAWL_ID="${1:-CC-MAIN-2025-51}"
REGION="${2:-us-east-1}"

echo "Fetching CDX paths for $CRAWL_ID..."

# Fetch and decompress the paths list
PATHS=$(curl -s "https://data.commoncrawl.org/crawl-data/${CRAWL_ID}/cc-index.paths.gz" | gunzip)

# Count total
TOTAL=$(echo "$PATHS" | wc -l | tr -d ' ')
echo "Found $TOTAL CDX files"

# Invoke Lambda for each path
COUNT=0
echo "$PATHS" | while read -r CDX_PATH; do
  if [ -n "$CDX_PATH" ]; then
    COUNT=$((COUNT + 1))
    aws lambda invoke \
      --function-name cdx-filter \
      --region "$REGION" \
      --invocation-type Event \
      --cli-binary-format raw-in-base64-out \
      --payload "{\"cdxPath\":\"$CDX_PATH\",\"crawlId\":\"$CRAWL_ID\"}" \
      /dev/null > /dev/null 2>&1
    echo "[$COUNT/$TOTAL] Queued: $(basename "$CDX_PATH")"
  fi
done

echo "Done! All $TOTAL Lambda invocations queued."
echo "Monitor with: aws logs tail /aws/lambda/cdx-filter --follow --region $REGION"
