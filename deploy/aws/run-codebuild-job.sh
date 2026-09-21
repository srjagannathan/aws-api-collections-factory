#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0

set -uo pipefail

: "${APISYNC_HOME:?APISYNC_HOME is required}"
: "${APISYNC_JOB_ID:?APISYNC_JOB_ID is required}"
: "${APISYNC_JOB_KIND:?APISYNC_JOB_KIND is required}"
: "${STATE_BUCKET:?STATE_BUCKET is required}"

job_log="${APISYNC_HOME}/job-${APISYNC_JOB_ID}.log"
result_json="/tmp/aws-api-collections-factory-${APISYNC_JOB_ID}-result.json"
mkdir -p "${APISYNC_HOME}"

case "${APISYNC_JOB_KIND}" in
  check)
    command=(node backend/dist/src/cli.js check --json)
    ;;
  preview)
    command=(node backend/dist/src/cli.js refresh --service "${APISYNC_SERVICES:-}" --dry-run --json)
    ;;
  publish)
    command=(node backend/dist/src/cli.js refresh --service "${APISYNC_SERVICES:-}" --json)
    if [[ "${APISYNC_CREATE_MISSING:-false}" == "true" ]]; then
      command+=(--create-missing)
    fi
    ;;
  *)
    printf 'ERROR: Unsupported job kind: %s\n' "${APISYNC_JOB_KIND}" | tee "${job_log}"
    exit 2
    ;;
esac

printf 'Starting %s job %s\n' "${APISYNC_JOB_KIND}" "${APISYNC_JOB_ID}" | tee "${job_log}"
"${command[@]}" > "${result_json}" 2> >(tee -a "${job_log}" >&2)
pipeline_status=$?
result_status=0
if [[ -s "${result_json}" ]]; then
  cat "${result_json}" | tee -a "${job_log}"
  if node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "${result_json}"; then
    aws s3 cp "${result_json}" "s3://${STATE_BUCKET}/jobs/${APISYNC_JOB_ID}/result.json" \
      --content-type "application/json" \
      --cache-control "no-store" \
      --only-show-errors
    result_status=$?
  else
    printf 'ERROR: Pipeline result was not valid JSON.\n' | tee -a "${job_log}"
    result_status=1
  fi
else
  printf 'ERROR: Pipeline did not produce a result.\n' | tee -a "${job_log}"
  result_status=1
fi

models_root="${APISYNC_HOME}/models/api-models-aws/models"
if [[ -d "${models_root}" ]]; then
  node backend/dist/src/catalog-export.js \
    "${models_root}" \
    "${APISYNC_HOME}/service-catalog.json" 2>&1 | tee -a "${job_log}"
  catalog_status=${PIPESTATUS[0]}
else
  printf 'WARNING: The model catalog was not available for export.\n' | tee -a "${job_log}"
  catalog_status=0
fi

aws s3 sync "${APISYNC_HOME}/" "s3://${STATE_BUCKET}/state/" \
  --exclude "models/*" \
  --exclude "job-*.log" \
  --only-show-errors
state_status=$?
aws s3 cp "${job_log}" "s3://${STATE_BUCKET}/jobs/${APISYNC_JOB_ID}/output.log" \
  --content-type "text/plain; charset=utf-8" \
  --cache-control "no-store" \
  --only-show-errors
log_status=$?

if [[ ${pipeline_status} -ne 0 ]]; then exit "${pipeline_status}"; fi
if [[ ${result_status} -ne 0 ]]; then exit "${result_status}"; fi
if [[ ${catalog_status} -ne 0 ]]; then exit "${catalog_status}"; fi
if [[ ${state_status} -ne 0 ]]; then exit "${state_status}"; fi
exit "${log_status}"
