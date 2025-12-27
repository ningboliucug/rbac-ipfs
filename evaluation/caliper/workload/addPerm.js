'use strict';

const { WorkloadModuleBase } = require('@hyperledger/caliper-core');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 硬编码文件路径（根据你的环境路径）
const REGISTER_DIR = '/root/go/src/github.com/hyperledger/fabric/scripts/fabric-samples/test-network/rbac_ipfs-client/register';
const ID_FILE = path.join(REGISTER_DIR, 'user_1_id.txt');
const KEY_FILE = path.join(REGISTER_DIR, 'user_1_private_key.pem');

// 硬编码 CID
const FIXED_CID = "QmdyzCHpa2vnn3zBvH1hfy4e5zdEuQGUvVfgtFfBnGFhKM";


class AddPermWorkload extends WorkloadModuleBase {
    constructor() {
        super();
        this.txArgs = []; // 预存的交易参数
    }

    async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex,
                                   roundArguments, sutAdapter, sutContext) {
        await super.initializeWorkloadModule(workerIndex, totalWorkers, roundIndex,
                                             roundArguments, sutAdapter, sutContext);

        // 1. 读取 UserID (Hash)
        if (!fs.existsSync(ID_FILE)) {
            throw new Error(`找不到 UserID 文件: ${ID_FILE}，请先运行功能测试生成用户。`);
        }
        const uidStr = fs.readFileSync(ID_FILE, 'utf8').trim();

        // 2. 读取私钥
        if (!fs.existsSync(KEY_FILE)) {
            throw new Error(`找不到私钥文件: ${KEY_FILE}`);
        }
        const privateKeyPem = fs.readFileSync(KEY_FILE, 'utf8');

        // 3. 准备签名数据
        // Go代码逻辑: dataToSign := uidStr + cid
        const dataToSign = uidStr + FIXED_CID;
        
        // 4. 计算签名 (只计算一次)
        const sign = crypto.createSign('SHA256');
        sign.update(dataToSign);
        const signatureB64 = sign.sign(privateKeyPem, 'base64');

        // 5. 准备固定参数
        // AddPerm(signature, uid, cid, operation, rolesJSON)
        const operation = "download";
        const rolesJSON = JSON.stringify(["Creator", "Contributor"]);

        this.contractId = roundArguments.contractId || 'acmc';
        this.functionName = 'AddPerm';
        
        // 保存这一套固定的参数，供后续 submitTransaction 无限复用
        this.txArgs = [signatureB64, uidStr, FIXED_CID, operation, rolesJSON];
        
        // 多组织负载均衡逻辑保持不变，用于模拟从不同节点发出的请求
        this._initInvokerStrategy(roundArguments);
    }

    _initInvokerStrategy(args) {
        // 简化的负载均衡初始化
        this.invoker = args.invoker || 'User1';
        this.orgInvokers = [];
        const count = args.invokerOrgCount || 0;
        if (count > 0) {
            for (let i = 1; i <= count; i++) {
                if (args[`invokerOrg${i}`]) this.orgInvokers.push(String(args[`invokerOrg${i}`]));
            }
        }
        if (this.orgInvokers.length === 0) this.orgInvokers = [this.invoker];
    }

    _pickInvoker() {
        // 简单随机选择一个发起者
        const idx = Math.floor(Math.random() * this.orgInvokers.length);
        return this.orgInvokers[idx];
    }

    async submitTransaction() {
        // 直接使用预生成的固定参数
        const req = {
            contractId: this.contractId,
            contractFunction: this.functionName,
            contractArguments: this.txArgs, // <--- 这里直接用缓存
            invokerIdentity: this._pickInvoker(),
            readOnly: false,
            timeout: 60
        };

        await this.sutAdapter.sendRequests(req);
    }
}

function createWorkloadModule() {
    return new AddPermWorkload();
}

module.exports.createWorkloadModule = createWorkloadModule;
