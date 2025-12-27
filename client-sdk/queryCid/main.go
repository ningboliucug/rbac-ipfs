// query_cid.go
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
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

func newGrpcConnection(peerEndpoint string) *grpc.ClientConn {
	tlsConfig := &tls.Config{InsecureSkipVerify: true}
	conn, err := grpc.Dial(
		peerEndpoint,
		grpc.WithTransportCredentials(credentials.NewTLS(tlsConfig)),
		grpc.WithDefaultCallOptions(
			grpc.MaxCallSendMsgSize(32*1024*1024),
			grpc.MaxCallRecvMsgSize(32*1024*1024),
		),
	)
	if err != nil {
		log.Fatalf("无法创建 gRPC 连接: %v", err)
	}
	return conn
}

func loadCertificate(filename string) (*x509.Certificate, error) {
	pem, err := os.ReadFile(filename)
	if err != nil {
		return nil, err
	}
	return identity.CertificateFromPEM(pem)
}

func newIdentity(certPath, mspID string) *identity.X509Identity {
	cert, err := loadCertificate(certPath)
	if err != nil {
		panic(err)
	}
	id, err := identity.NewX509Identity(mspID, cert)
	if err != nil {
		panic(err)
	}
	return id
}

func newSign(keyPath string) identity.Sign {
	files, err := os.ReadDir(keyPath)
	if err != nil {
		panic(err)
	}
	if len(files) == 0 {
		panic("未找到私钥文件")
	}
	keyPEM, err := os.ReadFile(filepath.Join(keyPath, files[0].Name()))
	if err != nil {
		panic(err)
	}
	privateKey, err := identity.PrivateKeyFromPEM(keyPEM)
	if err != nil {
		panic(err)
	}
	sign, err := identity.NewPrivateKeySign(privateKey)
	if err != nil {
		panic(err)
	}
	return sign
}

func main() {
	start := time.Now()
	const (
		cid          = "QmdyzCHpa2vnn3zBvH1hfy4e5zdEuQGUvVfgtFfBnGFhKM"
		mspID        = "Org1MSP"
		cryptoPath   = "../../../test-network/organizations/peerOrganizations/org1.example.com"
		certPath     = cryptoPath + "/users/User1@org1.example.com/msp/signcerts/User1@org1.example.com-cert.pem"
		keyPath      = cryptoPath + "/users/User1@org1.example.com/msp/keystore/"
		peerEndpoint = "localhost:7051"
		chaincode    = "acmc"
		channel      = "mychannel"
	)

	clientConn := newGrpcConnection(peerEndpoint)
	defer clientConn.Close()

	id := newIdentity(certPath, mspID)
	sign := newSign(keyPath)

	gw, err := client.Connect(
		id,
		client.WithSign(sign),
		client.WithClientConnection(clientConn),
		client.WithEvaluateTimeout(5*time.Second),
	)
	if err != nil {
		log.Fatalf("Gateway 连接失败: %v", err)
	}
	defer gw.Close()

	network := gw.GetNetwork(channel)
	contract := network.GetContract(chaincode)

	ownerBytes, err := contract.EvaluateTransaction("QueryCid", cid)
	elapsedMs := float64(time.Since(start).Microseconds()) / 1000.0
	if err != nil {
		log.Fatalf("QueryCid 失败: %v", err)
	}

	fmt.Printf("QueryCid -> owner uid: %s\n", string(ownerBytes))
	fmt.Printf("Client-side latency: %.3f ms\n", elapsedMs)
	_ = context.TODO()
}
