#!/bin/bash
# ========================================
# 用法：
#   ./run_caliper.sh <组织个数> [链码名] [链码版本] [测试目标|YAML路径]
#
# 例子：
#   ./run_caliper.sh 4
#   ./run_caliper.sh 4 acmc 1.0 register
#   ./run_caliper.sh 4 acmc 1.0 addResource
#
# 说明：
#   - 自动调用 automation.sh 重启网络
#   - 启动 Docker 监控并输出 CSV
#   - 启动 Caliper 测试
# ========================================

# set -euo pipefail # 暂时注释掉，避免子脚本返回非0导致退出

# 1. 参数检查与解析
if [ $# -lt 1 ]; then
  echo "用法: $0 <组织个数> [链码名] [链码版本] [测试目标|YAML路径]"
  echo "示例: $0 4"
  echo "示例: $0 4 acmc 1.0 register"
  echo "示例: $0 4 acmc 1.0 addResource"
  exit 1
fi

ORG_NUM=$1
CC_NAME=${2:-acmc}
CC_VER=${3:-1.0}
TARGET_ARG=${4:-register}   # 默认为 register

WORKSPACE_ROOT="$(pwd)"
# 指向 automation.sh 所在的目录 (test-network/rbac_ipfs-client)
NETWORK_DIR="/root/go/src/github.com/hyperledger/fabric/scripts/fabric-samples/test-network/rbac_ipfs-client"
# 这里假设 automation.sh 在 rbac_ipfs-client 目录下，如果是在 test-network 下请修改路径
# NETWORK_DIR="/root/go/src/github.com/hyperledger/fabric/scripts/fabric-samples/test-network"

BENCH_DIR="${WORKSPACE_ROOT}/benchmarks"

# ---------- 小工具 ----------
lower() { echo "$1" | tr '[:upper:]' '[:lower:]'; }

# ---------- 解析测试目标，选 YAML ----------
TARGET_LOWER="$(lower "${TARGET_ARG}")"
BENCH_YAML_PATH=""
TARGET_BASENAME=""

if [[ -f "${TARGET_ARG}" ]]; then
  # 如果用户直接传入了 yaml 文件路径
  BENCH_YAML_PATH="${TARGET_ARG}"
  TARGET_BASENAME="$(basename "${BENCH_YAML_PATH}" .yaml)"
else
  case "${TARGET_LOWER}" in
    register|userregister)
      BENCH_YAML_PATH="${BENCH_DIR}/zkBenchmark_userRegister.yaml"
      TARGET_BASENAME="register"
      ;;
    addresource)
      BENCH_YAML_PATH="${BENCH_DIR}/zkBenchmark_addResource.yaml"
      TARGET_BASENAME="addResource"
      ;;
    addperm)
      BENCH_YAML_PATH="${BENCH_DIR}/zkBenchmark_addPerm.yaml"
      TARGET_BASENAME="addPerm"
      ;;
    querycid)
      BENCH_YAML_PATH="${BENCH_DIR}/zkBenchmark_queryCid.yaml"
      TARGET_BASENAME="queryCid"
      ;;
    tracecid)
      BENCH_YAML_PATH="${BENCH_DIR}/zkBenchmark_traceCid.yaml"
      TARGET_BASENAME="traceCid"
      ;;
    checkperm)
      BENCH_YAML_PATH="${BENCH_DIR}/zkBenchmark_checkPerm.yaml"
      TARGET_BASENAME="checkPerm"
      ;;
    systemmix)
      BENCH_YAML_PATH="${BENCH_DIR}/zkBenchmark_systemMix.yaml"
      TARGET_BASENAME="systemMix"
      ;;
    *)
      echo "❌ 未识别的测试目标：${TARGET_ARG}"
      echo "   可选目标: register, addResource (后续将支持: addPerm, queryCid, traceCid, checkPerm, systemmix)"
      exit 1
      ;;
  esac
fi

if [[ ! -f "${BENCH_YAML_PATH}" ]]; then
  echo "❌ 找不到基准配置文件：${BENCH_YAML_PATH}"
  exit 1
fi

TS="$(date +%Y%m%d_%H%M%S)"

# 输出目录/文件
SAMPLE_DIR="${WORKSPACE_ROOT}/output/resource"
mkdir -p "${SAMPLE_DIR}"
SAMPLE_FILE="${SAMPLE_DIR}/docker_stats_${TARGET_BASENAME}_${TS}.csv"
REPORT_PATH="${WORKSPACE_ROOT}/output/report_${TARGET_BASENAME}.html"

echo "🚀 启动 Caliper 测试"
echo "   - 组织数      : ${ORG_NUM}"
echo "   - 链码        : ${CC_NAME} ${CC_VER}"
echo "   - 测试目标    : ${TARGET_BASENAME}"
echo "   - 基准 YAML   : ${BENCH_YAML_PATH}"
echo "   - 采样 CSV    : ${SAMPLE_FILE}"
echo "---------------------------------------------"

# ---------- Docker / Caliper 监控相关函数 ----------

build_base_containers() {
  local arr=("orderer.example.com")
  for ((i=1; i<=ORG_NUM; i++)); do
    arr+=("peer0.org${i}.example.com")
  done
  printf "%s\n" "${arr[@]}"
}

refresh_running_set() {
  mapfile -t _RUNNING_NOW < <(docker ps --format '{{.Names}}')
  unset RUNNING_SET
  declare -gA RUNNING_SET
  for n in "${_RUNNING_NOW[@]}"; do RUNNING_SET["$n"]=1; done
}

is_running() {
  local name="$1"
  [[ -n "${RUNNING_SET[$name]:-}" ]]
}

discover_chaincode_containers() {
  docker ps --format '{{.Names}}' \
    | grep -E "^dev-peer[0-9]+\.org[0-9]+\.example\.com-${CC_NAME}_${CC_VER//./\\.}-" \
    || true
}

refresh_containers_if_needed() {
  refresh_running_set
  mapfile -t NEW_CCS < <(discover_chaincode_containers)
  local c
  for c in "${NEW_CCS[@]}"; do
    [[ -z "$c" ]] && continue
    if is_running "$c" && [[ -z "${seen[$c]:-}" ]]; then
      ALL_CONTAINERS+=("$c")
      seen[$c]=1
      echo "➕ 发现新链码容器：$c"
    fi
  done
}

sample_once() {
  refresh_containers_if_needed
  local ts
  ts="$(date +%Y-%m-%dT%H:%M:%S)"
  local container
  for container in "${ALL_CONTAINERS[@]}"; do
    is_running "$container" || continue
    docker stats --no-stream --format "{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.MemPerc}},{{.NetIO}},{{.BlockIO}},{{.PIDs}}" "$container" 2>/dev/null \
      | awk -v ts="$ts" -F',' '
        {
          split($3, m, " / ");
          split($5, n, " / ");
          split($6, b, " / ");
          printf "%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n",
                 ts,$1,$2,m[1],m[2],$4,n[1],n[2],b[1],b[2],$7
        }'
  done >> "${SAMPLE_FILE}"
}

start_sampler() {
  echo "ts,container,cpu_perc,mem_usage,mem_limit,mem_perc,net_in,net_out,block_in,block_out,pids" > "${SAMPLE_FILE}"
  (
    while true; do
      sample_once
      sleep 2
    done
  ) &
  SAMPLER_PID=$!
  echo "🟢 Docker 采样器已启动，PID=${SAMPLER_PID}"
}

stop_sampler() {
  if [[ -n "${SAMPLER_PID:-}" ]]; then
    kill "${SAMPLER_PID}" 2>/dev/null || true
    wait "${SAMPLER_PID}" 2>/dev/null || true
    echo "🛑 已停止 Docker 采样器。"
  fi
}

trap 'stop_sampler' EXIT

# ========== Step 1: 启动/重建网络 ==========
if [ -d "${NETWORK_DIR}" ]; then
    cd "${NETWORK_DIR}" || exit 1
    echo "🔄 正在重置网络 (调用 automation.sh)..."
    
    # 使用 || true 确保即使子脚本有非关键报错也不中断流程
    ./automation.sh "${ORG_NUM}" down || true
    ./automation.sh "${ORG_NUM}" up || echo "⚠️ automation.sh 返回了非0状态，继续执行..."
else
    echo "❌ 找不到脚本目录：${NETWORK_DIR}"
    exit 1
fi

echo "⏳ 等待容器完全就绪 (5s)..."
sleep 5

# ========== Step 2: 监控容器集合 ==========
refresh_running_set

mapfile -t BASES_ALL < <(build_base_containers)
BASES=()
for c in "${BASES_ALL[@]}"; do
  if is_running "$c"; then
    BASES+=("$c")
  else
    echo "⚠️ 跳过不存在的容器：$c (可能组织数设置与实际不符)"
  fi
done

mapfile -t CHAINCODES < <(discover_chaincode_containers)

declare -A seen
ALL_CONTAINERS=()
for c in "${BASES[@]}" "${CHAINCODES[@]}"; do
  [[ -z "$c" ]] && continue
  if [[ -z "${seen[$c]:-}" ]]; then
    ALL_CONTAINERS+=("$c")
    seen[$c]=1
  fi
done

echo "🔎 将监控以下容器："
for c in "${ALL_CONTAINERS[@]}"; do
  echo "   - $c"
done

# 回到 Caliper 工作目录
cd "${WORKSPACE_ROOT}"

# ========== Step 3: 启动采样器 ==========
start_sampler

# ========== Step 4: 启动 Caliper ==========
echo "⚙️ 启动 Caliper Manager ..."
echo "---------------------------------------------"

npx caliper launch manager \
  --caliper-workspace ./ \
  --caliper-networkconfig networks/networkConfig.yaml \
  --caliper-benchconfig "${BENCH_YAML_PATH}" \
  --caliper-report-path "${REPORT_PATH}" \
  --caliper-flow-only-test \
  --caliper-fabric-gateway-enabled \
  --caliper-verbose

echo "✅ Caliper 测试完成。"
echo "📄 采样 CSV ：${SAMPLE_FILE}"
echo "📄 报告文件：${REPORT_PATH}"
echo "🎯 完成。"