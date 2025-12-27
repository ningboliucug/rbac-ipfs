# RBAC-IPFS: A Blockchain-Based Traceable Access Control Scheme for IPFS

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Hyperledger Fabric](https://img.shields.io/badge/Hyperledger%20Fabric-v2.x-green)](https://www.hyperledger.org/use/fabric)
[![IPFS](https://img.shields.io/badge/IPFS-v0.14.0-blue)](https://ipfs.tech/)
[![Build Status](https://img.shields.io/badge/build-passing-brightgreen)]()

## 📖 Introduction

This repository contains the official reference implementation of **RBAC-IPFS**, a novel access control framework tailored for the InterPlanetary File System (IPFS).

Existing IPFS access control solutions often compromise the Merkle-DAG structure or incur linear on-chain overhead ($O(N)$) proportional to the file size. **RBAC-IPFS** resolves this conflict by introducing a **"authorize-once, verify-locally"** mechanism. It performs a single smart-contract authorization for the root CID and enforces local Merkle proof verification for all linked sub-blocks during the Bitswap transmission.

**Key Features:**
* **$O(1)$ On-chain Overhead**: Decouples blockchain consensus from sub-block verification.
* **Fine-grained Access Control**: Supports role-based policies down to the file level.
* **Traceability**: Logs all access grants and denials on the immutable ledger.
* **Compatibility**: Preserves the native IPFS Merkle-DAG structure and concurrency.

## 📂 Project Structure

The repository is organized into four main modules reflecting the system architecture:

```text
rbac-ipfs-implementation/
├── chaincode/                  # [Core] Hyperledger Fabric Smart Contract (Go)
│   └── main.go                 # Entry point for the RBAC chaincode
├── client-sdk/                 # [Client] Modular Go applications for system interaction
│   ├── addPerm/                # Module: Grant permissions
│   ├── addResource/            # Module: Register resources (CIDs)
│   ├── checkPerm/              # Module: Verify access rights
│   ├── queryCid/               # Module: Query resource metadata
│   ├── register/               # Module: User registration & Identity management
│   ├── traceCid/               # Module: Trace access history
│   └── scripts/                # Automation scripts (automation.sh)
├── evaluation/                 # [Experiment] Performance benchmarking framework
│   ├── caliper/                # Hyperledger Caliper configurations
│   │   ├── benchmarks/         # Test scenarios (*.yaml)
│   │   ├── network/            # Network connection profiles
│   │   └── workload/           # Workload logic scripts (*.js)
│   ├── results/                # Experimental data output
│   └── run_benchmark.sh        # Script to execute benchmarks
└── ipfs-mod/                   # [Protocol] IPFS/Bitswap protocol modifications
    └── patches/                # Source code patches
        ├── go-bitswap-v0.6.0/  # Patch for data exchange protocol
        └── go-ipfs-v0.14.0-dev/# Patch for IPFS daemon

## 🛠️ Prerequisites

* **Operating System**: Linux (Ubuntu 20.04 LTS recommended) or macOS
* **Hyperledger Fabric**: v2.4+
* **Docker & Docker Compose**: Latest stable version
* **Node.js**: v12+

## 🚀 Installation & Usage

### 1. Deploy Smart Contracts

```
./network.sh up createChannel -c mychannel
./network.sh deployCC -ccn rbac-ipfs -ccp ./path/to/chaincode -ccl go
```

### 2. Client Operations

```
cd client-sdk/scripts
chmod +x functional_test.sh
./functional_test.sh
```

### 3. Apply IPFS Protocol Patches

```
git clone https://github.com/ipfs/go-ipfs.git
cd go-ipfs
git checkout v0.14.0
git apply ../ipfs-mod/go-ipfs/0001-feat-For-zk-Guard.patch
make install
```

## 📊 Performance Evaluation

```
cd evaluation
npm install
./run_benchmark.sh systemMix
```

## 🔗 Citation

```bibtex
@article{Liu2024RBACIPFS,
  title={A Blockchain-Based Traceable Access Control Scheme for IPFS},
  author={Ningbo Liu and Shandi Lu and Faqian Guan and Wei Ren},
  journal={Future Generation Computer Systems},
  year={2024},
  publisher={Elsevier}
}
```

## 📝 License

Apache 2.0 License.
