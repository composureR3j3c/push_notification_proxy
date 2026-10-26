#!/usr/bin/env bash
# Installs and configures pm2-logrotate for daily log rotation.
# Run once on each host that runs this app under pm2.
set -euo pipefail

# pm2 is a local project dependency (package.json), not global - `npx`
# resolves it from node_modules without needing a separate global
# install. cd to the repo root first so that resolution works no
# matter where this script is invoked from.
cd "$(dirname "$0")/.."
PM2="npx pm2"

$PM2 install pm2-logrotate

# Rotate daily at midnight, regardless of size.
$PM2 set pm2-logrotate:rotateInterval '0 0 * * *'

# Also rotate early if a single day's log somehow exceeds this, so one
# noisy day can't balloon disk usage before the next midnight rotation.
$PM2 set pm2-logrotate:max_size 10M

# Keep 30 rotated files (~30 days at one rotation/day). Adjust to match
# whatever retention period Compliance/Risk signs off on for logs that
# can contain push-payload bodies (see proxy.js's MAX_LOGGED_BODY_BYTES
# truncation and the redaction notes there).
$PM2 set pm2-logrotate:retain 30

# Gzip rotated files to cut disk usage; pm2 handles the .gz transparently.
$PM2 set pm2-logrotate:compress true

$PM2 set pm2-logrotate:dateFormat 'YYYY-MM-DD_HH-mm-ss'

# How often the rotation worker checks (seconds) - default is fine,
# set explicitly so it isn't an unexplained magic number if ever read
# back with `pm2 conf`.
$PM2 set pm2-logrotate:workerInterval 30

echo "pm2-logrotate configured. Current settings:"
$PM2 conf pm2-logrotate
