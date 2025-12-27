'use strict';

const { WorkloadModuleBase } = require('@hyperledger/caliper-core');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 硬编码文件路径（指向 run_automation.sh 生成的文件）
const REGISTER_DIR = '/root/go/src/github.com/hyperledger/fabric/scripts/fabric-samples/test-network/rbac_ipfs-client/register';
const ID_FILE = path.join(REGISTER_DIR, 'user_1_id.txt');
const KEY_FILE = path.join(REGISTER_DIR, 'user_1_private_key.pem');

class AddResourceWorkload extends WorkloadModuleBase {
    constructor() {
        super();
        this.txIndex = 0;
        this.staticSignature = ''; // 预计算的签名
        this.uidStr = '';          // 固定的 UserID
    }

    async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex,
                                   roundArguments, sutAdapter, sutContext) {
        await super.initializeWorkloadModule(workerIndex, totalWorkers, roundIndex,
                                             roundArguments, sutAdapter, sutContext);

        this.workerIndex = workerIndex;
        this.contractId = roundArguments.contractId || 'acmc';
        this.functionName = 'AddResource';

        // 1. 读取 UserID (Hash)
        if (!fs.existsSync(ID_FILE)) {
            throw new Error(`找不到 UserID 文件: ${ID_FILE}，请先运行功能测试生成用户。`);
        }
        this.uidStr = fs.readFileSync(ID_FILE, 'utf8').trim();

        // 2. 读取私钥
        if (!fs.existsSync(KEY_FILE)) {
            throw new Error(`找不到私钥文件: ${KEY_FILE}`);
        }
        const privateKeyPem = fs.readFileSync(KEY_FILE, 'utf8');

        // 3. 预计算签名 (只对 UserID 签名，不包含 CID)
        // 对应修改后的逻辑: dataToSign := uidStr
        const dataToSign = this.uidStr; 
        
        const sign = crypto.createSign('SHA256');
        sign.update(dataToSign);
        this.staticSignature = sign.sign(privateKeyPem, 'base64');

        // 4. 初始化负载均衡策略
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
        this.txIndex++;
        
        // 1. 生成唯一的 CID
        // 虽然签名固定了，但 AddResource 依然要求 CID 唯一，否则会报 "already exists"
        const uniqueCid = `QmRes_${this.workerIndex}_${this.txIndex}_${Math.random().toString(36).slice(2, 10)}`;

        // 2. 组装参数: [静态签名, 固定用户, 动态CID]
        const args = [this.staticSignature, this.uidStr, uniqueCid];

        const req = {
            contractId: this.contractId,
            contractFunction: this.functionName,
            contractArguments: args,
            invokerIdentity: this._pickInvoker(),
            readOnly: false,
            timeout: 60
        };

        await this.sutAdapter.sendRequests(req);
    }
}

function createWorkloadModule() {
    return new AddResourceWorkload();
}

module.exports.createWorkloadModule = createWorkloadModule;