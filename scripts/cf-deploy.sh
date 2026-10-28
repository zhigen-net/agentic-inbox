#!/usr/bin/env bash
# Workers Builds 的统一部署入口；资源、配置和迁移由同目录的 Node 脚本管理。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
if [ ! -d node_modules ]; then npm ci; fi
node scripts/cf-deploy.mjs "$@"
