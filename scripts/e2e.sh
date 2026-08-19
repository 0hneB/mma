#!/usr/bin/env bash
# Run the Linux e2e suite in Docker against the prebuilt image, no rebuild needed
# for test-only changes (specs/config/scripts are live-mounted via the dev overlay).
#
# Usage:
#   scripts/e2e.sh                                  # full suite, single container
#   scripts/e2e.sh test/e2e/foo.test.ts [more...]   # only the given spec files
#   scripts/e2e.sh --shard [N]                      # full suite split across N containers (default 3)
#   scripts/e2e.sh --mock [...]                     # add --mock (any position before specs) to
#                                                   #   monkey-patch Street View (deterministic, no network)
#   scripts/e2e.sh --web [...]                      # run the same specs against the web-serve
#                                                   #   build in Chrome instead of the native shell
#   scripts/e2e.sh --bench                          # the performance suite only, one container,
#                                                   #   never sharded. Results land in
#                                                   #   app/test/perf/results (live-mounted).
#                                                   #   Tune with MMA_BENCH_SCALES / _SAMPLES /
#                                                   #   _WARMUPS / _ROUTES / _SEED / _LABEL / _GPU.
#
# Rebuild the image first (after app source changes) with: scripts/e2e-build.sh
set -uo pipefail
# Git Bash (Windows) rewrites args that look like absolute paths (e.g. /repo/...) into
# Windows paths before they reach docker. Disable that; harmless on Linux hosts.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
cd "$(dirname "$0")/.."

# Leading flags, any order: --mock enables the test-side Street View monkey-patch,
# --web swaps the native-shell runner for the web-serve one (Chrome over HTTP IPC).
MOCK_ENV=()
BENCH=0
RUNNER="sh /repo/scripts/internal/e2e-native.sh"
while :; do
	case "${1:-}" in
	--mock)
		MOCK_ENV=(-e MMA_TEST_MOCK_SV=1)
		shift
		;;
	--web)
		RUNNER="sh /repo/scripts/internal/e2e-web.sh"
		shift
		;;
	--bench)
		BENCH=1
		shift
		;;
	*) break ;;
	esac
done

COMPOSE="docker compose -f docker-compose.e2e.yml -f docker-compose.e2e.dev.yml"

# Warn when baked sources are newer than the e2e image. Test specs, wdio config,
# and scripts/ are live-mounted; anything else baked needs scripts/e2e-build.sh.
IMAGE=$($COMPOSE config --images e2e 2>/dev/null | head -1)
CREATED=$(docker image inspect --format '{{.Created}}' "$IMAGE" 2>/dev/null)
if [ -n "$CREATED" ]; then
	stamp=$(mktemp)
	if touch -d "$CREATED" "$stamp" 2>/dev/null; then
		stale=$(find app/src app/src-tauri/src app/src-tauri/Cargo.toml \
			app/src-tauri/tauri.conf.json app/package.json app/public plugins \
			-type f -newer "$stamp" -print -quit 2>/dev/null)
		if [ -n "$stale" ]; then
			echo "WARNING: the e2e image is STALE - $stale changed after it was built." >&2
			echo "         Rebuild with: bash scripts/e2e-build.sh (test-only edits are live-mounted)." >&2
		fi
	fi
	rm -f "$stamp"
fi

if [ "$BENCH" = "1" ]; then
	if [ "${1:-}" = "--shard" ]; then
		echo "--bench is never sharded: benchmark numbers must be comparable run to run." >&2
		exit 1
	fi
	# Stamped into the result JSON so two runs can be told apart by commit.
	BENCH_ENV=(-e "MMA_BENCH_REVISION=$(git rev-parse HEAD 2>/dev/null || echo unknown)")
	for var in MMA_BENCH_SCALES MMA_BENCH_SAMPLES MMA_BENCH_WARMUPS MMA_BENCH_ROUTES \
		MMA_BENCH_SEED MMA_BENCH_LABEL MMA_BENCH_GPU; do
		if [ -n "${!var:-}" ]; then BENCH_ENV+=(-e "$var=${!var}"); fi
	done
	# --exclude overrides the config's exclude list, which otherwise also blocks --spec.
	exec $COMPOSE run "${MOCK_ENV[@]}" "${BENCH_ENV[@]}" --rm e2e $RUNNER \
		--spec ./test/e2e/performance.test.ts --exclude ./test/e2e/scratch.test.ts
fi

if [ "${1:-}" = "--shard" ]; then
	N="${2:-3}"
	echo "Running e2e suite across $N parallel containers..."
	pids=()
	for i in $(seq 1 "$N"); do
		$COMPOSE run "${MOCK_ENV[@]}" --rm e2e $RUNNER --shard "$i/$N" >"shard-$i.log" 2>&1 &
		pids+=("$!")
	done
	rc=0
	for idx in "${!pids[@]}"; do
		i=$((idx + 1))
		if wait "${pids[$idx]}"; then
			echo "shard $i/$N: PASS"
		else
			echo "shard $i/$N: FAIL (see shard-$i.log)"
			rc=1
		fi
		grep -E "Spec Files:" "shard-$i.log" | tail -1
	done
	exit $rc
fi

# Subset: prefix each spec file with --spec. No args => full suite.
args=()
for s in "$@"; do args+=(--spec "$s"); done
exec $COMPOSE run "${MOCK_ENV[@]}" --rm e2e $RUNNER "${args[@]}"
