#!/bin/bash
# 磁盘空间监控与自动清理脚本
# 当可用空间 < 1G 时触发紧急清理
# 每1小时检查一次

LOG_FILE="/opt/1panel/apps/openresty/openresty/www/wwwroot/map.ruiduobao.com/cleanup.log"
VECTORDATA_DIR="/opt/1panel/apps/openresty/openresty/www/wwwroot/map.ruiduobao.com/public/vectordata"
THRESHOLD_GB=1

# 获取可用空间（GB）
get_available_gb() {
    df -BG / | tail -1 | awk '{print $4}' | tr -d 'G'
}

AVAILABLE_GB=$(get_available_gb)

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

log "检查磁盘空间: 可用 ${AVAILABLE_GB}G, 阈值 ${THRESHOLD_GB}G"

# 只在低于阈值时执行清理
if [ "$AVAILABLE_GB" -lt "$THRESHOLD_GB" ]; then
    log "⚠️ 磁盘空间不足！开始紧急清理..."
    
    # 1. 清理系统日志
    journalctl --vacuum-size=50M >> "$LOG_FILE" 2>&1
    rm -f /var/log/auth.log.* /var/log/syslog.* >> "$LOG_FILE" 2>&1
    truncate -s 20M /var/log/postgresql/postgresql-14-main.log >> "$LOG_FILE" 2>&1
    find /var/log -name "*.log" -mtime +7 -delete >> "$LOG_FILE" 2>&1
    
    # 2. 清空 vectordata 目录所有内容
    if [ -d "$VECTORDATA_DIR" ]; then
        rm -rf "$VECTORDATA_DIR"/* >> "$LOG_FILE" 2>&1
        mkdir -p "$VECTORDATA_DIR"
        log "已清空 vectordata 目录"
    fi
    
    # 3. 清空 Redis 缓存
    redis-cli FLUSHDB >> "$LOG_FILE" 2>&1
    
    # 4. 清空 PM2 日志
    pm2 flush >> "$LOG_FILE" 2>&1
    
    NEW_GB=$(get_available_gb)
    log "清理完成！当前可用空间: ${NEW_GB}G"
else
    log "磁盘空间充足，无需清理"
fi