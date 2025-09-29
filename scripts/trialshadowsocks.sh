#!/bin/bash

# === Konfigurasi Awal ===
user="trial$(openssl rand -hex 2 | head -c 4)"
uuid=$(cat /proc/sys/kernel/random/uuid)
domain=$(cat /etc/xray/domain 2>/dev/null || hostname -f)
ns_domain=$(cat /etc/xray/dns 2>/dev/null || echo "NS domain not set")
city=$(cat /etc/xray/city 2>/dev/null || echo "Unknown")
pubkey=$(cat /etc/slowdns/server.pub 2>/dev/null || echo "Not Available")
ip=$(curl -s ipv4.icanhazip.com)
duration=60 # minutes
exp=$(date -d "+$duration minutes" +"%Y-%m-%d %H:%M:%S")
method="aes-256-gcm"
password="$uuid"

# === Lokasi config
config_file="/etc/xray/shadowsocks/config.json"

# === Buat config dasar jika belum ada
mkdir -p "$(dirname "$config_file")"
if [ ! -f "$config_file" ]; then
  echo '{"clients":[]}' > "$config_file"
fi

# === Tambahkan user baru pakai jq
tmp=$(mktemp)
jq '.clients += [{"password":"'"$password"'","method":"'"$method"'","email":"'"$user"'"}]' "$config_file" > "$tmp" && mv "$tmp" "$config_file"

# === Buat link Shadowsocks base64
ss_base64=$(echo -n "${method}:${password}" | base64 -w 0)
ss_link_ws="ss://${ss_base64}@${domain}:443?plugin=xray-plugin;mux=0;path=/shadowsocks;host=${domain};tls;network=ws#${user}-WS"
ss_link_grpc="ss://${ss_base64}@${domain}:443?plugin=xray-plugin;mux=0;serviceName=ss-grpc;host=${domain};tls#${user}-gRPC"

# === Auto hapus user setelah expired
tmux new-session -d -s "trial_shadowsocks_$user" "sleep $((duration * 60)); jq 'del(.clients[] | select(.email == \"$user\"))' $config_file > $tmp && mv $tmp $config_file; systemctl restart shadowsocks@config"

# === Restart service
systemctl restart shadowsocks@config

# === Output JSON ke Telegram Bot
echo "{
  \"status\": \"success\",
  \"username\": \"$user\",
  \"uuid\": \"$uuid\",
  \"password\": \"$password\",
  \"ip\": \"$ip\",
  \"domain\": \"$domain\",
  \"ns_domain\": \"$ns_domain\",
  \"city\": \"$city\",
  \"public_key\": \"$pubkey\",
  \"expiration\": \"$exp\",
  \"protocol\": \"shadowsocks\",
  \"method\": \"$method\",
  \"link_ws\": \"$ss_link_ws\",
  \"link_grpc\": \"$ss_link_grpc\",
  \"port_tls\": \"443\",
  \"path\": \"/shadowsocks\",
  \"service_name\": \"ss-grpc\"
}"