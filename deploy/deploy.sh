#!/usr/bin/env bash
# Updates szigzug.hu to a commit from GitHub, safely:
#   1. fetch the code          2. run the full test suite on the server
#   3. back up the database    4. restart the app
#   5. check that it answers   6. go back to the previous version if anything fails
#
# Manually:            sudo -u szigzug bash /opt/szigzug/deploy/deploy.sh
# A specific version:  sudo -u szigzug bash /opt/szigzug/deploy/deploy.sh <commit>
# GitHub Actions runs it over SSH (deploy/README.md, step 8b).

set -euo pipefail

main() {
  local app_dir="${APP_DIR:-/opt/szigzug}"
  local ref="${1:-origin/main}"
  local db_path="${DB_PATH:-/var/lib/szigzug/szigzug.db}"
  local health_url="${HEALTH_URL:-http://127.0.0.1:3000/healthz}"
  local test_log="/tmp/szigzug-deploy-tests.log"
  local restarted=0

  cd "$app_dir"
  local previous
  previous="$(git rev-parse HEAD)"

  rollback() {
    echo "!! Deploy failed: going back to $(git rev-parse --short "$previous")" >&2
    git checkout --quiet --detach "$previous"
    if [[ "$restarted" == 1 ]]; then
      sudo /usr/bin/systemctl restart szigzug || true
    fi
    exit 1
  }

  git fetch --quiet --prune origin
  git checkout --quiet --detach "$ref"
  echo "Deploying $(git log -1 --format='%h %s (%an, %ar)')"

  echo "Running tests..."
  # The tests never touch the real database (they use in-memory ones), and DB_PATH is not exported here.
  if ! env -u DB_PATH node --disable-warning=ExperimentalWarning --test "test/**/*.test.js" > "$test_log" 2>&1; then
    tail -n 40 "$test_log" >&2
    rollback
  fi
  grep -E '^# (tests|pass|fail)' "$test_log" || true

  echo "Backing up the database..."
  DB_PATH="$db_path" BACKUP_DIR="${BACKUP_DIR:-/var/backups/szigzug}" node --disable-warning=ExperimentalWarning bin/backup.js || rollback

  echo "Restarting..."
  restarted=1
  sudo /usr/bin/systemctl restart szigzug || rollback

  for _ in $(seq 1 30); do
    if curl --silent --fail --max-time 2 "$health_url" > /dev/null; then
      echo "Deployed $(git rev-parse --short HEAD). The site answers."
      return 0
    fi
    sleep 0.5
  done
  rollback
}

# Everything is inside main, so bash has read the whole script before git replaces this file.
main "$@"
exit
