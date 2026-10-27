# Store content in SQLite and images on local disk

V1 targets a single persistent server or container. Store content in SQLite and uploaded images in a directory on the persistent volume, rather than requiring a separate database or object-storage service.

This keeps a single-owner deployment self-contained. Backups must cover both the database and uploaded files; serverless hosting and distributed deployments are not v1 targets.
