#!/bin/bash
# Start EmailBot with Node 16 (OpenSSL 1.1.1 compatibility)

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 16

cd "$(dirname "$0")"
node server.js
