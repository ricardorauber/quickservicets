# Harness for the round-2 profile. Source it: . h.sh
S=${S:?set S to a scratch folder holding seed.sql, fixtures/, out/, core-whatif/ and whatif-endpoint/}
WT=${WT:?set WT to the repository root}
NET=qsbench-p2-net
PG=qsbench-p2-postgres
APP=qsbench-p2-app
IMG=${IMG:-qsbench-p2-quickservicets}
reseed() { docker exec -i $PG psql -q -U bench -d bench -v ON_ERROR_STOP=1 < $S/seed.sql >/dev/null; }
# start_app [extra docker args...] -- [command...]
start_app() {
  docker rm -f -v $APP >/dev/null 2>&1
  docker rm -f qsbench-p2-janitor >/dev/null 2>&1
  docker volume rm -f qsbench-p2-uploads >/dev/null 2>&1; docker volume create qsbench-p2-uploads >/dev/null
  local args=() cmd=()
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do args+=("$1"); shift; done
  [ "$1" = "--" ] && shift; cmd=("$@")
  docker run -d --name $APP --network $NET --cpus=2 --memory=1g --memory-swap=1g -p 127.0.0.1:18180:8080 \
    -v qsbench-p2-uploads:/data/uploads --log-opt max-size=20m --log-opt max-file=2 \
    -e PORT=8080 -e DATABASE_URL=postgres://bench:bench@$PG:5432/bench -e DB_POOL_SIZE=10 -e UPLOAD_DIR=/data/uploads \
    "${args[@]}" $IMG "${cmd[@]}" >/dev/null
  for i in $(seq 1 200); do curl -fs http://127.0.0.1:18180/health >/dev/null 2>&1 && break; sleep 0.1; done
  docker run -d --name qsbench-p2-janitor --cpus=0.25 -v qsbench-p2-uploads:/data busybox:1.37.0 sh -c "touch /tmp/old; while true; do sleep 2; touch /tmp/new; find /data -mindepth 2 ! -newer /tmp/old \( -type f -o -type d -empty \) -delete 2>/dev/null; mv /tmp/new /tmp/old; done" >/dev/null
}
stop_app() { docker stop -t 10 $APP >/dev/null 2>&1; docker rm -f -v $APP qsbench-p2-janitor >/dev/null 2>&1; }
# k6run SCRIPT ENDPOINT DURATION  -> prints req/s
k6run() {
  local script=$1 ep=$2 dur=${3:-10s}
  docker run --rm --name qsbench-p2-k6 --network $NET --cpus=4 -v $WT/benchmarks/load:/load:ro -v $S/fixtures:/fixtures:ro -v $S/out:/out \
    -e BASE_URL=http://$APP:8080 -e VUS=64 -e DURATION=$dur -e RUN_ID=p2-$ep-$RANDOM-$(date +%s%N) -e SUMMARY_OUT=/out/s.json -e ENDPOINT=$ep \
    grafana/k6:2.3.0 run -q /load/$script >/dev/null 2>&1
  python3 -c "import json;d=json.load(open('$S/out/s.json'));print(round(d['reqPerSec']), 'err=%.4f'%d['errorRate'], 'p50=%.2f'%d['latencyMs']['p50'])"
}
script_of() { case $1 in upload) echo upload.js;; custom) echo custom.js;; *) echo single.js;; esac; }
# measure SCENARIO [warm] [dur]: warmup then measured run
measure() { local sc=$1 w=${2:-5s} d=${3:-10s}; reseed; k6run $(script_of $sc) $sc $w >/dev/null; k6run $(script_of $sc) $sc $d; }
# start_wif SWITCHES [extra docker args...]: the what-if core and stats endpoint mounted, QS_WHATIF set
start_wif() { local v=$1; shift; start_app -v $S/core-whatif:/app/packages/core/src:ro -v "$S/whatif-endpoint/get.ts:/app/benchmarks/quickservicets/endpoints/organizations/[orgId]/stats/get.ts:ro" -e QS_WHATIF=$v "$@" --; }
conform() { reseed; (cd $WT && BASE_URL=http://127.0.0.1:18180 bun test ./benchmarks/conformance/conformance.ts 2>&1 | grep -E "pass|fail|Ran" | tail -4); }
ALL=tagged,insfast,nomkdir,directwrite,bufferbody,headdetect,nocopy,nofile,aggcache,fastresp,nourl,logfast
# exp SCENARIO LABEL SWITCHES [extra docker args]: one measured run; SWITCHES "base" = the shipped core
exp() {
  local sc=$1 label=$2 sw=$3; shift 3
  reseed
  if [ "$sw" = "base" ]; then start_app "$@" --; else start_wif $sw "$@"; fi
  local r=$(measure $sc 5s 10s)
  stop_app
  echo "$(date +%H:%M:%S) $sc $label $r" | tee -a $S/results.txt
}
# rounds SCENARIO TAG N variant... : N rounds, the order rotated each round; extra docker args come from $EXTRA (an array)
rounds() {
  local sc=$1 tag=$2 n=$3; shift 3
  local vs=("$@") k=${#@}
  for r in $(seq 1 $n); do
    for i in $(seq 0 $((k-1))); do
      local idx=$(( (i + r - 1) % k + 1 ))
      local v=${vs[$idx]}
      exp $sc "$tag:$v" "$v" "${EXTRA[@]}"
    done
  done
}
cpu_us() { docker exec $1 cat /sys/fs/cgroup/cpu.stat 2>/dev/null | awk '/usage_usec/{print $2}'; }
# measure SCENARIO [warm] [dur]: warmup, then measured run with app and PostgreSQL CPU per request
measure() {
  local sc=$1 w=${2:-5s} d=${3:-10s}
  k6run $(script_of $sc) $sc $w >/dev/null
  local a0=$(cpu_us $APP) p0=$(cpu_us $PG)
  local r=$(k6run $(script_of $sc) $sc $d)
  local a1=$(cpu_us $APP) p1=$(cpu_us $PG)
  python3 -c "import json;d=json.load(open('$S/out/s.json'));n=d['requests'];print('%d rps app_us=%.1f pg_us=%.1f err=%.4f p50=%.2f'%(d['reqPerSec'],($a1-$a0)/n,($p1-$p0)/n,d['errorRate'],d['latencyMs']['p50']))"
}
# bunexp SCENARIO LABEL WORKERS: the plain-Bun reference stack in the same window
bunexp() {
  local sc=$1 label=$2 w=$3
  reseed; IMG=qsbench-bun start_app -e WORKERS=$w --
  local r=$(measure $sc 5s 10s); stop_app
  echo "$(date +%H:%M:%S) $sc $label $r" | tee -a $S/results.txt
}
# rate run: fixed arrival rate RATE, app/PG CPU per request
k6rate() {
  local ep=$1 rate=$2 dur=${3:-10s}
  docker run --rm --name qsbench-p2-k6 --network $NET --cpus=4 -v $WT/benchmarks/load:/load:ro -v $S/k6:/k6:ro -v $S/fixtures:/fixtures:ro -v $S/out:/out \
    -e BASE_URL=http://$APP:8080 -e RATE=$rate -e DURATION=$dur -e RUN_ID=r$RANDOM$(date +%s%N) -e SUMMARY_OUT=/out/s.json -e ENDPOINT=$ep grafana/k6:2.3.0 run -q /k6/rate.js >/dev/null 2>&1
}
rexp() {
  local sc=$1 label=$2 sw=$3 rate=$4; shift 4
  reseed
  if [ "$sw" = "base" ]; then start_app "$@" --; else start_wif $sw "$@"; fi
  k6rate $sc $rate 5s
  local a0=$(cpu_us $APP) p0=$(cpu_us $PG)
  k6rate $sc $rate 12s
  local a1=$(cpu_us $APP) p1=$(cpu_us $PG)
  stop_app
  local r=$(python3 -c "import json;d=json.load(open('$S/out/s.json'));n=d['requests'];print('%d rps app_us=%.1f pg_us=%.1f err=%.4f p50=%.2f'%(d['reqPerSec'],($a1-$a0)/n,($p1-$p0)/n,d['errorRate'],d['latencyMs']['p50']))")
  echo "$(date +%H:%M:%S) $sc $label $r" | tee -a $S/results.txt
}
rrounds() {
  local sc=$1 tag=$2 n=$3 rate=$4; shift 4
  local vs=("$@") k=${#@}
  for r in $(seq 1 $n); do
    for i in $(seq 0 $((k-1))); do
      local idx=$(( (i + r - 1) % k + 1 ))
      rexp $sc "$tag:${vs[$idx]}" "${vs[$idx]}" $rate "${EXTRA[@]}"
    done
  done
}
UP=nomkdir,directwrite,bufferbody,headdetect,nocopy
