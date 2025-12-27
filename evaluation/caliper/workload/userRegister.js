'use strict';

const { WorkloadModuleBase } = require('@hyperledger/caliper-core');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function safeLabel(s) { return String(s || '').replace(/[^\w.\-]+/g, '_'); }

/**
 * 读取权重（用于多组织/多peer负载均衡）
 */
function getWeight(args, key, def) {
    if (Object.prototype.hasOwnProperty.call(args, key)) {
        const v = Number(args[key]);
        return Number.isFinite(v) ? v : def;
    }
    return def;
}

/**
 * 严格判断交易是否成功
 */
function isTxSuccessful(ret) {
    const arr = Array.isArray(ret) ? ret : [ret];
    let sawSuccess = false;
    let sawFailure = false;
    const successStatus = new Set(['success', 'valid', 'ok']);

    for (const x of arr) {
        if (!x) { sawFailure = true; continue; }
        try {
            if (typeof x.GetStatus === 'function') {
                const st = x.GetStatus();
                const s = String(st).toLowerCase();
                if (st === true || successStatus.has(s)) sawSuccess = true;
                else sawFailure = true;
                continue;
            }
            if (x.status) {
                const s = String(x.status).toLowerCase();
                if (successStatus.has(s)) sawSuccess = true;
                else if (s) sawFailure = true;
                continue;
            }
            if (x.code === 0 || String(x.code).toUpperCase() === 'OK') { sawSuccess = true; continue; }
            if (x.error || x.err) { sawFailure = true; continue; }
        } catch (e) { sawFailure = true; }
    }
    if (sawFailure) return false;
    if (sawSuccess) return true;
    return false;
}

class UserRegisterWorkload extends WorkloadModuleBase {
    constructor() {
        super();
        this.txIndex = 0;
        this.label = 'round';
        this.outStream = null;
        this.orgInvokers = [];
        this.orgCum = [];
        
        // 预定义角色集合
        this.roles = ['Creator', 'Contributor', 'Public'];
        
        // 缓存一个合法的公钥模板，避免每次循环都生成 RSA 密钥对导致 CPU 瓶颈
        this.basePublicKey = ''; 
    }

    async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex,
                                   roundArguments, sutAdapter, sutContext) {
        await super.initializeWorkloadModule(workerIndex, totalWorkers, roundIndex,
                                             roundArguments, sutAdapter, sutContext);

        this.workerIndex = workerIndex;

        // --- 核心参数 ---
        this.contractId = roundArguments.contractId || 'acmc';
        this.fn         = roundArguments.function   || 'Register'; // 注意大小写
        this.invoker    = roundArguments.invoker    || 'User1';

        // --- 生成一个合法的 RSA 公钥作为模板 ---
        // 只需要生成一次，后续通过加盐(Salt)来模拟不同的公钥字符串
        const { publicKey } = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' }
        });
        this.basePublicKey = publicKey;

        // --- 多组织负载均衡逻辑 (保持不变) ---
        this.orgInvokers = [];
        this.orgCum = [];
        const orgWeights = [];
        const countKey = (roundArguments.invokerOrgCount !== undefined) ? 'invokerOrgCount' : 'orgInvokerCount';
        let orgCount = 0;
        if (countKey) {
            const v = Number(roundArguments[countKey]);
            if (v > 0) orgCount = v;
        }

        if (orgCount > 0) {
            for (let i = 1; i <= orgCount; i++) {
                const id = roundArguments[`invokerOrg${i}`];
                const w = getWeight(roundArguments, `wOrg${i}`, 1);
                if (id && w > 0) {
                    this.orgInvokers.push(String(id));
                    orgWeights.push(w);
                }
            }
        }

        if (this.orgInvokers.length === 0) {
            // fallback logic
            this.orgInvokers = [this.invoker];
            this.orgCum = [1.0];
        } else if (this.orgInvokers.length === 1) {
            this.orgCum = [1.0];
        } else {
            const sumOrg = orgWeights.reduce((a, b) => a + b, 0);
            let acc = 0;
            this.orgCum = orgWeights.map(w => { acc += w / sumOrg; return acc; });
            this.orgCum[this.orgCum.length - 1] = 1.0;
        }

        // --- CSV 输出逻辑 ---
        this.label = String(roundArguments.label || `round_${roundIndex}`);
        const outDir = '/root/go/src/github.com/hyperledger/fabric/scripts/caliper-zkguard/output/latency_register';
        ensureDir(outDir);
        const file = path.join(outDir, `${safeLabel(this.label)}__w${workerIndex}.csv`);
        const needHeader = !fs.existsSync(file);
        this.outStream = fs.createWriteStream(file, { flags: 'a' });
        if (needHeader) {
            this.outStream.write('label,op,ok,start_ms,end_ms\n');
        }
    }

    async cleanupWorkloadModule() {
        if (this.outStream) {
            await new Promise(res => this.outStream.end(res));
            this.outStream = null;
        }
    }

    _pickInvoker() {
        if (!this.orgInvokers || this.orgInvokers.length === 0) return this.invoker;
        if (this.orgInvokers.length === 1) return this.orgInvokers[0];
        const r = Math.random();
        for (let i = 0; i < this.orgCum.length; i++) {
            if (r <= this.orgCum[i]) return this.orgInvokers[i];
        }
        return this.orgInvokers[this.orgInvokers.length - 1];
    }

    /**
     * 生成模拟的用户凭证
     * 策略：使用合法的 basePublicKey，但在其 PEM 尾部追加唯一标识（注释）。
     * Go 合约中的 pem.Decode 会忽略 END PUBLIC KEY 之后的内容，所以 key 依然合法。
     * 但 sha256 会计算整个字符串，所以 UserID 是唯一的。
     */
    _generateUserCredentials(index) {
        // 在 PEM 结尾追加唯一标识
        const uniqueSuffix = `\n# worker${this.workerIndex}_tx${index}_${Math.random()}`;
        const uniquePem = this.basePublicKey + uniqueSuffix;

        // 计算 UserID (SHA256 Hex)
        const userID = crypto.createHash('sha256').update(uniquePem).digest('hex');

        // 轮询分配角色
        const role = this.roles[index % this.roles.length];

        return { userID, publicKey: uniquePem, role };
    }

    async submitTransaction() {
        this.txIndex++;
        
        // 1. 准备新合约需要的参数：UserID(Hash), PEM, Role
        const creds = this._generateUserCredentials(this.txIndex);

        const req = {
            contractId: this.contractId,
            contractFunction: this.fn, // "Register"
            contractArguments: [creds.userID, creds.publicKey, creds.role], // 对应 Go 合约参数顺序
            invokerIdentity: this._pickInvoker(),
            readOnly: false,
            timeout: 60
        };

        const t0 = Number(process.hrtime.bigint()) / 1e6;
        let ok = 0;
        try {
            const ret = await this.sutAdapter.sendRequests(req);
            ok = isTxSuccessful(ret) ? 1 : 0;
        } catch (e) {
            // console.error(e); // 可选：调试时打开
            ok = 0;
        }
        const t1 = Number(process.hrtime.bigint()) / 1e6;

        if (this.outStream) {
            this.outStream.write(
                `${this.label},UserRegister,${ok},${t0.toFixed(3)},${t1.toFixed(3)}\n`
            );
        }
    }
}

function createWorkloadModule() {
    return new UserRegisterWorkload();
}

module.exports.createWorkloadModule = createWorkloadModule;