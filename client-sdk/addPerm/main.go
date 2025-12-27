package main

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings" // 新增：用于修剪文件内容
	"time"

	"github.com/hyperledger/fabric-gateway/pkg/client"
	"github.com/hyperledger/fabric-gateway/pkg/identity"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
)

/* -------------------- 辅助工具函数 -------------------- */

// 从文件中读取 UserID 哈希字符串
func readUserIDFromFile(filename string) (string, error) {
	content, err := os.ReadFile(filename)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(content)), nil
}

func loadRSAPrivateKeyFromPEMFile(filename string) (*rsa.PrivateKey, error) {
	b, err := os.ReadFile(filename)
	if err != nil {
		return nil, fmt.Errorf("读取用户私钥失败: %w", err)
	}
	block, _ := pem.Decode(b)
	if block == nil || block.Type != "RSA PRIVATE KEY" {
		return nil, fmt.Errorf("无效的 RSA 私钥 PEM")
	}
	priv, err := x509.ParsePKCS1PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("解析 RSA 私钥失败: %w", err)
	}
	return priv, nil
}

// ... [此处省略 newGrpcConnection, loadCertificate, newIdentity, newSign, handleError 函数，逻辑保持不变] ...

/* -------------------- 主流程 -------------------- */

func main() {
	start := time.Now()
	const (
		cid          = "QmdyzCHpa2vnn3zBvH1hfy4e5zdEuQGUvVfgtFfBnGFhKM"
		operation    = "download"
		mspID        = "Org1MSP"
		cryptoPath   = "../../../test-network/organizations/peerOrganizations/org1.example.com"
		certPath     = cryptoPath + "/users/User1@org1.example.com/msp/signcerts/User1@org1.example.com-cert.pem"
		keyPath      = cryptoPath + "/users/User1@org1.example.com/msp/keystore/"
		peerEndpoint = "localhost:7051"
		chaincode    = "acmc"
		channel      = "mychannel"
	)

	// 角色权限定义
	R := []string{"Creator", "Contributor"}
	RJSON, _ := json.Marshal(R)

	// --- 修改部分：从文件中读取真正的 UserID (哈希串) ---
	uidPath := "../register/user_1_id.txt"
	uidStr, err := readUserIDFromFile(uidPath)
	if err != nil {
		log.Fatalf("无法从文件 %s 读取 UserID: %v", uidPath, err)
	}
	fmt.Printf("资源属主 (User1) 哈希 ID: %s\n", uidStr)

	// 加载属主私钥并对 uidStr + cid 签名
	priv, err := loadRSAPrivateKeyFromPEMFile("../register/user_1_private_key.pem")
	if err != nil {
		log.Fatalf("加载 user_1 私钥失败: %v", err)
	}

	// 这里拼接的是哈希后的 uidStr 和 cid
	dataToSign := uidStr + cid
	h := crypto.SHA256.New()
	h.Write([]byte(dataToSign))
	digest := h.Sum(nil)
	sig, err := rsa.SignPKCS1v15(rand.Reader, priv, crypto.SHA256, digest)
	if err != nil {
		log.Fatalf("签名失败: %v", err)
	}
	sigB64 := base64.StdEncoding.EncodeToString(sig)

	// 连接 Fabric
	clientConn := newGrpcConnection(peerEndpoint)
	defer clientConn.Close()
	id := newIdentity(certPath, mspID)
	sign := newSign(keyPath)
	gw, err := client.Connect(
		id,
		client.WithSign(sign),
		client.WithClientConnection(clientConn),
	)
	if err != nil {
		log.Fatalf("Gateway 连接失败: %v", err)
	}
	defer gw.Close()

	network := gw.GetNetwork(channel)
	contract := network.GetContract(chaincode)

	// 调用合约：AddPerm(signature, uid, cid, operation, rolesJSON)
	fmt.Println("正在提交 AddPerm 交易...")
	_, err = contract.SubmitTransaction(
		"AddPerm",
		sigB64,
		uidStr, // 传递哈希字符串
		cid,
		operation,
		string(RJSON),
	)
	if err != nil {
		handleError(err)
		log.Fatalf("AddPerm 失败: %v", err)
	}

	fmt.Printf("AddPerm 成功，耗时 %.3f ms\n", float64(time.Since(start).Milliseconds()))
}

// 补齐缺少的辅助函数
func newGrpcConnection(peerEndpoint string) *grpc.ClientConn {
	tlsConfig := &tls.Config{InsecureSkipVerify: true}
	conn, _ := grpc.Dial(peerEndpoint, grpc.WithTransportCredentials(credentials.NewTLS(tlsConfig)))
	return conn
}
func loadCertificate(filename string) (*x509.Certificate, error) {
	b, _ := os.ReadFile(filename)
	return identity.CertificateFromPEM(b)
}
func newIdentity(certPath, mspID string) *identity.X509Identity {
	cert, _ := loadCertificate(certPath)
	id, _ := identity.NewX509Identity(mspID, cert)
	return id
}
func newSign(keyPath string) identity.Sign {
	files, _ := os.ReadDir(keyPath)
	keyPEM, _ := os.ReadFile(filepath.Join(keyPath, files[0].Name()))
	privateKey, _ := identity.PrivateKeyFromPEM(keyPEM)
	sign, _ := identity.NewPrivateKeySign(privateKey)
	return sign
}
func handleError(err error) { fmt.Printf("错误: %v\n", err) }
