'use strict';

const { WorkloadModuleBase } = require('@hyperledger/caliper-core');

// 硬编码 CID (必须是功能测试中已添加的资源)
const FIXED_CID = "QmdyzCHpa2vnn3zBvH1hfy4e5zdEuQGUvVfgtFfBnGFhKM";

class QueryCidWorkload extends WorkloadModuleBase {
    constructor() {
        super();
        this.txArgs = [];
    }

    async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex,
                                   roundArguments, sutAdapter, sutContext) {
        await super.initializeWorkloadModule(workerIndex, totalWorkers, roundIndex,
                                             roundArguments, sutAdapter, sutContext);

        this.contractId = roundArguments.contractId || 'acmc';
        this.functionName = 'QueryCid';
        
        // 准备固定参数: [cid]
        this.txArgs = [FIXED_CID];
        
        // 初始化负载均衡
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
        const req = {
            contractId: this.contractId,
            contractFunction: this.functionName,
            contractArguments: this.txArgs, // [cid]
            invokerIdentity: this._pickInvoker(),
            readOnly: true,  // <--- 关键：只读查询 (EvaluateTransaction)
            timeout: 60
        };

        await this.sutAdapter.sendRequests(req);
    }
}

function createWorkloadModule() {
    return new QueryCidWorkload();
}

module.exports.createWorkloadModule = createWorkloadModule;
