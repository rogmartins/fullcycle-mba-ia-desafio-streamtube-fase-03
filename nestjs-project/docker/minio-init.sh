#!/bin/sh
set -e

ALIAS=local

echo "Setting mc alias with root credentials..."
mc alias set "$ALIAS" http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"

echo "Creating application access key (readwrite policy)..."
mc admin user add "$ALIAS" "$STORAGE_ACCESS_KEY" "$STORAGE_SECRET_KEY" || true
mc admin policy attach "$ALIAS" readwrite --user "$STORAGE_ACCESS_KEY"

echo "Creating buckets..."
mc mb --ignore-existing "$ALIAS/$STORAGE_VIDEO_BUCKET"
mc mb --ignore-existing "$ALIAS/$STORAGE_THUMBNAIL_BUCKET"

echo "Setting public-read (download) on thumbnail bucket..."
mc anonymous set download "$ALIAS/$STORAGE_THUMBNAIL_BUCKET"

# Note (TD-04/TD-14 deviation): this MinIO server build does not implement the S3
# PutBucketCors API (`mc cors set` fails with "functionality that is not implemented",
# reproduced even with root credentials). MinIO instead handles CORS automatically at
# the server level for every bucket — it reflects the request Origin, honours the
# requested method/headers on preflight, and always exposes ETag, Content-Range,
# Accept-Ranges and Content-Length on real responses — so no bucket-level CORS
# configuration step is needed or possible here.
echo "CORS: handled automatically by MinIO's built-in server-level CORS (no bucket-level API to configure on this build)"

echo "Applying lifecycle (abort incomplete multipart uploads after 8 days) to video bucket..."
cat <<EOF > /tmp/lifecycle.json
{
  "Rules": [
    {
      "ID": "abort-incomplete-multipart-uploads",
      "Status": "Enabled",
      "Filter": {"Prefix": ""},
      "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 8}
    }
  ]
}
EOF
mc ilm import "$ALIAS/$STORAGE_VIDEO_BUCKET" < /tmp/lifecycle.json || echo "WARNING: MinIO rejected the lifecycle rule (expected on this MinIO build) — honoured on S3, no-op here"

echo "minio-init completed successfully"
