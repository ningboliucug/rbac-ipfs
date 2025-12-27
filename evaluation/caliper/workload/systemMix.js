'use strict';

const { WorkloadModuleBase } = require('@hyperledger/caliper-core');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 硬编码文件路径（指向 run_automation.sh 生成的文件）
const REGISTER_DIR = '/root/go/src/github.com/hyperledger/fabric/scripts/fabric-samples/test-network/rbac_ipfs-client/register';
const ID1_FILE = path.join(REGISTER_DIR, 'user_1_id.txt');
const KEY1_FILE = path.join(REGISTER_DIR, 'user_1_private_key.pem');
const ID2_FILE = path.join(REGISTER_DIR, 'user_2_id.txt');
const KEY2_FILE = path.join(REGISTER_DIR, 'user_2_private_key.pem');

// 固定资源 CID (用于 AddPerm, CheckPerm, QueryCid 等)
const FIXED_CID = "QmdyzCHpa2vnn3zBvH1hfy4e5zdEuQGUvVfgtFfBnGFhKM";
const FIXED_CID_1 = "QmdyzCHpa2vnn3zBvH1hfy4e5zdEuQGUvVfgtFfBnGFhKM_1";
const FIXED_CID_2 = "QmdyzCHpa2vnn3zBvH1hfy4e5zdEuQGUvVfgtFfBnGFhKM_2";

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function safeLabel(s) { return String(s || '').replace(/[^\w.\-]+/g, '_'); }

function getWeight(args, key, def) {
    if (Object.prototype.hasOwnProperty.call(args, key)) {
        const v = Number(args[key]);
        return Number.isFinite(v) ? v : def;
    }
    return def;
}

function isTxSuccessful(ret) {
    const arr = Array.isArray(ret) ? ret : [ret];
    let sawSuccess = false;
    let sawFailure = false;
    const successStatus = new Set(['success', 'valid', 'ok']);
    for (const x of arr) {
        if (!x) { sawFailure = true; continue; }
        try {
            if (x.status && successStatus.has(String(x.status).toLowerCase())) sawSuccess = true;
            else if (x.code === 0 || String(x.code).toUpperCase() === 'OK') sawSuccess = true;
            else sawFailure = true;
        } catch (e) { sawFailure = true; }
    }
    return !sawFailure && sawSuccess;
}

class SystemMixWorkload extends WorkloadModuleBase {
    constructor() {
        super();
        this.txIndex = 0;
        this.workerIndex = 0;
        this.label = 'sysmix';
        this.outStream = null;

        // 支持的操作列表
        this.ops = ['addResource', 'addPerm', 'checkPerm', 'traceCid', 'queryCid'];
        this.weights = [];
        this.cum = [];
        
        // 缓存的用户凭证
        this.u1 = { id: '', key: '', signAddRes: '', signAddPerm: '' };
        this.u2 = { id: '', key: '', signCheckPerm: '' };
        
        // Register 用的 baseKey
        this.regBaseKey = '';
    }

    async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex,
                                   roundArguments, sutAdapter, sutContext) {
        await super.initializeWorkloadModule(workerIndex, totalWorkers, roundIndex,
                                             roundArguments, sutAdapter, sutContext);

        this.workerIndex = workerIndex;
        this.contractId = roundArguments.contractId || 'acmc';

        // 1. 读取权重
        //const wReg      = getWeight(roundArguments, 'wRegister',    0.1);
        const wAddRes   = getWeight(roundArguments, 'wAddResource', 0.2);
        const wAddPerm  = getWeight(roundArguments, 'wAddPerm',     0.2);
        const wCheck    = getWeight(roundArguments, 'wCheckPerm',   0.4);
        const wTrace    = getWeight(roundArguments, 'wTraceCid',    0.1);
        const wQuery    = getWeight(roundArguments, 'wQueryCid',    0.1);

        this.weights = [wAddRes, wAddPerm, wCheck, wTrace, wQuery];
        const sumW = this.weights.reduce((a, b) => a + b, 0);
        if (sumW <= 0) throw new Error('[SystemMix] Invalid weights: sum <= 0');

        let acc = 0;
        this.cum = this.weights.map(w => { acc += w / sumW; return acc; });
        this.cum[this.cum.length - 1] = 1.0;

        // 2. 初始化 Register 用的密钥模板
        const { publicKey } = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' }
        });
        this.regBaseKey = publicKey;

        // 3. 加载 User1 (资源属主)
        if (fs.existsSync(ID1_FILE) && fs.existsSync(KEY1_FILE)) {
            this.u1.id = fs.readFileSync(ID1_FILE, 'utf8').trim();
            this.u1.key = fs.readFileSync(KEY1_FILE, 'utf8');
            
            // 预计算 AddResource 签名 (User1 对 uid 签名)
            const s1 = crypto.createSign('SHA256');
            s1.update(this.u1.id);
            this.u1.signAddRes = s1.sign(this.u1.key, 'base64');
            
            // 预计算 AddPerm 签名 (User1 对 uid+cid 签名)
            const s2 = crypto.createSign('SHA256');
            s2.update(this.u1.id + FIXED_CID_1);
            this.u1.signAddPerm = s2.sign(this.u1.key, 'base64');
        } else {
            throw new Error('[SystemMix] User1 files missing');
        }

        // 4. 加载 User2 (访问者)
        if (fs.existsSync(ID2_FILE) && fs.existsSync(KEY2_FILE)) {
            this.u2.id = fs.readFileSync(ID2_FILE, 'utf8').trim();
            this.u2.key = fs.readFileSync(KEY2_FILE, 'utf8');
            
            // 预计算 CheckPerm 签名 (User2 对 uid+cid 签名)
            const s3 = crypto.createSign('SHA256');
            s3.update(this.u2.id + FIXED_CID);
            this.u2.signCheckPerm = s3.sign(this.u2.key, 'base64');
        } else {
            throw new Error('[SystemMix] User2 files missing');
        }

        // 5. 负载均衡策略
        this._initInvokerStrategy(roundArguments);

        // 6. CSV 输出
        this.label = String(roundArguments.label || `sysmix_${roundIndex}`);
        const outDir = '/root/go/src/github.com/hyperledger/fabric/scripts/caliper-zkguard/output/latency_systemmix';
        ensureDir(outDir);
        const file = path.join(outDir, `${safeLabel(this.label)}__w${workerIndex}.csv`);
        const needHeader = !fs.existsSync(file);
        this.outStream = fs.createWriteStream(file, { flags: 'a' });
        if (needHeader) this.outStream.write('label,op,ok,start_ms,end_ms\n');
    }

    async cleanupWorkloadModule() {
        if (this.outStream) {
            await new Promise(res => this.outStream.end(res));
            this.outStream = null;
        }
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

    _pickOp() {
        const r = Math.random();
        for (let i = 0; i < this.cum.length; i++) {
            if (r <= this.cum[i]) return this.ops[i];
        }
        return this.ops[this.ops.length - 1];
    }

    // --- 构造各操作参数 ---

    /*_mkRegister() {
        // 模拟新用户注册
        const suffix = `\n# mix_w${this.workerIndex}_tx${this.txIndex}_${Math.random()}`;
        const uniquePem = this.regBaseKey + suffix;
        const userID = crypto.createHash('sha256').update(uniquePem).digest('hex');
        // 随机角色
        const role = ['Creator', 'Contributor', 'Public'][this.txIndex % 3];
        
        return {
            fn: 'Register',
            args: [userID, uniquePem, role],
            readOnly: false
        };
    }*/

    _mkAddResource() {
        // User1 添加新资源 (随机 CID)
        const uniqueCid = `QmMix_${this.workerIndex}_${this.txIndex}_${Math.random().toString(36).slice(2)}`;
        // 使用 User1 的静态签名 (只签了 uid)
        return {
            fn: 'AddResource',
            args: [this.u1.signAddRes, this.u1.id, uniqueCid],
            readOnly: false
        };
    }

    _mkAddPerm() {
        // User1 对 FIXED_CID 授权
        const operation = "download";
        const rolesJSON = JSON.stringify(["Public"]);
        // 使用 User1 的静态签名 (签了 uid+FIXED_CID)
        return {
            fn: 'AddPerm',
            args: [this.u1.signAddPerm, this.u1.id, FIXED_CID_1, operation, rolesJSON],
            readOnly: false
        };
    }

    _mkCheckPerm() {
        // User2 检查对 FIXED_CID 的权限
        const operation = "download";
        // 使用 User2 的静态签名 (签了 uid+FIXED_CID)
        return {
            fn: 'CheckPerm',
            args: [this.u2.signCheckPerm, operation, this.u2.id, FIXED_CID],
            readOnly: false
        };
    }

    _mkTraceCid() {
        // 查询 FIXED_CID 的日志
        return {
            fn: 'TraceCid',
            args: [FIXED_CID_2],
            readOnly: true // Evaluate
        };
    }

    _mkQueryCid() {
        // 查询 FIXED_CID 的属主
        return {
            fn: 'QueryCid',
            args: [FIXED_CID_2],
            readOnly: true // Evaluate
        };
    }

    async submitTransaction() {
        this.txIndex++;
        const op = this._pickOp();
        let reqCfg;

        switch (op) {
            //case 'register':    reqCfg = this._mkRegister(); break;
            case 'addResource': reqCfg = this._mkAddResource(); break;
            case 'addPerm':     reqCfg = this._mkAddPerm(); break;
            case 'checkPerm':   reqCfg = this._mkCheckPerm(); break;
            case 'traceCid':    reqCfg = this._mkTraceCid(); break;
            case 'queryCid':    reqCfg = this._mkQueryCid(); break;
        }

        const t0 = Number(process.hrtime.bigint()) / 1e6;
        let ok = 0;
        try {
            const ret = await this.sutAdapter.sendRequests({
                contractId: this.contractId,
                contractFunction: reqCfg.fn,
                contractArguments: reqCfg.args,
                invokerIdentity: this._pickInvoker(),
                readOnly: reqCfg.readOnly,
                timeout: 60
            });
            ok = isTxSuccessful(ret) ? 1 : 0;
        } catch (e) {
            ok = 0;
        }
        const t1 = Number(process.hrtime.bigint()) / 1e6;

        if (this.outStream) {
            this.outStream.write(
                `${this.label},${op},${ok},${t0.toFixed(3)},${t1.toFixed(3)}\n`
            );
        }
    }
}

function createWorkloadModule() {
    return new SystemMixWorkload();
}

module.exports.createWorkloadModule = createWorkloadModule;