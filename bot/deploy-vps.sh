#!/bin/bash
# Arbor VPS Deploy Script
# Run: ssh root@87.99.155.128 'bash -s' < deploy-vps.sh

set -e

echo "=== Arbor VPS Setup ==="

# Install Node.js 23
echo "Installing Node.js..."
curl -fsSL https://deb.nodesource.com/setup_23.x | bash -
apt-get install -y nodejs
node --version

# Install pm2 globally
echo "Installing pm2..."
npm install -g pm2

# Navigate to bot directory
cd /root/arbor/bot || cd /home/*/arbor/bot || { echo "arbor/bot not found"; exit 1; }

# Install dependencies
echo "Installing dependencies..."
npm install

# Create logs directory
mkdir -p logs

# Start bots
echo "Starting bots..."
pm2 start ecosystem.config.cjs

# Set pm2 to auto-start on reboot
pm2 save
pm2 startup | tail -1 | bash

echo ""
echo "=== Setup Complete ==="
pm2 status
echo ""
echo "Commands:"
echo "  pm2 logs              # All logs"
echo "  pm2 logs arbor-ai     # AI bot logs"
echo "  pm2 logs arbor-arb    # Arb bot logs"
echo "  pm2 status            # Check status"
echo "  pm2 restart all       # Restart all"
echo "  pm2 stop all          # Stop all"
