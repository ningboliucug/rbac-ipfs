package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256" // 新增：用于哈希计算
	"crypto/tls"
	"crypto/x509"
	"encoding/hex" // 新增：用于将哈希转为字符串
	"encoding/pem"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/hyperledger/fabric-gateway/pkg/client"
	"github.com/hyperledger/fabric-gateway/pkg/identity"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
)

/* -------------------- 结构定义 -------------------- */

type User struct {
	Label string // 用于区分文件名的标签，如 "1", "2", "3"
	Role  string
}

type UserOnChain struct {
	PK   string `json:"pk"`
	Role string `json:"role"`
}

/* -------------------- 密钥与哈希工具 -------------------- */

func GenerateRSAKeys(bits int) (*rsa.PrivateKey, *rsa.PublicKey, error) {
	priv, err := rsa.GenerateKey(rand.Reader, bits)
	if err != nil {
		return nil, nil, err
	}
	return priv, &priv.PublicKey, nil
}

// 获取公钥哈希作为 UserID
func GetPublicKeyHash(pubPEM string) string {
	hash := sha256.Sum256([]byte(pubPEM))
	return hex.EncodeToString(hash[:])
}

func SerializePublicKey(pub *rsa.PublicKey) (string, error) {
	asn1, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return "", err
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: asn1})
	return string(pemBytes), nil
}

func SerializePrivateKey(priv *rsa.PrivateKey) (string, error) {
	asn1 := x509.MarshalPKCS1PrivateKey(priv)
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: asn1})
	return string(pemBytes), nil
}

/* -------------------- Fabric 连接工具 (保持不变) -------------------- */
// ... [此处省略 newGrpcConnection, loadCertificate, newIdentity, newSign, handleError 函数，逻辑与原代码一致] ...

func main() {
	// 定义三个测试角色，Label 用于生成文件名
	users := []User{
		{Label: "1", Role: "Creator"},
		{Label: "2", Role: "Contributor"},
		{Label: "3", Role: "Public"},
	}

	const (
		mspID         = "Org1MSP"
		cryptoPath    = "../../../test-network/organizations/peerOrganizations/org1.example.com"
		certPath      = cryptoPath + "/users/User1@org1.example.com/msp/signcerts/User1@org1.example.com-cert.pem"
		keyPath       = cryptoPath + "/users/User1@org1.example.com/msp/keystore/"
		tlsCertPath   = cryptoPath + "/peers/peer0.org1.example.com/tls/ca.crt"
		peerEndpoint  = "localhost:7051"
		chaincodeName = "acmc"
		channelName   = "mychannel"
	)

	clientConn := newGrpcConnection(tlsCertPath, "", peerEndpoint)
	defer clientConn.Close()

	id := newIdentity(certPath, mspID)
	sign := newSign(keyPath)

	gw, err := client.Connect(
		id,
		client.WithSign(sign),
		client.WithClientConnection(clientConn),
	)
	if err != nil {
		panic(err)
	}
	defer gw.Close()

	network := gw.GetNetwork(channelName)
	contract := network.GetContract(chaincodeName)

	for _, u := range users {
		start := time.Now()

		// 1. 生成密钥对
		priv, pub, err := GenerateRSAKeys(2048)
		if err != nil {
			log.Printf("用户 %s 生成密钥失败: %v\n", u.Label, err)
			continue
		}

		// 2. 序列化公钥并计算哈希作为真正的 UserID
		pubPEM, _ := SerializePublicKey(pub)
		realUserID := GetPublicKeyHash(pubPEM) // 这里生成了哈希 ID

		// 3. 保存私钥 (文件名包含 Label 以便区分)
		privPEM, _ := SerializePrivateKey(priv)
		_ = os.WriteFile(fmt.Sprintf("user_%s_private_key.pem", u.Label), []byte(privPEM), 0600)

		// 4. 保存生成的 UserID 哈希到文件，方便后期调用查看
		_ = os.WriteFile(fmt.Sprintf("user_%s_id.txt", u.Label), []byte(realUserID), 0644)

		fmt.Printf("[本地记录] 用户 Label=%s 生成的哈希ID为: %s\n", u.Label, realUserID)

		// 5. 调用链码注册：使用生成的 realUserID (公钥哈希)
		_, err = contract.SubmitTransaction(
			"register",
			realUserID, // 传入哈希值
			pubPEM,
			u.Role,
		)
		if err != nil {
			log.Printf("用户 %s (ID:%s) 注册失败: %v\n", u.Label, realUserID, err)
			handleError(err)
			continue
		}

		fmt.Printf("用户 %s 注册成功，耗时 %d ms\n", u.Label, time.Since(start).Milliseconds())
	}
}

// 补齐缺少的辅助函数以确保代码可直接运行
func newGrpcConnection(tlsCertPath, gatewayPeer, peerEndpoint string) *grpc.ClientConn {
	tlsConfig := &tls.Config{InsecureSkipVerify: true}
	dialOpts := []grpc.DialOption{
		grpc.WithTransportCredentials(credentials.NewTLS(tlsConfig)),
	}
	conn, _ := grpc.Dial(peerEndpoint, dialOpts...)
	return conn
}

func loadCertificate(filename string) (*x509.Certificate, error) {
	pemBytes, _ := os.ReadFile(filename)
	return identity.CertificateFromPEM(pemBytes)
}

func newIdentity(certPath, mspID string) *identity.X509Identity {
	cert, _ := loadCertificate(certPath)
	id, _ := identity.NewX509Identity(mspID, cert)
	return id
}

func newSign(keyPath string) identity.Sign {
	files, _ := os.ReadDir(keyPath)
	privPEM, _ := os.ReadFile(filepath.Join(keyPath, files[0].Name()))
	privateKey, _ := identity.PrivateKeyFromPEM(privPEM)
	sign, _ := identity.NewPrivateKeySign(privateKey)
	return sign
}

func handleError(err error) {
	fmt.Printf("错误详情: %v\n", err)
}
