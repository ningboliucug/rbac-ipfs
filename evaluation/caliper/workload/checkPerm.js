'use strict';

const { WorkloadModuleBase } = require('@hyperledger/caliper-core');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 硬编码文件路径（指向 User2 的文件）
const REGISTER_DIR = '/root/go/src/github.com/hyperledger/fabric/scripts/fabric-samples/test-network/rbac_ipfs-client/register';
const ID_FILE = path.join(REGISTER_DIR, 'user_2_id.txt');          // <--- User2
const KEY_FILE = path.join(REGISTER_DIR, 'user_2_private_key.pem'); // <--- User2

// 硬编码 CID
const FIXED_CID = "QmdyzCHpa2vnn3zBvH1hfy4e5zdEuQGUvVfgtFfBnGFhKM";

class CheckPermWorkload extends WorkloadModuleBase {
    constructor() {
        super();
        this.txArgs = []; // 预存的交易参数
    }

    async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex,
                                   roundArguments, sutAdapter, sutContext) {
        await super.initializeWorkloadModule(workerIndex, totalWorkers, roundIndex,
                                             roundArguments, sutAdapter, sutContext);

        // 1. 读取 User2 ID (Hash)
        if (!fs.existsSync(ID_FILE)) {
            throw new Error(`找不到 UserID 文件: ${ID_FILE}，请先运行功能测试生成用户。`);
        }
        const uidStr = fs.readFileSync(ID_FILE, 'utf8').trim();

        // 2. 读取 User2 私钥
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
        // 合约顺序: CheckPerm(signature, operation, userID, cid)
        const operation = "download";

        this.contractId = roundArguments.contractId || 'acmc';
        this.functionName = 'CheckPerm';
        
        // 保存这一套固定的参数，供后续 submitTransaction 无限复用
        this.txArgs = [signatureB64, operation, uidStr, FIXED_CID];
        
        // 负载均衡策略
        this._initInvokerStrategy(roundArguments);
    }

    _initInvokerStrategy(args) {
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
        const idx = Math.floor(Math.random() * this.orgInvokers.length);
        return this.orgInvokers[idx];
    }

    async submitTransaction() {
        // 直接使用预生成的固定参数
        const req = {
            contractId: this.contractId,
            contractFunction: this.functionName,
            contractArguments: this.txArgs, // <--- 复用 User2 的参数
            invokerIdentity: this._pickInvoker(),
            readOnly: false, // 合约内有 logGen(PutState)，所以不是只读
            timeout: 60
        };

        await this.sutAdapter.sendRequests(req);
    }
}

function createWorkloadModule() {
    return new CheckPermWorkload();
}

module.exports.createWorkloadModule = createWorkloadModule;
