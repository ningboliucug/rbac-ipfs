// chaincode.go
package main

import (
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"log"
	"time"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

/* ---------- 合约与数据结构 ---------- */

type SmartContract struct {
	contractapi.Contract
}

type User struct {
	PK   string `json:"pk"`
	Role string `json:"role"`
}

type Resource struct {
	OwnerUID string    `json:"ownerUID"`
	CID      string    `json:"cid"`
	Created  time.Time `json:"created"`
}

type AccessLog struct {
	UID      string    `json:"uid"`
	Decision string    `json:"decision"` // "Permit" or "Deny"
	Time     time.Time `json:"time"`
}

const (
	roleSetKeyPrefix = "roleSet"
	// rolePermKeyPref 被废弃，改为使用 CompositeKey "policy"
	policyObjType = "policy"
)

/* ---------- 工具 ---------- */

func parsePublicKeyPEM(pubPEM string) (*rsa.PublicKey, error) {
	block, _ := pem.Decode([]byte(pubPEM))
	if block == nil || block.Type != "PUBLIC KEY" {
		return nil, fmt.Errorf("invalid PEM public key")
	}
	pub, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse public key failed: %v", err)
	}
	rsaPub, ok := pub.(*rsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("public key is not RSA")
	}
	return rsaPub, nil
}

func verifySignature(uid, cid, sigB64 string, pub *rsa.PublicKey) error {
	data := uid + cid
	sum := sha256.Sum256([]byte(data))
	sig, err := base64.StdEncoding.DecodeString(sigB64)
	if err != nil {
		return fmt.Errorf("decode signature failed: %v", err)
	}
	if err := rsa.VerifyPKCS1v15(pub, crypto.SHA256, sum[:], sig); err != nil {
		return fmt.Errorf("invalid signature: %v", err)
	}
	return nil
}

func verifySignature_for_caliper(uid, sigB64 string, pub *rsa.PublicKey) error {
	data := uid
	sum := sha256.Sum256([]byte(data))
	sig, err := base64.StdEncoding.DecodeString(sigB64)
	if err != nil {
		return fmt.Errorf("decode signature failed: %v", err)
	}
	if err := rsa.VerifyPKCS1v15(pub, crypto.SHA256, sum[:], sig); err != nil {
		return fmt.Errorf("invalid signature: %v", err)
	}
	return nil
}

/* ---------- 角色集合管理 (仅保留角色定义，不再存储大权限列表) ---------- */

func getRoleSet(ctx contractapi.TransactionContextInterface) ([]string, error) {
	b, err := ctx.GetStub().GetState(roleSetKeyPrefix)
	if err != nil {
		return nil, fmt.Errorf("get roleSet failed: %v", err)
	}
	if b == nil {
		return nil, nil
	}
	var roles []string
	if err := json.Unmarshal(b, &roles); err != nil {
		return nil, fmt.Errorf("unmarshal roleSet failed: %v", err)
	}
	return roles, nil
}

func putRoleSet(ctx contractapi.TransactionContextInterface, roles []string) error {
	b, err := json.Marshal(roles)
	if err != nil {
		return fmt.Errorf("marshal roleSet failed: %v", err)
	}
	return ctx.GetStub().PutState(roleSetKeyPrefix, b)
}

func ensureSystemRolesInitialized(ctx contractapi.TransactionContextInterface) error {
	roles, err := getRoleSet(ctx)
	if err != nil {
		return err
	}
	if roles != nil {
		return nil
	}
	// 初始化角色列表，但不再初始化空的 rolePerms，因为我们改用组合键了
	defaultRoles := []string{"Creator", "Contributor", "Public"}
	if err := putRoleSet(ctx, defaultRoles); err != nil {
		return err
	}
	return nil
}

/* ---------- 新增：基于组合键的权限管理工具 ---------- */

// putPolicyEntry 使用组合键写入权限
// Key 结构: policy + role + cid + operation
// 优势: 不同的 (role, cid) 组合会生成完全不同的 Key，互不冲突
func putPolicyEntry(ctx contractapi.TransactionContextInterface, role, cid, operation string) error {
	// 创建组合键: indexName="policy", attributes=[role, cid, operation]
	compositeKey, err := ctx.GetStub().CreateCompositeKey(policyObjType, []string{role, cid, operation})
	if err != nil {
		return fmt.Errorf("create composite key failed: %v", err)
	}

	// 写入空值或 "1" 即可，Key 的存在即代表有权限
	// 这是一个 Blind Write (盲写)，不需要先 Read，彻底消除 MVCC 读写冲突
	return ctx.GetStub().PutState(compositeKey, []byte{0x01})
}

// hasPolicyEntry 检查权限
func hasPolicyEntry(ctx contractapi.TransactionContextInterface, role, cid, operation string) (bool, error) {
	compositeKey, err := ctx.GetStub().CreateCompositeKey(policyObjType, []string{role, cid, operation})
	if err != nil {
		return false, fmt.Errorf("create composite key failed: %v", err)
	}

	val, err := ctx.GetStub().GetState(compositeKey)
	if err != nil {
		return false, err
	}
	return val != nil, nil
}

/* ---------- 用户注册与查询 ---------- */

func (s *SmartContract) Register(ctx contractapi.TransactionContextInterface, userID, publicKeyPEM, role string) error {
	if err := ensureSystemRolesInitialized(ctx); err != nil {
		return fmt.Errorf("ensure roles failed: %v", err)
	}

	existing, err := ctx.GetStub().GetState(userID)
	if err != nil {
		return fmt.Errorf("get state for userID %s failed: %v", userID, err)
	}
	if existing != nil {
		return fmt.Errorf("userID %s already exists", userID)
	}
	if _, err := parsePublicKeyPEM(publicKeyPEM); err != nil {
		return fmt.Errorf("invalid public key: %v", err)
	}
	u := User{PK: publicKeyPEM, Role: role}
	b, err := json.Marshal(u)
	if err != nil {
		return fmt.Errorf("marshal user failed: %v", err)
	}
	return ctx.GetStub().PutState(userID, b)
}

func (s *SmartContract) QueryUserID(ctx contractapi.TransactionContextInterface, userID string) (*User, error) {
	val, err := ctx.GetStub().GetState(userID)
	if err != nil {
		return nil, fmt.Errorf("get state for userID %s failed: %v", userID, err)
	}
	if val == nil {
		return nil, fmt.Errorf("userID %s does not exist", userID)
	}
	var u User
	if err := json.Unmarshal(val, &u); err != nil {
		return nil, fmt.Errorf("unmarshal user failed: %v", err)
	}
	return &u, nil
}

/* ---------- AddResource ---------- */

func (s *SmartContract) AddResource(
	ctx contractapi.TransactionContextInterface,
	signatureB64 string,
	userID string,
	cid string,
) error {
	totalStart := time.Now()

	exist, err := ctx.GetStub().GetState(cid)
	if err != nil {
		return fmt.Errorf("get state for cid %s failed: %v", cid, err)
	}
	if exist != nil {
		return fmt.Errorf("resource with cid %s already exists", cid)
	}

	u, err := s.QueryUserID(ctx, userID)
	if err != nil {
		return err
	}
	pub, err := parsePublicKeyPEM(u.PK)
	if err != nil {
		return fmt.Errorf("parse pubkey failed: %v", err)
	}
	if err := verifySignature_for_caliper(userID, signatureB64, pub); err != nil {
		return err
	}

	res := Resource{OwnerUID: userID, CID: cid, Created: time.Now().UTC()}
	b, err := json.Marshal(res)
	if err != nil {
		return fmt.Errorf("marshal resource failed: %v", err)
	}
	if err := ctx.GetStub().PutState(cid, b); err != nil {
		return fmt.Errorf("put state for cid failed: %v", err)
	}

	elapsedMs := float64(time.Since(totalStart).Microseconds()) / 1000.0
	log.Printf("[AddResource] cid=%s owner=%s elapsed=%.3f ms", cid, userID, elapsedMs)
	return nil
}

/* ---------- 重构后的 AddPerm (解决 MVCC 冲突) ---------- */

// AddPerm(signatureB64, userID, cid, operation, rolesJSON)
func (s *SmartContract) AddPerm(
	ctx contractapi.TransactionContextInterface,
	signatureB64 string,
	userID string,
	cid string,
	operation string,
	rolesJSON string,
) error {
	totalStart := time.Now()

	// (1) 验证属主
	b, err := ctx.GetStub().GetState(cid)
	if err != nil {
		return fmt.Errorf("get cid failed: %v", err)
	}
	if b == nil {
		return fmt.Errorf("cid %s not found", cid)
	}
	var res Resource
	if err := json.Unmarshal(b, &res); err != nil {
		return fmt.Errorf("unmarshal resource failed: %v", err)
	}
	if res.OwnerUID != userID {
		return fmt.Errorf("permission denied: user %s is not owner of cid %s", userID, cid)
	}

	// (2) 验签
	u, err := s.QueryUserID(ctx, userID)
	if err != nil {
		return err
	}
	pub, err := parsePublicKeyPEM(u.PK)
	if err != nil {
		return fmt.Errorf("parse pubkey failed: %v", err)
	}
	if err := verifySignature(userID, cid, signatureB64, pub); err != nil {
		return err
	}

	// (3) 赋权 - 核心修改部分
	var targetRoles []string
	if err := json.Unmarshal([]byte(rolesJSON), &targetRoles); err != nil {
		return fmt.Errorf("parse rolesJSON failed: %v", err)
	}

	sysRoles, err := getRoleSet(ctx)
	if err != nil {
		return err
	}
	// 快速构建 Set 做检查
	roleMap := make(map[string]bool)
	for _, r := range sysRoles {
		roleMap[r] = true
	}

	updatedCount := 0
	for _, role := range targetRoles {
		if !roleMap[role] {
			return fmt.Errorf("role %q not in system roleSet", role)
		}

		// 使用组合键直接写入！
		// 这一步不需要读取旧数据，直接覆盖写入，效率极高且无冲突
		if err := putPolicyEntry(ctx, role, cid, operation); err != nil {
			return err
		}
		updatedCount++
	}

	elapsedMs := float64(time.Since(totalStart).Microseconds()) / 1000.0
	log.Printf("[AddPerm] cid=%s owner=%s roles=%d elapsed=%.3f ms", cid, userID, updatedCount, elapsedMs)
	return nil
}

/* ---------- 重构后的 CheckPerm (适配组合键) ---------- */

func (s *SmartContract) CheckPerm(ctx contractapi.TransactionContextInterface, signatureB64, operation, userID, cid string) (string, error) {
	totalStart := time.Now()

	// 1. 获取用户
	u, err := s.QueryUserID(ctx, userID)
	if err != nil {
		return "", err
	}
	role := u.Role

	// 2. 验签
	pub, err := parsePublicKeyPEM(u.PK)
	if err != nil {
		return "", fmt.Errorf("parse pubkey failed: %v", err)
	}
	if err := verifySignature(userID, cid, signatureB64, pub); err != nil {
		_ = logGen(ctx, cid, userID, "Deny")
		return "", fmt.Errorf("signature verify failed: %v", err)
	}

	// 3. 检查权限 - 核心修改部分
	// 不再读取大数组，而是直接检查组合键是否存在
	allowed, err := hasPolicyEntry(ctx, role, cid, operation)
	if err != nil {
		_ = logGen(ctx, cid, userID, "Deny")
		return "", err
	}

	decision := "Deny"
	if allowed {
		decision = "Permit"
	}

	// 4. 写日志 (保持你之前的无冲突写法)
	if err := logGen(ctx, cid, userID, decision); err != nil {
		return "", fmt.Errorf("logGen failed: %v", err)
	}

	elapsedMs := float64(time.Since(totalStart).Microseconds()) / 1000.0
	log.Printf("[CheckPerm] uid=%s cid=%s decision=%s elapsed=%.3f ms", userID, cid, decision, elapsedMs)
	return decision, nil
}

/* ---------- 辅助查询功能 ---------- */

func (s *SmartContract) QueryCid(ctx contractapi.TransactionContextInterface, cid string) (string, error) {
	start := time.Now()
	b, err := ctx.GetStub().GetState(cid)
	if err != nil {
		return "", fmt.Errorf("get cid failed: %v", err)
	}
	if b == nil {
		return "", fmt.Errorf("cid %s not found", cid)
	}
	var res Resource
	if err := json.Unmarshal(b, &res); err != nil {
		return "", fmt.Errorf("unmarshal resource failed: %v", err)
	}
	elapsedMs := float64(time.Since(start).Microseconds()) / 1000.0
	log.Printf("[QueryCid] cid=%s elapsed=%.3f ms", cid, elapsedMs)
	return res.OwnerUID, nil
}

func (s *SmartContract) TraceCid(ctx contractapi.TransactionContextInterface, cid string) ([]AccessLog, error) {
	start := time.Now()
	startKey := cid + "_log_"
	endKey := cid + "_log_" + "\uffff"

	resultsIterator, err := ctx.GetStub().GetStateByRange(startKey, endKey)
	if err != nil {
		return nil, fmt.Errorf("get logs by range failed: %v", err)
	}
	defer resultsIterator.Close()

	var logs []AccessLog
	for resultsIterator.HasNext() {
		queryResponse, err := resultsIterator.Next()
		if err != nil {
			return nil, err
		}
		var entry AccessLog
		if err := json.Unmarshal(queryResponse.Value, &entry); err != nil {
			continue
		}
		logs = append(logs, entry)
	}
	elapsedMs := float64(time.Since(start).Microseconds()) / 1000.0
	log.Printf("[TraceCid] cid=%s logs=%d elapsed=%.3f ms", cid, len(logs), elapsedMs)
	return logs, nil
}

// 保持你之前的 LogGen 逻辑，这对并发非常友好
func logGen(ctx contractapi.TransactionContextInterface, cid, uid, decision string) error {
	txID := ctx.GetStub().GetTxID()
	key := cid + "_log_" + txID
	now := time.Now().UTC()
	logEntry := AccessLog{
		UID:      uid,
		Decision: decision,
		Time:     now,
	}
	nb, err := json.Marshal(logEntry)
	if err != nil {
		return fmt.Errorf("marshal log failed: %v", err)
	}
	return ctx.GetStub().PutState(key, nb)
}

func main() {
	cc, err := contractapi.NewChaincode(new(SmartContract))
	if err != nil {
		fmt.Printf("Error creating chaincode: %s", err.Error())
		return
	}
	if err := cc.Start(); err != nil {
		fmt.Printf("Error starting chaincode: %s", err.Error())
	}
}
