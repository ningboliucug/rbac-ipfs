#!/bin/bash
# usage: ./run_automation.sh <org_count> <mode> 
# 例如:
#   ./run_automation.sh 10 up 
#   ./run_automation.sh 10 down
#

if [ "$#" -lt 2 ]; then
    echo "Usage: $0 <org_count> [up|down]"
    exit 1
fi

ORG_COUNT=$1
MODE=$2  # up 或 down

# 回到 test-network 目录
cd /root/go/src/github.com/hyperledger/fabric/scripts/fabric-samples/test-network || exit 1

# ------------------------------------------------------------------------------
# 1. 处理 up / down 操作
# ------------------------------------------------------------------------------
if [ "$MODE" = "up" ]; then
    echo "操作模式: $MODE"
    echo "设置组织个数为: $ORG_COUNT"

    # --------------------------------------------------------------------------
    # 1.1 启动 Fabric 网络
    # --------------------------------------------------------------------------
    echo "设置环境变量..."
    source /root/.bashrc
    export PATH=${PWD}/../bin:$PATH
    export FABRIC_CFG_PATH=$PWD/../config/

    echo "启动网络并创建通道..."
    if ! ./network.sh up createChannel; then
        echo "Error: network.sh up createChannel 失败" >&2
        exit 1
    fi

    # --------------------------------------------------------------------------
    # 1.2 针对每个组织 i=4..$ORG_COUNT
    #     先复制并修改组织脚本 -> 然后再编译 tokenVerify -> 拷贝 peercfg -> 再启动组织
    # --------------------------------------------------------------------------
    for ((i=4; i<=$ORG_COUNT; i++)); do
        echo "=== 处理 组织$i 的文件 ==="
        # 复制 addOrg3 -> addOrg$i
        cp -a addOrg3 "addOrg$i"
        # 复制 scripts/org3-scripts -> scripts/org$i-scripts
        cp -a scripts/org3-scripts "scripts/org$i-scripts"

        # 执行 replace_orgX.sh 替换相关端口和组织编号
        ./replace_orgX.sh -n $i -d "addOrg$i" -p $((20000 + i))
        ./replace_orgX.sh -n $i -d "scripts/org$i-scripts" -p $((20000 + i))

        # modify_files.sh 用于修改 docker-compose 等配置
        ./modify_files.sh -m set -n $i -p $((20000 + i))

        # 同时将 org1.example.com 文件夹拷贝到 addOrg$i/compose/docker/peercfg/ 目录
        echo "拷贝 organizations/peerOrganizations/org1.example.com 到 addOrg$i/compose/docker/peercfg/"
        cp -a "/root/go/src/github.com/hyperledger/fabric/scripts/fabric-samples/test-network/organizations/peerOrganizations/org1.example.com" \
              "/root/go/src/github.com/hyperledger/fabric/scripts/fabric-samples/test-network/addOrg$i/compose/docker/peercfg/"

        # ----------------------------------------------------------------------
        # (2) 启动组织
        # ----------------------------------------------------------------------
        echo "启动组织$i..."
        cd "/root/go/src/github.com/hyperledger/fabric/scripts/fabric-samples/test-network/addOrg$i" || exit 1
        ./addOrg$i.sh up
        cd - > /dev/null
        ./replace_orgX.sh -n $i -d "organizations/peerOrganizations/org$i.example.com" -p $((20000 + i))
        sleep 1
    done

    # --------------------------------------------------------------------------
    # 1.3 部署链码
    # --------------------------------------------------------------------------
    echo "部署链码 acmc 到通道 mychannel..."
    if ! ./network.sh deployCC -c mychannel -ccn acmc -ccp ./rbac_ipfs-chaincode -ccl go; then
        echo "Error: network.sh deployCC 失败" >&2
        exit 1
    fi

    # --------------------------------------------------------------------------
    # 1.4 执行自动化测试流程（包括注册用户、addResource、getToken、updatePolicy）
    # --------------------------------------------------------------------------
    # 1) 注册用户
    echo "执行用户注册..."
    cd ./rbac_ipfs-client/register || exit 1
    ./register
    cd - > /dev/null

    # 2) addResource
    echo "执行 addResource..."
    cd ./rbac_ipfs-client/addResource || exit 1
    ./addResource
    cd - > /dev/null

    # 2.1) addResource for caliper 
    echo "2.1 执行 addResource_1..."
    cd ./rbac_ipfs-client/addResource || exit 1
    ./addResource_1
    cd - > /dev/null

    # 2.2) addResource for caliper 
    echo "2.2 执行 addResource_2..."
    cd ./rbac_ipfs-client/addResource || exit 1
    ./addResource_2
    cd - > /dev/null

    # 3) addPerm
    echo "执行 addPerm..."
    cd ./rbac_ipfs-client/addPerm || exit 1
    ./addPerm
    cd - > /dev/null

    # 4) checkPerm
    echo "执行 checkPerm..."
    cd ./rbac_ipfs-client/checkPerm || exit 1
    ./checkPerm 
    cd - > /dev/null

    # 5) queryCid
    echo "执行 queryCid..."
    cd ./rbac_ipfs-client/queryCid || exit 1
    ./queryCid 
    cd - > /dev/null

    # 6) traceCid
    echo "执行 traceCid..."
    cd ./rbac_ipfs-client/traceCid || exit 1
    ./traceCid 
    cd - > /dev/null
    # 查看 chaincode 容器日志 (可选)
    CONTAINER_ID=$(docker ps -a | grep "dev-peer0.org1.example.com-acmc_1.0" | awk '{print $1}')
    
    docker logs "$CONTAINER_ID" | grep -v "DBG"

    #echo "自动化测试完成。"

    #echo "开始性能测试..."
    #cd /root/go/src/github.com/hyperledger/fabric/scripts/fabric-samples/test-network/rbac_ipfs-client/performance-test || exit 1
    #./autoTest.sh $ATTR_COUNT
    #cd - /dev/null

elif [ "$MODE" = "down" ]; then
    echo "操作模式: $MODE"
    # ----------------------------------------------------------------------------
    # 删除操作
    # ----------------------------------------------------------------------------
    echo "删除操作开始..."

    # 关闭网络
    echo "关闭网络..."
    ./network.sh down >/dev/null 2>&1

    # 删除相关组织的 Docker 卷
    for ((i=4; i<=$ORG_COUNT; i++)); do
        echo "删除组织$i的 Docker 卷..."
        docker volume rm "compose_peer0.org$i.example.com"
        ./modify_files.sh -m delete -n $i -p $((20000 + i))
    done

    # 清理容器、镜像和卷
    docker rm -f $(docker ps -a -q) 2>/dev/null
    docker volume prune -f
    for i in $(docker images | grep acmc-1.0 | awk '{print $3}'); do
        docker rmi -f "$i"
    done

    volume_names=$(docker volume ls | awk 'NR>1{print $2}')
    if [[ -n "$volume_names" ]]; then
        echo "Deleting the following Docker volumes:"
        echo "$volume_names"
        while read -r volume_name; do
            docker volume rm "$volume_name"
        done <<< "$volume_names"
    else
        echo "No Docker volumes found to delete."
    fi
    systemctl restart docker
    echo "删除操作完成。"

else
    # 如果没传递 up/down 或其它合法值，则提示
    echo "无效的操作模式: $MODE"
    echo "可选: up 或 down"
    exit 1
fi
