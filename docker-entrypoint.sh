#!/bin/sh
# Summa container entrypoint.
#
# v1 ships without Prisma migrations: the schema is applied with
# `prisma db push` at startup. db push is idempotent (a no-op when the
# database is already up to date), so restarts are safe. We retry for a
# while because the database may still be starting even with the
# compose healthcheck gate in place.
set -e
cd /app
attempt=0
until node_modules/.bin/prisma db push --skip-generate; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "summa: database not reachable after 30 attempts, giving up" >&2
    exit 1
  fi
  echo "summa: waiting for database (attempt $attempt)..."
  sleep 2
done
exec "$@"
