# ---------------------------------------------------------------------------
# Backups — what exists, and what is deliberately manual.
#
# There is no Terraform in this file. It documents where the three layers of
# recovery actually live, because they are configured on the resources they
# protect and would otherwise be invisible as a whole.
#
# 1. **Postgres point-in-time restore** — `postgres.tf`,
#    `backup_retention_days` (default 35). Recovers from a bad migration or a
#    mistaken DELETE to any second inside the window. It does *not* survive the
#    server being deleted, and it cannot be read outside Azure.
#
# 2. **Blob versioning and soft delete** — `storage.tf`, `blob_retention_days`.
#    Recovers a menu photo the owner overwrote. PITR does not cover this at all,
#    because blobs are not in the database. Versioning rather than soft delete
#    alone is the important part: the common accident is overwriting a good photo,
#    which is a write, and leaves nothing to undelete.
#
# 3. **A weekly logical dump** — manual, and honestly so.
#
# ## Why the dump is not automated here
#
# Doing it properly needs `pg_dump` running with network access to a database
# that has no public endpoint. On Container Apps that was a scheduled job with a
# Postgres image; this deployment removed the container platform, and adding one
# back solely for a weekly dump is a lot of moving parts for something the owner
# can be walked through in five minutes.
#
# The honest position is that this is a runbook step (see infra/README.md), not
# infrastructure — and writing that down beats a `null_resource` that runs on
# whoever last typed `terraform apply` and silently stops when they stop.
#
# It is the layer that matters when the other two do not: a dump in a storage
# account is restorable somewhere else, by somebody else, without Azure's
# cooperation. PITR has no answer to the subscription being lost or locked.
#
# Revisit if the restaurant grows enough that a week of orders is worth more than
# the complexity — an Azure Container Instance on a Logic App schedule is the
# smallest thing that would do it.
# ---------------------------------------------------------------------------
