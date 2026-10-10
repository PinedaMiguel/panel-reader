"""Neon Object Storage (S3-compatible). Credentials come from the AWS_* vars `neon link` wrote to .env."""

from functools import cache
from pathlib import Path

import boto3
from botocore.config import Config

BUCKET = "uploads"
URL_TTL = 6 * 3600  # long enough for a reading session or a judging slot

CONTENT_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
                 ".mp3": "audio/mpeg", ".json": "application/json"}


@cache
def client():
    # Neon requires path-style addressing.
    return boto3.client("s3", config=Config(s3={"addressing_style": "path"}, signature_version="s3v4"))


def upload(path: Path, key: str) -> None:
    client().upload_file(
        str(path), BUCKET, key,
        ExtraArgs={"ContentType": CONTENT_TYPES.get(path.suffix.lower(), "application/octet-stream"),
                   "CacheControl": "private, max-age=31536000, immutable"},
    )


def presign(key: str) -> str:
    return client().generate_presigned_url("get_object", Params={"Bucket": BUCKET, "Key": key}, ExpiresIn=URL_TTL)
